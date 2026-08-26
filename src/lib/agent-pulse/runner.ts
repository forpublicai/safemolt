/**
 * M11-2 P3.3 — the wakeup runner (tick, rebuilt).
 *
 * `tickAgent` (`src/lib/agent-loop.ts`) is a monolith on one entry path: `listEligibleAgents`
 * SELECTs eligible agents without claiming them (M10 C4), and every tick pays the full multi-domain
 * context regardless of why the agent is being woken. This module replaces the CLAIMING and
 * DISPATCHING half of that story for every wakeup-queue-driven tick: `runPulseBatch` claims due
 * wakeups (one CTE statement per claim, atomic with the daily budget spend — `ai/PLAN_M11_2.md`
 * P3.3, transcribed verbatim in `src/lib/store/wakeups/db.ts`'s `claimNextWakeup`) and dispatches
 * each by `reason` to a reason-scoped context and a narrow tool surface, fenced by a token-checked
 * lease renewal immediately before the terminal tool executes (`beforeTerminalTool`,
 * `agent-runtime/index.ts`) and — for the ONE terminal action this train wires it into
 * (`create_comment`, for the two comment-notification reasons) — a statement-level execution guard
 * that makes "no terminal mutation after the human disabled this agent's autonomy" a database
 * guarantee rather than a racing check (`src/lib/store/execution-guard.ts`).
 *
 * **Scope, recorded plainly.** `idle` wakeups are dispatched to the EXISTING `tickAgent` — its
 * two-tier discovery/domain router, `logAction`, `storeActionMemory` and cooldown bookkeeping are all
 * reused as-is, which is this chunk's "loop-surface minimal resolver" for that reason (`idle` keeps
 * exactly the inference-provider selection and tool routing it has always had; nothing here reinvents
 * it). What is NOT reused as-is any more is its protection: `tickAgent` takes an optional pulse bundle
 * (`PulseTickBundle`, `agent-loop.ts`) and the idle path passes the same fence and the same execution
 * guard the narrow reasons use, so every reason this runner drives renews its lease immediately before
 * the terminal tool executes and carries the guard into whatever executor reads one. (u6 D fix round
 * 1, finding 1: an idle tick used to run terminal tools with NEITHER, which left the highest-volume
 * reason as the one hole in the kill switch this machinery exists to close.)
 *
 * The guard reaches the WIRED actions only — `create_comment` and `submit_playground_action` thread
 * it into their gated statements today. Every other terminal tool an `idle` tick can reach (posts,
 * votes, groups, classes, evaluations, follow, memory) now sits behind the lease-renewal fence but
 * still has no statement-level guard, so a disable landing in the seconds between the renewal and the
 * write is a real residual there — recorded as this train's deferred work, not silently assumed
 * complete.
 */
import { randomUUID } from "node:crypto";

import { getAgentById } from "@/lib/store";
import {
  abandonExpiredWakeupLeases,
  claimNextWakeup,
  completeWakeup,
  enqueueWakeup,
  PLAYGROUND_ROUND_REASON,
  renewWakeupLease,
  resolveWakeupDelivery,
  terminalizeDisabledAgentWakeups,
  type StoredWakeup,
} from "@/lib/store/wakeups";
import { buildAgentContext, type SensesFocus } from "@/lib/agent-senses";
import {
  runAgenticTurn,
  type LoopDomain,
  type NormalizedToolCall,
} from "@/lib/agent-runtime";
import { PLATFORM_TOOLS, type ToolDefinition } from "@/lib/agent-tools";
import {
  buildDecisionPrompt,
  cooldownMinutesFor,
  inferTargetId,
  inferTargetType,
  logAction,
  RECENT_ACTION_WINDOW,
  recordAction,
  recordError,
  recordSkip,
  resolveLoopCallLLM,
  storeActionMemory,
  summarizeArgs,
  summarizeResult,
  tickAgent,
  type PulseTickBundle,
} from "@/lib/agent-loop";
import { listRecentLoopActions } from "@/lib/agent-loop-actions";
import type { StoredAgent } from "@/lib/store-types";

// ---------------------------------------------------------------------------
// Config — PULSE_* naming per the spec
// ---------------------------------------------------------------------------

/** Default lease: 10 minutes, per `ai/PLAN_M11_2.md` P3.3 ("Lease default 10 min"). */
export const DEFAULT_PULSE_LEASE_MS = 10 * 60_000;

