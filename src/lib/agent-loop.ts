/**
 * Autonomous agent loop v2: multi-domain tick with memory.
 *
 * Each cron invocation processes a batch of eligible agents. Per agent:
 *   1. Auto-generate identity if placeholder
 *   2. Recall recent memories
 *   3. Scan feed (with full comment threads), classes, playground, evaluations
 *   4. LLM decides from expanded action set
 *   5. Execute action
 *   6. Store action as memory
 *
 * Designed to run in a Vercel Cron function (~300s budget).
 */

import { hasDatabase, sql } from "@/lib/db";
import { agentLoopState } from "@/lib/store/_memory-state";
import { PLATFORM_TOOLS, type ToolCallResult, type ToolDefinition } from "@/lib/agent-tools";
import { makeHfRouterCallLLM, makeOpenAiCallLLM } from "@/lib/agent-runtime/adapters/openai-compatible";
import {
  loopToolsFrom,
  runAgenticTurn,
  LOOP_DISCOVERY_TOOLS,
  LOOP_TOOL_DOMAINS,
  LOOP_TERMINAL_TOOLS,
  type CallLLM,
  type LoopDomain,
  type NormalizedMessage,
  type NormalizedToolCall,
} from "@/lib/agent-runtime";
import {
  getAgentById,
  setAgentVetted,
  setAgentIdentityMd,
} from "@/lib/store";
import { listUserIdsLinkedToAgent } from "@/lib/human-users";
import { buildAgentChatSystemPrompt } from "@/lib/dashboard-agent-chat";
import {
  getUserInferenceSecrets,
  getUserInferenceTokenOverride,
  incrementSponsoredInferenceUsage,
} from "@/lib/human-users";
import { isSponsoredPublicAiAgent } from "@/lib/memory/sponsored-public-ai";
import { upsertVectorForAgent } from "@/lib/memory/memory-service";
import { isPlaceholderIdentity, generateRandomIdentity, parsePostingCadence, type PostingCadence } from "@/lib/agent-identity-generator";
import { ensureGeneralMembership } from "@/lib/actions/groups";
// M11-2 P4.1/P4.3: every sense this prompt renders comes from one library, so the loop and
// `GET /agents/me/context` are two projections of one context rather than two gathers.
import {
  buildAgentContext,
  type AgentContext,
  type GroupItem,
  type PlaygroundActiveItem,
  type PlaygroundItem,
  type PlaygroundPendingItem,
} from "@/lib/agent-senses";
import type { StoredAgent } from "@/lib/store-types";
// Type-only, and deliberately so: `store/execution-guard.ts` reaches `_memory-state` the moment it
// LOADS, and this module is imported by tests that mock `@/lib/db` with nothing but `{ sql }` (see
// the lazy-import note above). A type import is erased at compile time, so it adds no such edge.
import type { ExecutionGuard } from "@/lib/store/execution-guard";
import { buildAgentLoopActivityUpsertCte } from "@/lib/store/activity/events";
import { emitEventCtes, sqlColumn, sqlPayloadObject } from "@/lib/store/events/statement";
import { STORE_ASSIGNED_PAYLOAD_ID, type PreparedEvent } from "@/lib/events/kinds";
import { listRecentLoopActions, type RecentLoopAction } from "@/lib/agent-loop-actions";
// M11-2 P3.3: the wakeup runner `runAgentLoopBatch` degrades into. Imported LAZILY, inside
// `runAgentLoopBatch` itself, rather than at this file's top level — `agent-pulse/runner.ts` reaches
// `src/lib/store/wakeups` at ITS top level, and that module calls `hasDatabase()` the moment it
// loads (`pickStore` is eager, not a lazy dispatcher — `src/lib/store/pick-store.ts`). A static
// import here would make EVERY caller of `agent-loop.ts` — including tests that only need
// `buildDecisionPrompt` or `tickAgent` and mock `@/lib/db` with nothing but `{ sql }` — pull that
// chain in and crash on a missing `hasDatabase`. Deferring the import to the one function that
// actually needs the wakeup store keeps that cost scoped to callers of `runAgentLoopBatch`, which is
// the only thing in this file that touches wakeups at all.

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

/** Max agents to process per cron invocation. */
const BATCH_SIZE = parseInt(process.env.AGENT_LOOP_BATCH_SIZE || "2", 10);

/**
 * Min minutes between actions for one agent, by identity posting cadence.
 *
 * Env-tunable (M11-2 P3.4 / M10 C8): each tier reads its own `AGENT_LOOP_COOLDOWN_*_MINUTES`
 * variable at module load — the same convention `AGENT_LOOP_BATCH_SIZE` follows above — and falls
 * back to the long-standing default on an unset or invalid value.
 */
function cooldownTier(envName: string, fallback: number): number {
  const raw = Number(process.env[envName]);
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : fallback;
}
const COOLDOWN_MINUTES: Record<PostingCadence, number> = {
  frequent: cooldownTier("AGENT_LOOP_COOLDOWN_FREQUENT_MINUTES", 15),
  occasional: cooldownTier("AGENT_LOOP_COOLDOWN_OCCASIONAL_MINUTES", 60),
  reactive: cooldownTier("AGENT_LOOP_COOLDOWN_REACTIVE_MINUTES", 120),
};

/**
 * M11-2 P3.3: the one place that derives an agent's cooldown minutes from its identity, so the
 * runner's own reply/mention/playground_round bookkeeping (`agent-pulse/runner.ts`) applies the SAME
 * cooldown `tickAgent` always has, rather than a second copy of `COOLDOWN_MINUTES` + a second
 * `parsePostingCadence` call.
 */
export function cooldownMinutesFor(agent: StoredAgent): number {
  return COOLDOWN_MINUTES[parsePostingCadence(agent.identityMd)];
}

// The per-section windows (feed, news, comments, memories, inbox) now live beside the gatherers
// they bound, in `src/lib/agent-senses/constants.ts`.

/** Max own autonomous action snippets to show for anti-repetition guidance. */
export const RECENT_ACTION_WINDOW = 5;

/** ADR-0001: total tool calls allowed across the whole staged tick. */
const LOOP_MAX_TOOL_CALLS = parseInt(process.env.AGENT_LOOP_MAX_TOOL_CALLS || "4", 10);

/** ADR-0001: tool calls allowed in the discovery stage before a domain is chosen. */
const LOOP_DISCOVERY_MAX_TOOL_CALLS = 2;

/** ADR-0001 activity domains a discovery answer may route into. */
const LOOP_DOMAIN_NAMES: readonly LoopDomain[] = [
  "discussion",
  "groups",
  "classes",
  "evaluations",
  "playground",
  "profile",
  "memory",
  "schools",
];

/** Discovery vs. domain stage for the two-tier decision prompt. */
export type LoopPromptStage = { kind: "discovery" } | { kind: "domain"; domain: LoopDomain };

// ---------------------------------------------------------------------------
// DB helpers for agent_loop_state
// ---------------------------------------------------------------------------

// The single agent_loop_state reader lives in ./agent-loop/state (shared with
// /agents/me(/home) via readLoopStateSafely); re-exported for existing callers.
export { getLoopState } from "./agent-loop/state";
import { recordAgentLoopTick } from "./agent-loop/state";

/**
 * M11-2 P3.3: memory mode writes the same `agentLoopState` map `getLoopState` now reads
 * (`agent-loop/state.ts`), so an agent's loop can be enabled/disabled the same way in Jest / local
 * no-DB runs as in production — the fixture path the runner's own tests use to arm and disarm the
 * kill switch.
 */
export async function setLoopEnabled(agentId: string, enabled: boolean): Promise<void> {
  if (!hasDatabase() || !sql) {
    const existing = agentLoopState.get(agentId);
    agentLoopState.set(agentId, {
      agentId,
      enabled,
      lastSeenAt: existing?.lastSeenAt ?? null,
      lastActionAt: existing?.lastActionAt ?? null,
      nextEligibleAt: existing?.nextEligibleAt ?? null,
      lastError: existing?.lastError ?? null,
      actionsTaken: existing?.actionsTaken ?? 0,
      errors: existing?.errors ?? 0,
    });
    return;
  }
  await sql!`
    INSERT INTO agent_loop_state (agent_id, enabled)
    VALUES (${agentId}, ${enabled})
    ON CONFLICT (agent_id) DO UPDATE SET enabled = ${enabled}
  `;
}

/**
 * M11-2 P3.3: candidates for the IDLE SWEEP (`runAgentLoopBatch`'s idle-sweep half), not a batch of
 * agents to tick directly any more — `listEligibleAgents`'s old callers ticked each id in the
 * returned list; the sweep instead ENQUEUES an idle wakeup per id (`agent-pulse/runner.ts`'s
 * `enqueueIdleWakeup`) and lets `runPulseBatch`'s claim statement decide who actually runs. The query
 * itself is unchanged — same predicate, same `BATCH_SIZE` cap, same ordering — and gained a memory
 * branch so the sweep works in Jest / local no-DB runs too.
 */
async function listEligibleAgents(now: string): Promise<string[]> {
  if (!hasDatabase() || !sql) {
    const nowMs = Date.parse(now);
    return Array.from(agentLoopState.values())
      .filter((state) => state.enabled && (!state.nextEligibleAt || Date.parse(state.nextEligibleAt) <= nowMs))
      .sort((a, b) => {
        const at = a.nextEligibleAt ? Date.parse(a.nextEligibleAt) : 0;
        const bt = b.nextEligibleAt ? Date.parse(b.nextEligibleAt) : 0;
        return at - bt;
      })
      .slice(0, BATCH_SIZE)
      .map((state) => state.agentId);
  }
  const rows = await sql!`
    SELECT agent_id FROM agent_loop_state
    WHERE enabled = TRUE AND next_eligible_at <= ${now}::timestamptz
    ORDER BY next_eligible_at ASC
    LIMIT ${BATCH_SIZE}
  `;
  return (rows as { agent_id: string }[]).map((r) => r.agent_id);
}

/**
 * M11-2 P3.3: exported (was module-private) and given a memory branch, so `agent-pulse/runner.ts`
 * can apply the SAME cooldown bookkeeping `tickAgent` always has for its own reply/mention/
 * playground_round ticks — without it, idle-sweep would have no reason to skip an agent who just
 * acted a moment ago via an event-driven wakeup, and would hand the runner a fresh idle row for
 * every sweep cycle in between.
 */
export async function recordAction(agentId: string, cooldownMinutes: number): Promise<void> {
  const next = new Date(Date.now() + cooldownMinutes * 60_000).toISOString();
  if (!hasDatabase() || !sql) {
    const existing = agentLoopState.get(agentId);
    if (!existing) return;
    agentLoopState.set(agentId, {
      ...existing,
      actionsTaken: existing.actionsTaken + 1,
      lastActionAt: new Date().toISOString(),
      lastSeenAt: new Date().toISOString(),
      nextEligibleAt: next,
    });
    return;
  }
  await sql!`
    UPDATE agent_loop_state
    SET actions_taken = actions_taken + 1,
        last_action_at = NOW(),
        last_seen_at = NOW(),
        next_eligible_at = ${next}::timestamptz
    WHERE agent_id = ${agentId}
  `;
}

export async function recordSkip(agentId: string, cooldownMinutes: number): Promise<void> {
  const next = new Date(Date.now() + cooldownMinutes * 60_000).toISOString();
  if (!hasDatabase() || !sql) {
    const existing = agentLoopState.get(agentId);
    if (!existing) return;
    agentLoopState.set(agentId, { ...existing, lastSeenAt: new Date().toISOString(), nextEligibleAt: next });
    return;
  }
  await sql!`
    UPDATE agent_loop_state
    SET last_seen_at = NOW(),
        next_eligible_at = ${next}::timestamptz
    WHERE agent_id = ${agentId}
  `;
}

export async function recordError(agentId: string, message: string): Promise<void> {
  const next = new Date(Date.now() + 10 * 60_000).toISOString(); // 10 min backoff
  if (!hasDatabase() || !sql) {
    const existing = agentLoopState.get(agentId);
    if (!existing) return;
    agentLoopState.set(agentId, {
      ...existing,
      errors: existing.errors + 1,
      lastError: message,
      nextEligibleAt: next,
    });
    return;
  }
  await sql!`
    UPDATE agent_loop_state
    SET errors = errors + 1,
        last_error = ${message},
        next_eligible_at = ${next}::timestamptz
    WHERE agent_id = ${agentId}
  `;
}

// ---------------------------------------------------------------------------
// Action log (structured journal)
// ---------------------------------------------------------------------------

/**
 * M11-2 P3.3: exported (was module-private) so `agent-pulse/runner.ts` journals its own
 * reply/mention/playground_round terminal actions through the SAME structured journal `tickAgent`
 * always has, rather than a second copy. DB-only (`agent_loop_action_log` has no memory twin — see
 * `agent-loop-actions.ts`'s `listRecentLoopActions`, which answers `[]` with no DB); the surrounding
 * try/catch already makes a no-DB call a harmless no-op, exactly as it always has for `tickAgent`.
 */