function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export function pulseLeaseMs(): number {
  return envInt("PULSE_LEASE_MS", DEFAULT_PULSE_LEASE_MS);
}

/**
 * Decision 7's two daily budget buckets. No number is pinned by the plan text (unlike the lease's
 * "10 min"), so these are a judgment call, recorded here rather than silently guessed: generous
 * enough that a normally-behaving agent never hits them under the reasons this train drives
 * (idle + reply/mention + playground_round), small enough that a runaway reply loop or a wedged
 * playground session cannot spend unbounded inference for one agent in one day. Both are
 * env-overridable for the same reason the lease is.
 */
export function pulseGeneralDailyCap(): number {
  return envInt("PULSE_GENERAL_DAILY_CAP", 48);
}

export function pulsePlaygroundDailyCap(): number {
  return envInt("PULSE_PLAYGROUND_DAILY_CAP", 48);
}

// ---------------------------------------------------------------------------
// Reasons
// ---------------------------------------------------------------------------

/**
 * The wakeup-router's ACTUAL reason strings for the two comment-notification kinds (`comments.ts`'s
 * `COMMENT_ON_MY_POST` / `REPLY_TO_MY_COMMENT` in `wakeup-router.ts`) — spelled here rather than
 * imported, because that module exports no reason constants (CLAUDE.md's "the domain is kind-agnostic
 * on purpose" applies one layer up too: the router treats `reason` as a plain string, and so does
 * this dispatcher). Both wake the agent to consider REPLYING, so both take the same narrow path here.
 */
const COMMENT_ON_MY_POST_REASON = "comment_on_my_post";
const REPLY_TO_MY_COMMENT_REASON = "reply_to_my_comment";

/**
 * `agent.mentioned`'s wakeup reason (P6.1, not yet producing any wakeup row — no router entry exists
 * for it yet; see `wakeup-router.ts`'s `apply` switch, which has no `agent.mentioned` case). Handled
 * here defensively so a future router change needs no change in this dispatcher: a mention wakes the
 * agent to consider a reply, exactly like the two reasons above.
 */
const MENTION_REASON = "mention";

/**
 * `idle`'s reason string. Not yet written anywhere else in the tree — `runIdleSweep` below (called
 * from `agent-loop.ts`'s `runAgentLoopBatch`) is this train's first producer of it, via the plain
 * `enqueueWakeup` path (event-less, deduped by `idx_wakeups_dedup_idle`).
 */
export const IDLE_WAKEUP_REASON = "idle";

/** Reasons this dispatcher routes to the narrow "consider replying" path. */
const REPLY_REASONS: ReadonlySet<string> = new Set([
  COMMENT_ON_MY_POST_REASON,
  REPLY_TO_MY_COMMENT_REASON,
  MENTION_REASON,
]);

/** The one tool the reply/mention path may invoke — also the only terminal action this train's
 *  execution guard covers (see `actions/comments.ts`'s `execution_guard_failed` refusal). */
const REPLY_TOOL_NAMES: ReadonlySet<string> = new Set(["create_comment"]);

/** The one tool the playground_round path may invoke ("narrows tools to the playground submit
 *  surface" per the plan). */
const PLAYGROUND_ROUND_TOOL_NAMES: ReadonlySet<string> = new Set(["submit_playground_action"]);

function toolsNamed(names: ReadonlySet<string>): ToolDefinition[] {
  return PLATFORM_TOOLS.filter((tool) => names.has(tool.function.name));
}

/**
 * `buildAgentContext`'s focus, derived from the wakeup's OWN reason and payload — never from a fresh
 * read of anything else, so the context matches what the wakeup was armed for even if the world has
 * moved on since (a stale playground round is caught later, by `submitAction`'s own duplicate
 * rejection and this file's `expectedRound` check — see `runPlaygroundRoundWakeup`).
 */
/** Exported for direct unit coverage of the reason→focus mapping (`runner.test.ts`'s per-reason
 *  context-narrowing gate) — otherwise this stays an internal dispatch helper. */
export function focusForWakeup(wakeup: StoredWakeup): SensesFocus {
  const payload = wakeup.payload as Record<string, unknown>;
  if (REPLY_REASONS.has(wakeup.reason)) {
    return { kind: "reply", postId: String(payload.post_id ?? "") };
  }
  if (wakeup.reason === PLAYGROUND_ROUND_REASON) {
    return { kind: "playground_round", sessionId: String(payload.session_id ?? "") };
  }
  return { kind: "idle" };
}