export async function logAction(
  agentId: string,
  action: string,
  targetType?: string,
  targetId?: string,
  contentSnippet?: string
): Promise<void> {
  // **DB-only, and the event's memory parity is VACUOUS rather than missing.**
  // `agent_loop_action_log` has no memory twin (`agent-loop-actions.ts` answers `[]` with no
  // database), so with no DB there is no mutation — and therefore no event either. Decision 4's "no
  // `await` between the mutation and its event append" is satisfied by there being neither.
  // Previously this was reached by letting `sql!` throw into the catch below; the explicit guard says
  // the same thing without logging an error for an expected no-op.
  if (!hasDatabase()) return;

  // **Tier 1 (M11-2 P3.3, u6 stitch item 3): the journal INSERT, the event, and the transitional
  // activity projection are ONE statement.**
  //
  // The event's `log_id` is minted by this INSERT, so it can only be filled here (the
  // `STORE_ASSIGNED_PAYLOAD_ID` contract), and the projection stamps `source_event_id` from the event
  // arm — an id that exists nowhere outside this statement, which is exactly the u3b/u4prep2 rule
  // that forbids moving either writer back out. Before this change the projection was a SECOND
  // auto-committed statement, so a journal row could commit with no trail row at all; now the three
  // commit together or not at all.
  const events: PreparedEvent<"agent_loop.action">[] = [
    {
      kind: "agent_loop.action",
      // Actor and subject are the same agent — `agent.profile_updated`'s shape, and for its reason:
      // a journal row is not an addressable domain object, and `schoolId` is null because an agent
      // belongs to no school (stamping the tick's host would claim otherwise).
      actorAgentId: agentId,
      subjectType: "agent",
      subjectId: agentId,
      schoolId: null,
      payload: {
        log_id: STORE_ASSIGNED_PAYLOAD_ID,
        action,
        target_type: targetType ?? null,
        target_id: targetId ?? null,
      },
    },
  ];
  const params: unknown[] = [
    agentId,
    action,
    targetType ?? null,
    targetId ?? null,
    contentSnippet?.slice(0, 500) ?? null,
  ];
  const emitted = emitEventCtes(events, "inserted", {
    firstParamIndex: params.length + 1,
    // `rowSource` is required for the column reference: without it the event's SELECT has no FROM at
    // all and `inserted.id` would raise 42P01. One row in, one event out — `inserted` holds exactly
    // the one journal row this statement wrote, and the fragment stays gated on it, so a refused
    // insert emits nothing.
    overrides: [
      {
        rowSource: "inserted",
        payloadMergeSql: sqlPayloadObject({ log_id: sqlColumn("inserted.id", "text") }),
      },
    ],
  });
  const primary = emitted.names[0] ?? null;

  try {
    await sql!(
      `
      WITH inserted AS (
        INSERT INTO agent_loop_action_log (agent_id, action, target_type, target_id, content_snippet)
        VALUES ($1::text, $2::text, $3::text, $4::text, $5::text)
        RETURNING *
      ), ${emitted.ctes.join(", ")},
      -- The TRANSITIONAL inline writer, as a CTE of the emitting statement. Inside it the
      -- agent_loop_action_log TABLE cannot serve as the row source (a CTE reads the statement's
      -- snapshot, which predates the row being inserted beside it), so the projection reads
      -- 'inserted', and its source_event_id reads the event arm. While the kind is shadow the drain
      -- compares its own row against this one BY that stamp, so a projection that could not name the
      -- event would leave the soak nothing to join on.
      projected AS (
        ${buildAgentLoopActivityUpsertCte({ logCte: "inserted", sourceEventCte: primary })}
      )
      SELECT (SELECT id FROM inserted)::text AS id
    `,
      [...params, ...emitted.params]
    );
  } catch (error) {
    // **Swallowed, exactly as the journal INSERT alone always was** — and now that is the whole
    // effect: statement-atomicity means a failure leaves no journal row, no event and no trail row,
    // rather than the pre-stitch half-state of a journal row with no projection. It must stay
    // swallowed: `agent-pulse/runner.ts` calls this between the terminal action and
    // `completeWakeup`, so a throw here would strand a claimed wakeup until its lease was abandoned.
    console.error("[agent-loop] failed to log action", error);
  }
}

// ---------------------------------------------------------------------------
// Inference
// ---------------------------------------------------------------------------

export async function makeLoopCallLLM(agent: StoredAgent, userId?: string): Promise<CallLLM> {
  const sponsored = await isSponsoredPublicAiAgent(agent.id);
  if (sponsored && userId) {
    const override = await getUserInferenceTokenOverride(userId);
    if (override) {
      return makeHfRouterCallLLM({ apiKey: override, billToPublicAi: false });
    }
    const platform = process.env.HF_TOKEN?.trim();
    if (!platform) throw new Error("HF_TOKEN not configured");
    const { count, limit } = await incrementSponsoredInferenceUsage(userId);
    if (count > limit) throw new Error("Sponsored daily limit reached");
    return makeHfRouterCallLLM({ apiKey: platform, billToPublicAi: true });
  }

  if (userId) {
    const secrets = await getUserInferenceSecrets(userId);
    if (secrets?.hf_token_override) {
      return makeHfRouterCallLLM({ apiKey: secrets.hf_token_override, billToPublicAi: false });
    }
    if (secrets?.openai_token) {
      return makeOpenAiCallLLM(secrets.openai_token);
    }

    const platform = process.env.HF_TOKEN?.trim();
    if (!platform) throw new Error("No inference provider configured for agent owner or platform");
    const { count, limit } = await incrementSponsoredInferenceUsage(userId);
    if (count > limit) throw new Error("Sponsored daily limit reached");
    return makeHfRouterCallLLM({ apiKey: platform, billToPublicAi: true });
  }

  const platform = process.env.HF_TOKEN?.trim();
  if (platform) return makeHfRouterCallLLM({ apiKey: platform, billToPublicAi: true });

  throw new Error("No inference provider configured for unlinked agent");
}

/**
 * M11-2 P3.3: `makeLoopCallLLM` plus the owner lookup `tickAgent` always does first —
 * `agent-pulse/runner.ts`'s "loop-surface minimal resolver" for every reason it drives directly
 * (reply/mention/playground_round; `idle` still goes through `tickAgent`, which does this inline).
 * One function so the runner never re-derives `listUserIdsLinkedToAgent`'s result differently from
 * how `tickAgent` does.
 */
export async function resolveLoopCallLLM(agent: StoredAgent): Promise<CallLLM> {
  const userIds = await listUserIdsLinkedToAgent(agent.id);
  return makeLoopCallLLM(agent, userIds[0]);
}

// ---------------------------------------------------------------------------
// Loop-specific projections of the shared context
// ---------------------------------------------------------------------------
//
// Every sense the prompt renders is gathered by `src/lib/agent-senses` (M11-2 P4.1/P4.3). What
// stays here is the LOOP's own reading of two of those sections: which lobbies are worth naming,
// and which active session is a hard obligation this tick. Those two answers are prompt policy,
// not a sense, so they do not belong in the shared library.

/** Lobbies this agent has not joined, capped the way the prompt has always capped them. */
function pickPendingLobbies(
  items: PlaygroundItem[]
): { id: string; gameName: string; playerCount: number; minPlayers: number }[] {
  return items
    .filter((i): i is PlaygroundPendingItem => i.kind === "pending" && !i.joined)
    .slice(0, 2)
    .map((l) => ({
      id: l.id,
      gameName: l.gameName,
      playerCount: l.playerCount,
      minPlayers: l.minPlayers,
    }));
}

/** The first active session with a prompt this agent has not answered — the tick's obligation. */
function pickActiveSession(
  items: PlaygroundItem[]
): { id: string; gameName: string; needsAction: boolean; currentPrompt?: string } | null {
  const next = items.find(
    (i): i is PlaygroundActiveItem =>
      i.kind === "active" && !i.hasActedThisRound && Boolean(i.currentRoundPrompt)
  );
  return next
    ? {
        id: next.id,
        gameName: next.gameName,
        needsAction: true,
        currentPrompt: next.currentRoundPrompt ?? undefined,
      }
    : null;
}

/**
 * Admissions is rendered only when it is ACTIONABLE (M11-2 u5 fix round 1, finding B-1).
 *
 * The prompt projected ten of the context's eleven sections and dropped `admissions`, so an agent
 * with a pending admissions step could not see it. It renders now — but not unconditionally: an
 * admitted agent's `next_action` is the static `admitted` line, which would spend prompt tokens on
 * every tick of every admitted agent and name nothing the model can act on. So a not-yet-admitted
 * agent gets the whole surface, an admitted agent gets it only while a real step is outstanding,
 * and a degraded read gets no section at all — five empty fields would assert a standing the loop
 * never actually read.
 */
const ADMISSIONS_IDLE_NEXT_ACTION_CODES = new Set(["admitted", "none"]);

type AdmissionsData = NonNullable<AgentContext["admissions"]["data"]>;

function isActionableAdmissions(data: AdmissionsData | null): data is AdmissionsData {
  if (!data) return false;
  // Not admitted: every one of the five pinned fields still describes a step this agent can take.
  if (!data.is_admitted) return true;
  // Admitted: only a genuinely outstanding step earns the tokens.
  const code: string | undefined = data.next_action?.code;
  return code !== undefined && !ADMISSIONS_IDLE_NEXT_ACTION_CODES.has(code);
}

/**
 * The five pinned agent-UX fields, verbatim: `next_action`, `criteria_progress`,
 * `public_ai_eligibility`, `admission_source`, `state_source` (see `agents.md`). Nothing here
 * renames, reshapes or drops one of them.
 */
function buildAdmissionsSection(data: AdmissionsData | null): string {
  if (!isActionableAdmissions(data)) return "";

  const lines: string[] = [];
  const nextAction = data.next_action;
  if (nextAction) {
    const href = nextAction.href ? ` (href: ${nextAction.href})` : "";
    lines.push(`- next_action: ${nextAction.code} — ${nextAction.message}${href}`);
  }
  lines.push(`- admission_source: ${data.admission_source}`);
  lines.push(`- state_source: ${data.state_source}`);
  const eligibility = data.public_ai_eligibility;
  if (eligibility) {
    lines.push(`- public_ai_eligibility: ${eligibility.status} — ${eligibility.reason}`);
  }
  const criteria = data.criteria_progress ?? [];
  if (criteria.length > 0) {
    lines.push("- criteria_progress:");
    for (const criterion of criteria) {
      lines.push(`  - [${criterion.complete ? "x" : " "}] ${criterion.code}: ${criterion.label}`);
    }
  }

  return `## Admissions (your standing — act on next_action when nothing more urgent is open)\n${lines.join("\n")}\n\n`;
}

/** The prompt has only ever named groups the agent could join, with their member counts. */
function pickSuggestedGroups(
  items: GroupItem[]
): { id: string; name: string; displayName: string; memberCount: number }[] {
  return items
    .filter((g) => g.kind === "suggested")
    .map((g) => ({
      id: g.id,
      name: g.name,
      displayName: g.displayName,
      memberCount: g.memberCount ?? 0,
    }));
}

// ---------------------------------------------------------------------------
// LLM decision prompt
// ---------------------------------------------------------------------------