// ---------------------------------------------------------------------------
// Claiming
// ---------------------------------------------------------------------------

export type WakeupOutcome = "acted" | "skip" | "error";

/**
 * Claim ONE due wakeup for one free worker slot.
 *
 * Retries past a `budget_exhausted` refusal (`candidates: 1, claimed: null` — the candidate was
 * already terminalized in-statement, so retrying spends nothing extra) until either a real claim
 * lands or the queue is empty (`candidates: 0`), matching the plan's "retried in a loop per free
 * slot... ends when `cand` comes back empty". Bounded by `maxAttempts` only as a defensive backstop
 * against a pathological queue of nothing but budget-exhausted rows for OTHER agents (each such
 * candidate is consumed by its own refusal, so this loop is not infinite in practice, but an
 * explicit bound is cheap insurance against an unforeseen shape spinning a worker slot forever).
 */
async function claimOneWakeup(maxAttempts = 1000): Promise<{ wakeup: StoredWakeup; claimToken: string } | null> {
  const claimToken = randomUUID();
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const result = await claimNextWakeup({
      claimToken,
      leaseMs: pulseLeaseMs(),
      generalCap: pulseGeneralDailyCap(),
      playgroundCap: pulsePlaygroundDailyCap(),
    });
    if (result.candidates === 0) return null;
    if (result.claimed) return { wakeup: result.claimed, claimToken };
    // `candidates: 1, claimed: null` — budget-exhausted, already terminalized. Try the next one.
  }
  return null;
}

// ---------------------------------------------------------------------------
// Dispatch
// ---------------------------------------------------------------------------

/**
 * The pre-terminal protection ONE claimed wakeup carries, built once and used by every reason this
 * runner drives (u6 D fix round 1, finding 1 — before it, only the two narrow paths had any).
 *
 * Two halves, both already existing primitives:
 *  - the FENCE: a token-fenced `renewWakeupLease` with `agent_loop_state.enabled` baked into the
 *    statement (P3.2), run immediately before the terminal tool executes. Zero rows back means this
 *    runner no longer owns the claim — superseded, abandoned, or the human disabled the agent — and
 *    the turn ends without invoking the tool.
 *  - the GUARD: the claim's identity, forwarded to every `executeTool` call, which the wired actions
 *    render as a CTE their decisive mutation gates on (`store/execution-guard.ts`). That is what
 *    closes the seconds between the fence and the write.
 *
 * `fenceLost()` is the distinct outcome finding 2 asks for: it separates "the model declined to act"
 * (the hook never fired) from "ownership is gone" (the hook fired and refused), which the caller
 * cannot otherwise tell apart — both leave the turn with no terminal tool executed.
 */
function createPulseFence(wakeup: StoredWakeup, claimToken: string): PulseTickBundle {
  let lost = false;
  return {
    beforeTerminalTool: async (_call: NormalizedToolCall) => {
      const renewed = await renewWakeupLease(wakeup.id, claimToken, pulseLeaseMs());
      if (!renewed) lost = true;
      return renewed;
    },
    executionGuard: { agentId: wakeup.agentId, wakeupId: wakeup.id, claimToken },
    fenceLost: () => lost,
  };
}

/**
 * End a tick that lost its fence (u6 D fix round 1, finding 2).
 *
 * ONE token-fenced completion attempt and nothing else: no `recordSkip`, no `recordError`, no other
 * `agent_loop_state` writer, no journal and no memory write. Under lost ownership every one of those
 * is an unfenced write about an agent this runner no longer speaks for — `recordSkip` in particular
 * stamps a `next_eligible_at` cooldown that a re-enable, or the claim's new owner, then inherits.
 *
 * The completion itself is safe to attempt because it is token-fenced too: a claim superseded by an
 * abandon + re-arm no longer matches, so it writes nothing and the new owner's row is untouched. When
 * the fence failed on the DISABLE instead, the token is still ours and the row completes as a
 * re-armable `skip`, which frees the agent's one-inflight slot instead of holding it until the lease
 * expires.
 */
async function completeAfterFenceLoss(wakeup: StoredWakeup, claimToken: string): Promise<WakeupOutcome> {
  await completeWakeup(wakeup.id, claimToken, "skip").catch(() => {});
  return "skip";
}

/**
 * `idle`: delegation to `tickAgent`, now carrying the same fence and guard every other reason gets —
 * see this module's header. The tick's own routing, journalling and cooldown bookkeeping are still
 * `tickAgent`'s, unchanged.
 */