function formatRelativeTime(isoDate: string): string {
  const diffMs = Date.now() - new Date(isoDate).getTime();
  const minutes = Math.floor(diffMs / 60_000);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

/**
 * Renders one tick's prompt from the shared `AgentContext` (M11-2 P4.3).
 *
 * `recentActions` stays a separate parameter: the agent's own action journal is anti-repetition
 * guidance, not a sense. `stage` is routing state, likewise. Everything else is read off the
 * context, so this builder and `GET /agents/me/context` can never describe different worlds.
 */
export async function buildDecisionPrompt(
  agent: StoredAgent,
  context: AgentContext,
  recentActions: RecentLoopAction[],
  stage: LoopPromptStage = { kind: "discovery" }
): Promise<NormalizedMessage[]> {
  // The loop's reading of the context. Every render block below is unchanged from when these
  // arrived as thirteen parameters.
  const inbox = context.inbox.items;
  const feed = context.feed.items;
  const classes = context.classes.items;
  const playground = {
    pendingLobbies: pickPendingLobbies(context.playground.items),
    activeSession: pickActiveSession(context.playground.items),
  };
  const evals = { available: context.evaluations.items };
  const news = context.news.items;
  const recentMemories = context.memories.items;
  const groupOpportunities = pickSuggestedGroups(context.groups.items);
  const network = context.network.data;
  const openClasses = context.classes.openForEnrollment;

  const systemPrompt = [
    buildAgentChatSystemPrompt(agent),
    stage.kind === "discovery"
      ? "You are running autonomously from the SafeMolt agent loop in two stages: discover, then act. Look around with read-only tools, choose one activity domain, then take at most one meaningful action. If nothing is worth doing, do not act."
      : `You are running autonomously from the SafeMolt agent loop. You have entered the ${stage.domain} activity domain. Take at most one meaningful action with its tools, or none if nothing is worthwhile.`,
  ].join("\n\n");

  // --- Recent activity ---
  let activitySection = "";
  if (recentActions.length > 0) {
    const lines = recentActions.slice(0, RECENT_ACTION_WINDOW).map((a) => {
      const target = [
        a.targetType ? `target_type=${a.targetType}` : undefined,
        a.targetId ? `target_id=${a.targetId}` : undefined,
      ].filter(Boolean).join(", ");
      const targetSuffix = target ? ` (${target})` : "";
      return `- ${formatRelativeTime(a.createdAt)}: ${a.action}${targetSuffix}${a.contentSnippet ? ` — "${a.contentSnippet.slice(0, 80)}"` : ""}`;
    });
    activitySection = `## Your Recent Activity\n${lines.join("\n")}\n\n`;
  }

  // --- Memory context ---
  let memorySection = "";
  if (recentMemories.length > 0) {
    const lines = recentMemories.map((m) => `- ${m.text.slice(0, 120)}`);
    memorySection = `## Your Memories\n${lines.join("\n")}\n\n`;
  }

  // --- Inbox obligations ---
  let inboxSection = "";
  if (inbox.length > 0) {
    const lines = inbox.map((item, i) => {
      const hint = item.hint ? ` — ${item.hint}` : "";
      return `[${i + 1}] ${item.priority.toUpperCase()} ${item.type} (notification_id: ${item.id}, href: ${item.href}) from @${item.actorName} about "${item.targetLabel}" ${formatRelativeTime(item.createdAt)}${hint}`;
    });
    inboxSection = `## Inbox Obligations (handle before casual posting)\n${lines.join("\n")}\n\n`;
  }

  // --- Feed with threads ---
  let feedSection = "";
  if (feed.length > 0) {
    const postBlocks = feed.map((p, i) => {
      const header = `[${i + 1}] "${p.post.title}" (post_id: ${p.post.id}) by @${p.authorName} (${p.post.upvotes} upvotes, ${p.comments.length} comments)`;
      const content = p.post.content ? `    ${p.post.content.slice(0, 300)}` : "";

      let commentsBlock = "";
      if (p.comments.length > 0) {
        const commentLines = p.comments.map((c) => {
          const marker = c.isOwnComment ? " ← YOU ALREADY COMMENTED" : "";
          return `      @${c.authorName}: "${c.content.slice(0, 150)}"${marker}`;
        });
        commentsBlock = `\n    Comments:\n${commentLines.join("\n")}`;
      }

      return `${header}\n${content}${commentsBlock}`;
    });

    feedSection = `## Feed (${feed.length} recent posts)\n${postBlocks.join("\n\n")}\n\n`;
  }

  // --- Classes ---
  let classSection = "";
  if (classes.length > 0) {
    const classLines = classes.map((c) => {
      const parts = [`- ${c.className}`];
      if (c.activeSessions.length > 0) {
        parts.push(`  Active sessions: ${c.activeSessions.map((s) => `"${s.title}" (session_id: ${s.id})`).join(", ")}`);
      }
      if (c.pendingEvals.length > 0) {
        parts.push(`  Pending evaluations: ${c.pendingEvals.map((e) => `"${e.title}" (evaluation_id: ${e.id})`).join(", ")}`);
      }
      return parts.join("\n");
    });
    classSection = `## Classes You're Enrolled In\n${classLines.join("\n")}\n\n`;
  }

  // --- Playground ---
  let playgroundSection = "";
  if (playground.pendingLobbies.length > 0 || playground.activeSession) {
    const parts: string[] = [];
    if (playground.activeSession) {
      parts.push(`⚡ ACTIVE GAME: "${playground.activeSession.gameName}" (session_id: ${playground.activeSession.id})`);
      if (playground.activeSession.currentPrompt) {
        parts.push(`  Current prompt: ${playground.activeSession.currentPrompt.slice(0, 300)}`);
      }
      parts.push(`  You MUST submit an action for this game.`);
    }
    for (const l of playground.pendingLobbies) {
      parts.push(`- Lobby: "${l.gameName}" (${l.playerCount} joined, session_id: ${l.id})`);
    }
    playgroundSection = `## Playground\n${parts.join("\n")}\n\n`;
  }

  // --- Evaluations ---
  let evalSection = "";
  if (evals.available.length > 0) {
    const evalLines = evals.available.map((e) => `- ${e.name} (evaluation_id: ${e.id})`);
    evalSection = `## Available Evaluations (not yet passed)\n${evalLines.join("\n")}\n\n`;
  }

  // --- News headlines ---
  const feedByPostId = new Map(feed.map((item) => [item.post.id, item]));
  let newsSection = "";
  if (news.length > 0) {
    const newsLines = news.map((n, i) => {
      const parts = [`[${i + 1}] "${n.title}"`];
      if (n.source) parts.push(`— ${n.source}`);
      parts.push(`— ${n.canonicalUrl ?? n.url}`);
      parts.push(`(story_id: ${n.storyId ?? "unknown"})`);
      const head = parts.join(" ");
      const discussionLines = (n.existingDiscussions ?? []).map((discussion, index) => {
        const thread = feedByPostId.get(discussion.postId);
        const alreadyCommented = thread?.comments.some((comment) => comment.isOwnComment) ?? false;
        const ownCommentMarker = alreadyCommented ? " ← YOU ALREADY COMMENTED IN INCLUDED THREAD" : "";
        return `    Existing discussion ${index + 1}: "${discussion.title}" (post_id: ${discussion.postId}, ${discussion.commentCount} comments, ${discussion.upvotes} upvotes)${ownCommentMarker}`;
      });
      const discussionBlock = discussionLines.length > 0 ? `\n${discussionLines.join("\n")}` : "";
      const snippet = n.snippet ? `\n    ${n.snippet}` : "";
      return `${head}${snippet}${discussionBlock}`;
    });
    newsSection = `## News (background context — low priority; do not repost headlines as new posts)\n${newsLines.join("\n\n")}\n\n`;
  }

  const enrolledClassIds = new Set(classes.map((c) => c.classId));
  const unenrolledClasses = openClasses.filter((c) => !enrolledClassIds.has(c.id));
  const openClassSection = unenrolledClasses.length > 0
    ? `## Classes Open For Enrollment\n${unenrolledClasses.slice(0, 5).map((c) => `- ${c.name || c.id} (class_id: ${c.id})`).join("\n")}\n\n`
    : "";

  // Finding B-1: the eleventh section. Silent unless it is actionable — see the builder's note.
  const admissionsSection = buildAdmissionsSection(context.admissions.data);

  const groupSection = groupOpportunities.length > 0
    ? `## Groups You Could Join\n${groupOpportunities.map((g) => `- ${g.displayName} (group_name: ${g.name}, group_id: ${g.id}, ${g.memberCount} members)`).join("\n")}\n\n`
    : "";

  const networkSection = `## Your Network\n- followers: ${network.followerCount}\n- following: ${network.followingCount}\n\n`;

  const guidance = stage.kind === "discovery"
    ? buildDiscoveryGuidance()
    : buildDomainGuidance(stage.domain);

  const userMessage = `${activitySection}${memorySection}${inboxSection}${feedSection}${classSection}${openClassSection}${groupSection}${networkSection}${playgroundSection}${evalSection}${admissionsSection}${newsSection}${guidance}`;

  return [
    { role: "system", content: systemPrompt },
    { role: "user", content: userMessage },
  ];
}

/** Discovery-stage guidance: look around, then declare exactly one activity domain. */
function buildDiscoveryGuidance(): string {
  return `## How the autonomous loop works
You are in the DISCOVERY stage of a two-stage tick.
1. Use read-only discovery tools (e.g. list_feed, list_groups, list_classes, list_evaluations, list_playground_sessions, get_my_profile, recall_memory) to see what is available.
2. When you know which activity to act in, reply with exactly one line and nothing else: DOMAIN: <discussion|groups|classes|evaluations|playground|profile|memory|schools>. You will then receive that domain's action tools and take exactly one terminal action.
3. If nothing is worth doing this tick, reply with a short explanation and do NOT output a DOMAIN line.

SafeMolt is a full activity surface — classes, evaluations, playground games, groups, following, and discussion — not just posting and commenting.

Priorities:
- Handle obligations first: unread inbox replies, active playground turns, active class/evaluation turns.
- Otherwise start or deepen an activity: enroll in a class, register for an evaluation, join a playground lobby, join a relevant group, follow an agent, check a profile, or continue a session.
- Join a discussion only when you have a genuinely new point to add; create a post only for a concrete new idea.
- If your recent actions are all posts and comments, choose a different useful activity unless there is a hard obligation.
- News headlines are low-priority background context, not a default posting source. Do not rewrite RSS headlines as posts.
- Vary phrasing from Your Recent Activity; avoid repeated openers, templates, and catchphrases.`;
}

/** Domain-stage guidance: one terminal action inside the chosen domain ends the tick. */
function buildDomainGuidance(domain: LoopDomain): string {
  return `## Domain action stage: ${domain}
You are acting in the ${domain} domain and only have that domain's tools.
- Take at most ONE terminal (mutating) action; it ends this tick. Use the domain's read tools first only if you still need IDs.
- Use the exact IDs shown in the context above.
- Jump straight into the substantive action. Stay in character per your identity document. Keep comments concise (1-3 sentences). Don't repeat what others already said or threads you already saturated.
- If no action is worthwhile, respond with a short explanation and do not call a tool.`;
}

// ---------------------------------------------------------------------------
// Runtime action summaries
// ---------------------------------------------------------------------------

function toolResultData(result: ToolCallResult): Record<string, unknown> {
  return result.data && typeof result.data === "object" && !Array.isArray(result.data)
    ? result.data as Record<string, unknown>
    : {};
}

/** Loop-journal target classification comes from the tool definitions themselves. */
const TOOL_TARGET_TYPES = new Map(
  PLATFORM_TOOLS.filter((tool) => tool.targetType).map((tool) => [tool.function.name, tool.targetType!])
);

export function inferTargetType(call: NormalizedToolCall): string | undefined {
  return TOOL_TARGET_TYPES.get(call.name);
}

export function inferTargetId(call: NormalizedToolCall, result: ToolCallResult): string | undefined {
  const data = toolResultData(result);
  const value =
    data.post_id ??
    data.comment_id ??
    data.group_id ??
    data.agent_id ??
    data.registration_id ??
    data.session_id ??
    data.message_id ??
    call.arguments.post_id ??
    call.arguments.comment_id ??
    call.arguments.group_id ??
    call.arguments.group_name ??
    call.arguments.agent_id ??
    call.arguments.agent_name ??
    call.arguments.session_id ??
    call.arguments.class_id ??
    call.arguments.evaluation_id ??
    call.arguments.path;
  return value == null ? undefined : String(value);
}

export function summarizeArgs(args: Record<string, unknown>): string | undefined {
  const value =
    args.content ??
    args.title ??
    args.group_name ??
    args.agent_name ??
    args.session_id ??
    args.class_id ??
    args.evaluation_id ??
    args.path;
  return value == null ? undefined : String(value);
}

export function summarizeResult(call: NormalizedToolCall, result: ToolCallResult): string {
  if (!result.success) return `${call.name} failed: ${result.error ?? "unknown error"}`;
  const data = toolResultData(result);
  const id = inferTargetId(call, result);
  const note = data.title ?? data.class_name ?? data.registration_id ?? data.action_id ?? data.message_id;
  return [call.name, note ? String(note) : undefined, id ? `(target: ${id})` : undefined].filter(Boolean).join(" ");
}
// ---------------------------------------------------------------------------
// Store action as memory
// ---------------------------------------------------------------------------

/** M11-2 P3.3: exported (was module-private) for `agent-pulse/runner.ts` to reuse unchanged. */
export async function storeActionMemory(agentId: string, action: string, detail: string): Promise<void> {
  try {
    const memoryId = `loop_${agentId}_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
    const text = `[Agent Loop] ${action}: ${detail}`;
    await upsertVectorForAgent(agentId, memoryId, text, {
      kind: "agent_loop_action",
      action,
      filed_at: new Date().toISOString(),
    });
  } catch (e) {
    console.error("[agent-loop] memory store failed:", e);
  }
}

// ---------------------------------------------------------------------------
// Two-tier router tool selection (ADR-0001)
// ---------------------------------------------------------------------------

/** Read-only discovery slice: LOOP_DISCOVERY_TOOLS intersected with the platform surface. */
function loopDiscoveryTools(): ToolDefinition[] {
  const names = new Set(LOOP_DISCOVERY_TOOLS);
  return loopToolsFrom(PLATFORM_TOOLS).filter((tool) => names.has(tool.function.name));
}

/** Per-domain read/action slice: LOOP_TOOL_DOMAINS[domain] intersected with the platform surface. */
function loopDomainTools(domain: LoopDomain): ToolDefinition[] {
  const names = new Set(LOOP_TOOL_DOMAINS[domain]);
  return loopToolsFrom(PLATFORM_TOOLS).filter((tool) => names.has(tool.function.name));
}

/** Parse a discovery answer's `DOMAIN: <domain>` line into a routable domain, or null. */
function parseDiscoveryDomain(finalContent: string | null): LoopDomain | null {
  if (!finalContent) return null;
  const match = finalContent.match(/DOMAIN:\s*([a-z]+)/i);
  if (!match) return null;
  const candidate = match[1].toLowerCase() as LoopDomain;
  return LOOP_DOMAIN_NAMES.includes(candidate) ? candidate : null;
}

// ---------------------------------------------------------------------------
// Single agent tick
// ---------------------------------------------------------------------------

/**
 * M11-2 u6 D fix round 1, finding 1 — the runner's pre-terminal FENCE and its statement-level
 * EXECUTION GUARD, threaded into a legacy tick.
 *
 * `idle` is the one wakeup reason `agent-pulse/runner.ts` dispatches through this function instead of
 * through one of its own narrow paths, and until this bundle existed that made `idle` the ONE claimed
 * wakeup whose terminal tool ran with neither protection: a human disabling the agent's autonomy
 * mid-tick could still watch its post, vote, follow or comment land afterwards — exactly what
 * `ai/PLAN_M11_2.md` P3.2 forbids ("a wakeup queued or claimed before disablement must never execute
 * a terminal mutation after it"), on the highest-volume reason there is.
 *
 * The bundle is OPTIONAL and populated only by the runner. Every other caller passes nothing, and
 * each `pulse?.…` below then renders `undefined` — byte-identically what `runAgenticTurn` and
 * `executeTool` already received from this function before the parameter existed.
 *
 * `fenceLost()` is what makes fence loss a DISTINCT outcome rather than one more silent skip (finding
 * 2). The hook returns `false` for exactly one reason — the token-fenced lease renewal came back
 * empty, so the claim was superseded or the agent was disabled — and a tick that has lost its fence
 * must write nothing further, least of all the `agent_loop_state` cooldown `recordSkip` would stamp
 * under ownership it no longer holds.
 */
export interface PulseTickBundle {
  /** `runAgenticTurn`'s pre-execution seam: `false` ends the turn WITHOUT invoking the tool. */
  beforeTerminalTool: (call: NormalizedToolCall) => Promise<boolean>;
  /** Forwarded to every `executeTool` call this tick makes; read by the wired executors only. */
  executionGuard: ExecutionGuard;
  /** True once `beforeTerminalTool` has refused a call during this tick. */
  fenceLost: () => boolean;
}

/** `tickAgent`'s reported action when the pulse fence refused mid-tick (see `PulseTickBundle`). */
export const FENCE_LOST_ACTION = "fence_lost";

export async function tickAgent(
  agentId: string,
  pulse?: PulseTickBundle
): Promise<{ action: string; detail?: string }> {
  // M11-2 P0.4: journal one row per processed tick so the skip-tick inference share
  // (ai/validation/m11-baseline.md section 4) has an honest denominator. `inferenceConsumed` flips
  // true only right before a runAgenticTurn call is actually made; `terminalActionLanded` flips true
  // only once the terminal tool call has actually succeeded, so a throw in the bookkeeping AFTER
  // that point (logAction, storeActionMemory, recordAction) still journals a true terminal_action —
  // the mutation landed even though the tick as a whole errored. Every return and the catch below
  // journal exactly once, against whatever these hold at that point. Every journal call is `void`,
  // never `await`ed: recordAgentLoopTick never throws (it catches internally), but a slow or
  // never-settling DB call must not delay the tick's return, its rethrow, or batch accounting — this
  // is instrumentation, not something the tick's own outcome can depend on. Additive only — no other
  // line in this function changes.
  let inferenceConsumed = false;
  let terminalActionLanded = false;

  /**
   * u6 D fix, finding 2: the pulse fence refused, so ownership is gone — the claim was superseded, or
   * the human disabled this agent's autonomy mid-tick. End the tick writing NOTHING further: no
   * `recordSkip`, so the cooldown a new owner (or a later re-enable) inherits is never stamped by a
   * tick that no longer owns this agent. The P0.4 tick journal is still written, and deliberately: it
   * is instrumentation keyed to the TICK rather than to ownership, and the inference this tick really
   * did consume has to stay in the skip-share denominator (`agent-loop/state.ts`).
   */
  const fenceLostTick = (): { action: string; detail?: string } => {
    void recordAgentLoopTick({ agentId, outcome: "skipped", inferenceConsumed, terminalAction: false });
    return { action: FENCE_LOST_ACTION, detail: "pulse fence refused the terminal call" };
  };

  try {
    const agent = await getAgentById(agentId);
    if (!agent) throw new Error("Agent not found");

    // Resolve the human owner for inference billing
    const userIds = await listUserIdsLinkedToAgent(agentId);
    const userId = userIds[0];

    // --- Step 1: Auto-generate identity if placeholder ---
    if (isPlaceholderIdentity(agent.identityMd)) {
      const displayName = agent.displayName || agent.name;
      const newIdentity = generateRandomIdentity(agentId, displayName);
      await setAgentIdentityMd(agentId, newIdentity);
      // Also update the vetted identity to match
      await setAgentVetted(agentId, newIdentity);
      // Refresh agent object
      const refreshed = await getAgentById(agentId);
      if (refreshed) {
        agent.identityMd = refreshed.identityMd;
      }
      console.log(`[agent-loop] Auto-generated identity for ${agent.name}`);
    }

    // Posting cadence is the identity's typed "Posting energy" field.
    const cooldown = COOLDOWN_MINUTES[parsePostingCadence(agent.identityMd)];

    // --- Step 2: Gather context in parallel ---
    const [context, recentActions] = await Promise.all([
      buildAgentContext(agentId),
      listRecentLoopActions(agentId, RECENT_ACTION_WINDOW),
    ]);

    // Derived once and reused by the skip check, the obligation router and the prompt, so the
    // three can never disagree about what this tick is looking at.
    const pendingLobbies = pickPendingLobbies(context.playground.items);
    const activeSession = pickActiveSession(context.playground.items);
    const suggestedGroups = pickSuggestedGroups(context.groups.items);

    // If nothing to do at all, skip
    if (
      context.feed.items.length === 0 &&
      context.classes.items.length === 0 &&
      !activeSession &&
      pendingLobbies.length === 0 &&
      context.evaluations.items.length === 0 &&
      suggestedGroups.length === 0 &&
      context.news.items.length === 0 &&
      context.inbox.items.length === 0
    ) {
      await recordSkip(agentId, cooldown);
      void recordAgentLoopTick({ agentId, outcome: "skipped", inferenceConsumed, terminalAction: false });
      return { action: "skip", detail: "Nothing to engage with" };
    }

    // --- Step 3: Two-tier router (ADR-0001): discovery stage, then one domain. ---
    // Through the ACTION, so the automatic membership emits `group.joined` like any other
    // (M11-2 P1.3): the loop is one of three runtime callers, and an eventless ensure left the
    // trail row it writes uncorrelatable in the soak.
    await ensureGeneralMembership({ agentId });
    const callLLM = await makeLoopCallLLM(agent, userId);

    let domain: LoopDomain;
    let domainMessages: NormalizedMessage[];
    let discoveryCallsUsed = 0;

    // Only active multi-turn playground sessions are hard obligations. Classes,
    // evaluations, and discussion replies are one-shot opportunities that should
    // stay visible during normal discovery rather than preempting exploration.
    const directDomain: LoopDomain | null = activeSession ? "playground" : null;
    if (directDomain) {
      // Hard obligation: skip discovery and route straight into the relevant domain with that domain's tools only.
      domain = directDomain;
      domainMessages = await buildDecisionPrompt(agent, context, recentActions, { kind: "domain", domain });
    } else {
      // Discovery stage: read-only tools, then a `DOMAIN: <domain>` declaration.
      const discoveryMessages = await buildDecisionPrompt(agent, context, recentActions, { kind: "discovery" });
      inferenceConsumed = true;
      const discoveryResult = await runAgenticTurn({
        agent,
        messages: discoveryMessages,
        tools: loopDiscoveryTools(),
        callLLM,
        maxToolCalls: LOOP_DISCOVERY_MAX_TOOL_CALLS,
        terminalToolNames: LOOP_TERMINAL_TOOLS,
        // u6 D fix, finding 1. `undefined` for every caller that passes no bundle — identical to
        // omitting both fields, which is what this call site did before.
        beforeTerminalTool: pulse?.beforeTerminalTool,
        executionGuard: pulse?.executionGuard,
      });
      // Today's discovery slice is read-only, so no call here is terminal and the hook cannot fire.
      // Checked anyway: the fence must hold for whatever the slice becomes, not for what it is.
      if (pulse?.fenceLost()) return fenceLostTick();
      discoveryCallsUsed = discoveryResult.toolCallsExecuted.length;

      const chosen = parseDiscoveryDomain(discoveryResult.finalContent);
      if (!chosen) {
        // No domain chosen and no terminal tool executed: nothing to do this tick.
        await recordSkip(agentId, cooldown);
        void recordAgentLoopTick({ agentId, outcome: "skipped", inferenceConsumed, terminalAction: false });
        return { action: "skip", detail: discoveryResult.finalContent ?? "Discovery chose no domain" };
      }
      domain = chosen;
      domainMessages = [
        ...discoveryResult.messages,
        {
          role: "user",
          content: `You have entered the ${domain} activity domain.\n\n${buildDomainGuidance(domain)}`,
        },
      ];
    }

    // Domain stage: that domain's tool slice, bounded by the tick-wide call budget.
    const remainingCalls = Math.max(1, LOOP_MAX_TOOL_CALLS - discoveryCallsUsed);
    inferenceConsumed = true;
    const domainResult = await runAgenticTurn({
      agent,
      messages: domainMessages,
      tools: loopDomainTools(domain),
      callLLM,
      maxToolCalls: remainingCalls,
      requireFinalText: false,
      terminalToolNames: LOOP_TERMINAL_TOOLS,
      // u6 D fix, finding 1: the domain stage is where every terminal tool an idle tick can reach
      // actually executes, so this is the call site the fence and the guard exist for.
      beforeTerminalTool: pulse?.beforeTerminalTool,
      executionGuard: pulse?.executionGuard,
    });
    // BEFORE the `!terminal` branch below, which would otherwise read a fenced-off turn as an
    // ordinary decline and stamp a cooldown under lost ownership (finding 2).
    if (pulse?.fenceLost()) return fenceLostTick();

    const terminal = domainResult.terminalToolExecuted;
    if (!terminal) {
      // Read-only discovery calls are never journaled; with no terminal tool the tick is a skip.
      await recordSkip(agentId, cooldown);
      void recordAgentLoopTick({ agentId, outcome: "skipped", inferenceConsumed, terminalAction: false });
      return { action: "skip", detail: domainResult.finalContent ?? "No terminal action taken" };
    }
    if (!terminal.result.success) {
      throw new Error(summarizeResult(terminal.call, terminal.result));
    }
    // The terminal mutation landed. Bookkeeping below (logAction, storeActionMemory, recordAction)
    // can still throw, but it can no longer make the eventual journal claim the action didn't land.
    terminalActionLanded = true;

    // Only the terminal tool is journaled and stored as memory.
    const argsSummary = summarizeArgs(terminal.call.arguments);
    const resultSummary = summarizeResult(terminal.call, terminal.result);
    await logAction(
      agentId,
      terminal.call.name,
      inferTargetType(terminal.call),
      inferTargetId(terminal.call, terminal.result),
      argsSummary
    );
    const actionDetail = [
      resultSummary,
      argsSummary ? `content: ${argsSummary}` : undefined,
    ].filter(Boolean).join(" — ");
    await storeActionMemory(agentId, terminal.call.name, actionDetail);

    await recordAction(agentId, cooldown);
    void recordAgentLoopTick({ agentId, outcome: "acted", inferenceConsumed, terminalAction: terminalActionLanded });
    return { action: terminal.call.name, detail: resultSummary };
  } catch (error) {
    // Covers every throw above, including the terminal-failure throw: the tick errored.
    // inferenceConsumed and terminalActionLanded reflect whatever they were set to before the
    // throw, so a terminal mutation that landed and THEN a bookkeeping throw (logAction,
    // storeActionMemory, recordAction) still journals terminal_action true — the soak numerator
    // must not undercount a mutation that actually happened. Rethrown unchanged —
    // runAgentLoopBatch's own error handling (recordError, the "error" result entry) is unaffected.
    void recordAgentLoopTick({ agentId, outcome: "error", inferenceConsumed, terminalAction: terminalActionLanded });
    throw error;
  }
}

// ---------------------------------------------------------------------------
// Batch runner (called by cron)
// ---------------------------------------------------------------------------

export interface AgentLoopResult {
  processed: number;
  results: { agentId: string; action: string; detail?: string; error?: string }[];
}

/**
 * M11-2 P3.3: `runAgentLoopBatch` becomes the DEGRADED wrapper — idle-sweep, then run due wakeups up
 * to the old batch size. It no longer ticks an agent directly at all: `listEligibleAgents`'s
 * candidates each get an `idle` wakeup ENQUEUED (`enqueueIdleWakeup`, deduped by
 * `idx_wakeups_dedup_idle` — an agent that already has a pending idle row gets a no-op, not a second
 * one), and `runPulseBatch` claims and runs up to `BATCH_SIZE` due wakeups of ANY reason — idle ones
 * from this very sweep, but also any reply/mention/playground_round wakeup the event pipeline armed
 * since the last pass. This is the "degraded" half of P3.4's eventual worker/cron split: the worker
 * (when it exists) drains the queue continuously and this cron path exists only as its bounded
 * fallback, preserving `AGENT_LOOP_BATCH_SIZE`'s existing meaning as a per-invocation cap.
 *
 * The public shape (`AgentLoopResult.processed`/`.results`) is unchanged, because
 * `internal/agent-loop/route.ts` (a different lane's territory) serializes it verbatim as this cron
 * route's JSON response. `results[].action` now holds the wakeup outcome (`acted`/`skip`/`error`)
 * rather than the specific tool name a successful `tickAgent` call used to report — a narrower but
 * still honest summary for what is, in production, a monitoring/debug payload rather than a published
 * API contract.
 */
export async function runAgentLoopBatch(): Promise<AgentLoopResult> {
  const { enqueueIdleWakeup, runPulseBatch, runPulseMaintenance } = await import("@/lib/agent-pulse/runner");
  const now = new Date().toISOString();

  // Housekeeping first, so an agent whose autonomy was disabled since the last pass has its
  // still-pending internal wakeups terminalized BEFORE this pass's idle-sweep or claim can touch
  // them, and so an expired lease frees its agent's one-inflight slot before anything tries to claim
  // for that agent again.
  await runPulseMaintenance();

  // The idle SCAN has one implementation per store mode (u6 stitch — both lanes flagged the
  // duplication): in db mode it is `worker/idle-scheduler.ts`'s SQL-side scan, which also applies
  // the plan's enqueue-time budget advisory (a cap-exhausted agent gets no doomed row manufactured,
  // refused and completed on every sweep until midnight); the `listEligibleAgents` loop below is
  // its MEMORY twin (Jest/no-DB — `runIdleSweep` is a documented no-op there, and the advisory miss
  // only creates a row `claimNextWakeup`'s authoritative budget spend then refuses). The dynamic
  // import mirrors the runner's own, for the same import-cycle reason documented at the top.
  if (hasDatabase()) {
    const { runIdleSweep } = await import("@/lib/worker/idle-scheduler");
    await runIdleSweep();
  } else {
    const eligible = await listEligibleAgents(now);
    for (const agentId of eligible) {
      await enqueueIdleWakeup(agentId).catch((e) => {
        console.error(`[agent-loop] idle-sweep enqueue failed for ${agentId}:`, e);
      });
    }
  }

  const batch = await runPulseBatch(BATCH_SIZE);
  const results: AgentLoopResult["results"] = batch.results.map((r) => ({
    agentId: r.agentId,
    action: r.outcome,
    detail: r.reason,
    error: r.outcome === "error" ? `wakeup ${r.wakeupId} (${r.reason}) errored` : undefined,
  }));

  return { processed: batch.claimed, results };
}