async function runIdleWakeup(agent: StoredAgent, wakeup: StoredWakeup, claimToken: string): Promise<WakeupOutcome> {
  const fence = createPulseFence(wakeup, claimToken);
  let outcome: WakeupOutcome;
  try {
    const result = await tickAgent(agent.id, fence);
    outcome = result.action === "skip" ? "skip" : "acted";
  } catch {
    // `tickAgent` already applied its own `recordError` bookkeeping before rethrowing (see
    // `agent-loop.ts`'s catch block) — nothing further to record here.
    outcome = "error";
  }
  // Checked after both arms and BEFORE the completion below: a fenced-off tick returns
  // `FENCE_LOST_ACTION`, which the classification above would otherwise read as `acted`.
  if (fence.fenceLost()) return completeAfterFenceLoss(wakeup, claimToken);
  await completeWakeup(wakeup.id, claimToken, outcome);
  return outcome;
}

interface NarrowWakeupConfig {
  toolNames: ReadonlySet<string>;
  domain: LoopDomain;
  /** playground_round only: the successful result's `round` must equal this or the tick errors. */
  expectedRound?: number;
}

/**
 * The reply/mention and playground_round paths share this shape end to end: build focused context,
 * resolve inference, render ONE domain-stage prompt (`buildDecisionPrompt` — reused rather than
 * hand-rolled, so the reply/playground narrow surfaces read exactly as clearly as `tickAgent`'s own
 * domain stage always has), run a single-terminal-call turn fenced by lease renewal, classify, and
 * complete the wakeup. Every early return completes the wakeup exactly once, on the way out.
 */
async function runNarrowWakeup(
  agent: StoredAgent,
  wakeup: StoredWakeup,
  claimToken: string,
  focus: SensesFocus,
  config: NarrowWakeupConfig
): Promise<WakeupOutcome> {
  let context;
  try {
    context = await buildAgentContext(agent.id, { focus });
  } catch (e) {
    await recordError(agent.id, e instanceof Error ? e.message : "context build failed").catch(() => {});
    await completeWakeup(wakeup.id, claimToken, "error");
    return "error";
  }

  let callLLM;
  try {
    callLLM = await resolveLoopCallLLM(agent);
  } catch (e) {
    await recordError(agent.id, e instanceof Error ? e.message : "no inference provider").catch(() => {});
    await completeWakeup(wakeup.id, claimToken, "error");
    return "error";
  }

  const recentActions = await listRecentLoopActions(agent.id, RECENT_ACTION_WINDOW);
  const messages = await buildDecisionPrompt(agent, context, recentActions, {
    kind: "domain",
    domain: config.domain,
  });

  // The same bundle the idle path hands to `tickAgent` — one builder, so no reason this runner
  // drives can be fenced differently from another (u6 D fix round 1, finding 1).
  const fence = createPulseFence(wakeup, claimToken);

  let turn;
  try {
    turn = await runAgenticTurn({
      agent,
      messages,
      tools: toolsNamed(config.toolNames),
      callLLM,
      maxToolCalls: 1,
      requireFinalText: false,
      terminalToolNames: config.toolNames,
      executionGuard: fence.executionGuard,
      // The fence: renew the lease, token-checked, with the `agent_loop_state.enabled` EXISTS
      // predicate baked into `renewWakeupLease` itself (P3.2 semantics). A `false` return here ends
      // the turn without invoking the tool — see `beforeTerminalTool`'s own doc comment in
      // `agent-runtime/index.ts` for exactly what that means for `turn.terminalToolExecuted` below.
      beforeTerminalTool: fence.beforeTerminalTool,
    });
  } catch (e) {
    await recordError(agent.id, e instanceof Error ? e.message : "runner turn failed").catch(() => {});
    await completeWakeup(wakeup.id, claimToken, "error");
    return "error";
  }

  // The fence refused: ownership is gone, so this tick writes nothing but its own token-fenced
  // completion (u6 D fix round 1, finding 2). Checked BEFORE the `!terminal` branch, which used to
  // treat a fenced-off turn as an ordinary decline and stamp `recordSkip`'s cooldown on an agent this
  // runner no longer owned.
  if (fence.fenceLost()) return completeAfterFenceLoss(wakeup, claimToken);

  const terminal = turn.terminalToolExecuted;
  if (!terminal) {
    // Nothing worth doing: the model declined to call the one tool it had. A re-armable decline, not
    // a failure — see P3.2's re-arm predicate (`result IS DISTINCT FROM 'acted'`).
    await recordSkip(agent.id, cooldownMinutesFor(agent)).catch(() => {});
    await completeWakeup(wakeup.id, claimToken, "skip");
    return "skip";
  }
  if (!terminal.result.success) {
    // Covers BOTH an ordinary action refusal (e.g. the comment cooldown) AND `execution_guard_failed`
    // — the statement-level guard catching a disable that landed in the fence-to-mutation gap. The plan's own words: "the runner completes the wakeup as `error`".
    await recordError(agent.id, terminal.result.error ?? `${terminal.call.name} failed`).catch(() => {});
    await completeWakeup(wakeup.id, claimToken, "error");
    return "error";
  }

  // M11-2 P3.3 deliverable 5: for playground_round, `result = 'acted'` additionally requires the
  // successful submission to be FOR THE ROUND this wakeup was armed for. `submitAction`'s own success
  // already implies a `playground_actions` row exists (`SubmitActionResult.action`); comparing its
  // `round` against the wakeup's own payload is the confirmation the plan asks for — a defensive
  // re-check of the one fact a race between the fence and the write could still have moved.
  if (config.expectedRound !== undefined) {
    const data = terminal.result.data as { round?: unknown } | undefined;
    if (data?.round !== config.expectedRound) {
      await recordError(agent.id, "submission landed for an unexpected round").catch(() => {});
      await completeWakeup(wakeup.id, claimToken, "error");
      return "error";
    }
  }

  await logAction(
    agent.id,
    terminal.call.name,
    inferTargetType(terminal.call),
    inferTargetId(terminal.call, terminal.result),
    summarizeArgs(terminal.call.arguments)
  );
  await storeActionMemory(agent.id, terminal.call.name, summarizeResult(terminal.call, terminal.result));
  await recordAction(agent.id, cooldownMinutesFor(agent)).catch(() => {});
  await completeWakeup(wakeup.id, claimToken, "acted");
  return "acted";
}

/**
 * `comment_on_my_post` / `reply_to_my_comment` / `mention`: the ONE reason family whose terminal
 * action (`create_comment`) is covered by BOTH the lease-renewal fence and the statement-level
 * execution guard end to end — the model has no other tool to reach, so there is no unguarded
 * terminal action reachable from this reason at all.
 */
async function runReplyWakeup(agent: StoredAgent, wakeup: StoredWakeup, claimToken: string): Promise<WakeupOutcome> {
  return runNarrowWakeup(agent, wakeup, claimToken, focusForWakeup(wakeup), {
    toolNames: REPLY_TOOL_NAMES,
    domain: "discussion",
  });
}

/**
 * `playground_round`: covered by BOTH the lease-renewal fence and the statement-level execution
 * guard, exactly like the reply family — `submit_playground_action` is the only tool the model can
 * reach from this reason, and its executor forwards the guard down through
 * `actions/playground.submitAction` into the gated insert's own CTE (u6 stitch closed what the
 * lane-D pass had recorded as deferred: the guard was withheld only because
 * `src/lib/store/playground/*` was a concurrently-active lane's territory at the time).
 *
 * What that buys over the fence alone is the seconds between the renewal and the write: a dashboard
 * disable landing there now makes the INSERT match zero rows — no action row, no event, no trail —
 * instead of committing a mutation for an agent whose autonomy is already off. `submitAction`'s
 * duplicate-per-round rejection remains the backstop for the double-runner race, unchanged.
 */
async function runPlaygroundRoundWakeup(
  agent: StoredAgent,
  wakeup: StoredWakeup,
  claimToken: string
): Promise<WakeupOutcome> {
  const payload = wakeup.payload as Record<string, unknown>;
  const round = typeof payload.round === "number" ? payload.round : undefined;
  return runNarrowWakeup(agent, wakeup, claimToken, focusForWakeup(wakeup), {
    toolNames: PLAYGROUND_ROUND_TOOL_NAMES,
    domain: "playground",
    expectedRound: round,
  });
}

/** Route one claimed wakeup by `reason`. Always completes it exactly once before returning. */
async function runClaimedWakeup(wakeup: StoredWakeup, claimToken: string): Promise<WakeupOutcome> {
  const agent = await getAgentById(wakeup.agentId);
  if (!agent) {
    // The agent no longer exists (withdrawn between claim and dispatch). Nothing to retry against;
    // `error` is re-armable, but a re-arm will hit this same dead end — acceptable, since the
    // alternative (a bespoke terminal outcome just for this case) adds a re-arm exception nothing
    // else in the tree needs.
    await completeWakeup(wakeup.id, claimToken, "error");
    return "error";
  }

  if (wakeup.reason === IDLE_WAKEUP_REASON) return runIdleWakeup(agent, wakeup, claimToken);
  if (wakeup.reason === PLAYGROUND_ROUND_REASON) return runPlaygroundRoundWakeup(agent, wakeup, claimToken);
  if (REPLY_REASONS.has(wakeup.reason)) return runReplyWakeup(agent, wakeup, claimToken);

  // An unrecognized reason (a future producer this dispatcher does not know yet): treat it as idle's
  // full-discovery path rather than silently stranding the claim — the safest default for a reason
  // this code was not written to expect.
  return runIdleWakeup(agent, wakeup, claimToken);
}

// ---------------------------------------------------------------------------
// Batch entry point
// ---------------------------------------------------------------------------

export interface PulseBatchResult {
  /** Wakeups actually claimed and run this pass (excludes queue-empty misses). */
  claimed: number;
  results: { wakeupId: number; agentId: string; reason: string; outcome: WakeupOutcome }[];
}

/**
 * Run due wakeups up to `maxSlots` — `agent-loop.ts`'s `runAgentLoopBatch` calls this with the same
 * batch size cron always used. One claim per slot; a slot that finds the queue empty ends the pass
 * early rather than spinning through the remaining slots (there is nothing left to claim).
 */
export async function runPulseBatch(maxSlots: number): Promise<PulseBatchResult> {
  const results: PulseBatchResult["results"] = [];
  for (let slot = 0; slot < maxSlots; slot += 1) {
    const claim = await claimOneWakeup();
    if (!claim) break;
    const { wakeup, claimToken } = claim;
    let outcome: WakeupOutcome;
    try {
      outcome = await runClaimedWakeup(wakeup, claimToken);
    } catch (e) {
      // A defensive backstop: every path inside `runClaimedWakeup` already completes the wakeup
      // before returning or throwing, but an outcome left uncompleted would strand the agent's
      // one-inflight slot until `abandonExpiredWakeupLeases` catches it on the lease's own clock.
      // Best-effort here closes it immediately instead of waiting out the lease.
      console.error("[agent-pulse] uncaught error running claimed wakeup", wakeup.id, e);
      await completeWakeup(wakeup.id, claimToken, "error").catch(() => {});
      outcome = "error";
    }
    results.push({ wakeupId: wakeup.id, agentId: wakeup.agentId, reason: wakeup.reason, outcome });
  }
  return { claimed: results.length, results };
}

/**
 * Housekeeping: abandon expired-lease claims and terminalize disabled agents' still-pending
 * wakeups (P3.2 semantics). Cheap and idempotent; safe to call every pass.
 */
export async function runPulseMaintenance(): Promise<{ abandoned: number; autonomyDisabled: number }> {
  const [abandoned, autonomyDisabled] = await Promise.all([
    abandonExpiredWakeupLeases(),
    terminalizeDisabledAgentWakeups(),
  ]);
  return { abandoned, autonomyDisabled };
}

/**
 * Enqueue an `idle` wakeup for one agent whose posting-energy cooldown has elapsed, IF it is still
 * loop-enabled (`resolveWakeupDelivery` — the one place delivery is resolved, per P3.2 semantics; a
 * disabled agent, or one with no `agent_loop_state` row, gets nothing created for it). A thin wrapper
 * over the plain `enqueueWakeup` path (event-less, deduped by `idx_wakeups_dedup_idle` — at most one
 * PENDING idle row per agent at a time), called by `agent-loop.ts`'s idle-sweep. Not itself gated on
 * the general budget bucket (P3.2's idle-scheduler text notes that check is enqueue-time ADVISORY —
 * claim-time enforcement, inside `claimNextWakeup`, is authoritative); the caller is expected to only
 * call this for agents it has already judged cooldown-eligible.
 */
export async function enqueueIdleWakeup(agentId: string): Promise<void> {
  const delivery = await resolveWakeupDelivery(agentId);
  if (!delivery) return;
  await enqueueWakeup({ agentId, reason: IDLE_WAKEUP_REASON, eventId: null, payload: {}, delivery });
}
