/**
 * M11-2 u6 (P3.3) — the wakeup runner's own dispatch, focus mapping, and end-to-end wiring.
 *
 * Real memory store throughout (agents, groups, posts, comments, wakeups, `agent_loop_state`) — only
 * the LLM call is mocked, so this suite is the "memory-mode e2e" pattern the plan itself endorses
 * elsewhere ("no worker, no cron, and no manual dispatch"). Store-only claim/lease/completion/budget
 * semantics live in `src/__tests__/lib/store/wakeups/claim.test.ts`; real-Postgres concurrency lives
 * in `src/__tests__/integration/m11-2-u6-pulse-runner.test.ts`.
 *
 * @jest-environment node
 */
import { createAgent, getAgentById, setAgentVetted } from "@/lib/store/agents/memory";
import { createGroup } from "@/lib/store/groups/memory";
import { setLoopEnabled } from "@/lib/agent-loop";
import {
  agentLoopState,
  playgroundActions,
  playgroundSessions,
  resetAgentLoopState,
  resetPulseBudgetCounters,
  resetWakeupState,
  wakeupQueue,
} from "@/lib/store/_memory-state";
import { enqueueWakeup, getWakeupByAgentReasonEvent } from "@/lib/store/wakeups";
import { listComments } from "@/lib/store/comments/memory";
import { seedPost } from "@/__tests__/helpers/store-fixtures";
import type { StoredAgent } from "@/lib/store-types";
import type { StoredWakeup } from "@/lib/store/wakeups/db";

const ORIGINAL_HF_TOKEN = process.env.HF_TOKEN;

beforeEach(() => {
  resetWakeupState();
  resetAgentLoopState();
  resetPulseBudgetCounters();
  process.env.HF_TOKEN = "runner-test-token";
});

afterEach(() => {
  if (ORIGINAL_HF_TOKEN === undefined) delete process.env.HF_TOKEN;
  else process.env.HF_TOKEN = ORIGINAL_HF_TOKEN;
});

let seq = 0;
const nextName = (label: string) => `u6r_${label}_${Date.now().toString(36)}_${(seq += 1)}`;

async function agent(label: string): Promise<StoredAgent> {
  const created = await createAgent(nextName(label), "u6 runner fixture");
  await setAgentVetted(created.id, `# ${label}\n`);
  return (await getAgentById(created.id))!;
}

function fakeWakeup(overrides: Partial<StoredWakeup>): StoredWakeup {
  return {
    id: 1,
    agentId: "a",
    reason: "idle",
    eventId: null,
    payload: {},
    delivery: "internal",
    dueAt: new Date().toISOString(),
    claimedAt: null,
    claimToken: null,
    leaseExpiresAt: null,
    completedAt: null,
    result: null,
    ...overrides,
  };
}

describe("focusForWakeup — the reason-scoped context mapping", () => {
  it("comment_on_my_post and reply_to_my_comment both narrow to a 'reply' focus on the post", async () => {
    const { focusForWakeup } = await import("@/lib/agent-pulse/runner");
    for (const reason of ["comment_on_my_post", "reply_to_my_comment"]) {
      const w = fakeWakeup({ reason, payload: { post_id: "post_123" } });
      expect(focusForWakeup(w)).toEqual({ kind: "reply", postId: "post_123" });
    }
  });

  it("a mention (future producer) also narrows to a 'reply' focus", async () => {
    const { focusForWakeup } = await import("@/lib/agent-pulse/runner");
    const w = fakeWakeup({ reason: "mention", payload: { post_id: "post_456" } });
    expect(focusForWakeup(w)).toEqual({ kind: "reply", postId: "post_456" });
  });

  it("playground_round narrows to a 'playground_round' focus on the session", async () => {
    const { PLAYGROUND_ROUND_REASON } = await import("@/lib/store/wakeups");
    const { focusForWakeup } = await import("@/lib/agent-pulse/runner");
    const w = fakeWakeup({ reason: PLAYGROUND_ROUND_REASON, payload: { session_id: "sess_789", round: 2 } });
    expect(focusForWakeup(w)).toEqual({ kind: "playground_round", sessionId: "sess_789" });
  });

  it("idle (and anything unrecognized) gets the full 'idle' focus — no narrowing", async () => {
    const { focusForWakeup, IDLE_WAKEUP_REASON } = await import("@/lib/agent-pulse/runner");
    expect(focusForWakeup(fakeWakeup({ reason: IDLE_WAKEUP_REASON }))).toEqual({ kind: "idle" });
    expect(focusForWakeup(fakeWakeup({ reason: "some_future_reason" }))).toEqual({ kind: "idle" });
  });
});

/** Mocks ONLY the inference adapter; everything else in the reply path is the real memory store. */
function mockInference(callLLM: jest.Mock): void {
  jest.doMock("@/lib/agent-runtime/adapters/openai-compatible", () => ({
    makeHfRouterCallLLM: jest.fn(() => callLLM),
    makeOpenAiCallLLM: jest.fn(),
  }));
}

describe("runPulseBatch — e2e comment ⇒ reply, no cron", () => {
  beforeEach(() => {
    jest.resetModules();
  });

  it("claims a comment_on_my_post wakeup, the model calls create_comment, and a real reply lands", async () => {
    const author = await agent("author");
    await setLoopEnabled(author.id, true);
    const group = await createGroup(nextName("grp"), "u6 group", "", author.id);
    const post = await seedPost(author.id, group.id, "a post worth replying to");

    // The router's own job (event → wakeup) is somebody else's tested territory (P3.2, wave 1) —
    // this suite arms the wakeup directly, which is exactly the seam `runPulseBatch` starts from.
    const enq = await enqueueWakeup({
      agentId: author.id,
      reason: "comment_on_my_post",
      eventId: 900001,
      payload: { post_id: post.id, comment_id: "seed_comment", parent_comment_id: null },
      delivery: "internal",
    });
    expect(enq.created).toBe(true);

    const callLLM = jest.fn().mockResolvedValueOnce({
      content: null,
      toolCalls: [{ id: "call_1", name: "create_comment", arguments: { post_id: post.id, content: "thanks for reading!" } }],
    });
    mockInference(callLLM);

    const { runPulseBatch } = await import("@/lib/agent-pulse/runner");
    const result = await runPulseBatch(1);

    expect(result.claimed).toBe(1);
    expect(result.results[0]).toMatchObject({ agentId: author.id, reason: "comment_on_my_post", outcome: "acted" });

    // The wakeup itself is completed `acted`.
    const wakeupRow = await getWakeupByAgentReasonEvent(author.id, "comment_on_my_post", 900001);
    expect(wakeupRow?.result).toBe("acted");
    expect(wakeupRow?.completedAt).not.toBeNull();

    // And a REAL comment landed — not a mock, not a stub.
    const comments = await listComments(post.id);
    expect(comments.some((c) => c.authorId === author.id && c.content === "thanks for reading!")).toBe(true);

    // `beforeTerminalTool` did not skip: only ONE LLM call was needed (maxToolCalls: 1,
    // requireFinalText: false), confirming the narrow single-tool turn shape.
    expect(callLLM).toHaveBeenCalledTimes(1);
  });

  it("completes the wakeup as skip when the model declines to reply", async () => {
    const author = await agent("author2");
    await setLoopEnabled(author.id, true);
    const group = await createGroup(nextName("grp"), "u6 group", "", author.id);
    const post = await seedPost(author.id, group.id, "nothing worth saying");

    await enqueueWakeup({
      agentId: author.id,
      reason: "comment_on_my_post",
      eventId: 900002,
      payload: { post_id: post.id, comment_id: "seed_comment_2", parent_comment_id: null },
      delivery: "internal",
    });

    const callLLM = jest.fn().mockResolvedValueOnce({ content: "nothing to add here", toolCalls: [] });
    mockInference(callLLM);

    const { runPulseBatch } = await import("@/lib/agent-pulse/runner");
    const result = await runPulseBatch(1);

    expect(result.results[0].outcome).toBe("skip");
    const wakeupRow = await getWakeupByAgentReasonEvent(author.id, "comment_on_my_post", 900002);
    expect(wakeupRow?.result).toBe("skip");
  });

  it("the disable landing between claim and the terminal call ends the tick as skip via the lease fence — no comment lands", async () => {
    const author = await agent("author3");
    await setLoopEnabled(author.id, true);
    const group = await createGroup(nextName("grp"), "u6 group", "", author.id);
    const post = await seedPost(author.id, group.id, "a post that will go unanswered");

    await enqueueWakeup({
      agentId: author.id,
      reason: "reply_to_my_comment",
      eventId: 900003,
      payload: { post_id: post.id, comment_id: "seed_comment_3", parent_comment_id: "parent_seed" },
      delivery: "internal",
    });

    // The mock LLM call itself is the moment "mid-tick" happens: by the time it resolves with a
    // tool call, a human has disabled the agent's autonomy. `beforeTerminalTool`'s lease renewal
    // (`renewWakeupLease`) must then refuse, ending the turn as a skip WITHOUT invoking the tool —
    // proving the fence, not merely the (separately, integration-tested) statement-level guard.
    const callLLM = jest.fn().mockImplementationOnce(async () => {
      await setLoopEnabled(author.id, false);
      return {
        content: null,
        toolCalls: [{ id: "call_1", name: "create_comment", arguments: { post_id: post.id, content: "should never land" } }],
      };
    });
    mockInference(callLLM);

    const { runPulseBatch } = await import("@/lib/agent-pulse/runner");
    const result = await runPulseBatch(1);

    expect(result.results[0].outcome).toBe("skip");
    const comments = await listComments(post.id);
    expect(comments.some((c) => c.content === "should never land")).toBe(false);
  });
});

/**
 * u6 stitch item 2 (g) — P3.2's "terminal tool invoked" must never be read as "acted".
 *
 * The runtime ends a narrow turn on a terminal call REGARDLESS of that call's `success` flag, and it
 * converts executor exceptions into `{success: false}` results. So for `playground_round` the runner
 * needs two additional facts before it may write `result = 'acted'`: the submit actually succeeded,
 * and it succeeded FOR THE ROUND this wakeup was armed for. Everything short of that completes as
 * re-armable `error`, so the deadline sweep hands the turn back rather than forfeiting it — the
 * zero-forfeit gate. The code path existed from lane D; this is its test.
 *
 * Real memory store throughout: real session, real gated insert (including its execution-guard twin,
 * which the runner now populates for this reason too — u6 stitch item 1), real wakeup bookkeeping.
 */
describe("runPulseBatch — playground_round: a refused or mismatched submit is never 'acted'", () => {
  beforeEach(() => {
    jest.resetModules();
    // The memory store enforces the same one-live-session-per-school rule Postgres does
    // (`idx_pg_sessions_one_live_per_school`), and every fixture below has to live in `foundation`
    // — the session's OWN school decides who may act in it (`sessionSchoolAccessDenial`), so a
    // per-fixture school would refuse the acting agent instead of testing the round rule. Clearing
    // between cases is what frees the slot.
    playgroundSessions.clear();
    playgroundActions.clear();
  });

  /** Two ACTIVE participants, so the one submission below never trips `tryAdvanceRound` into
   *  buying a GM call — this suite mocks inference, not the game engine. */
  async function seedSession(
    actorId: string,
    currentRound: number
  ): Promise<{ sessionId: string }> {
    const { createPlaygroundSession } = await import("@/lib/store/playground/memory");
    const sessionId = nextName("sess");
    await createPlaygroundSession({
      id: sessionId,
      gameId: "pub-debate",
      schoolId: "foundation",
      status: "active",
      participants: [
        { agentId: actorId, agentName: actorId, status: "active", missedRounds: 0 },
        { agentId: `${actorId}_peer`, agentName: `${actorId}_peer`, status: "active", missedRounds: 0 },
      ],
      currentRound,
      currentRoundPrompt: "make your move",
      maxRounds: 6,
      startedAt: new Date().toISOString(),
    });
    return { sessionId };
  }

  async function armRoundWakeup(agentId: string, sessionId: string, round: number, eventId: number) {
    const { PLAYGROUND_ROUND_REASON } = await import("@/lib/store/wakeups");
    const enq = await enqueueWakeup({
      agentId,
      reason: PLAYGROUND_ROUND_REASON,
      eventId,
      payload: { session_id: sessionId, round },
      delivery: "internal",
    });
    expect(enq.created).toBe(true);
    return PLAYGROUND_ROUND_REASON;
  }

  it("a successful submit for the armed round completes 'acted' and the action row lands", async () => {
    const actor = await agent("pg1");
    await setLoopEnabled(actor.id, true);
    const { sessionId } = await seedSession(actor.id, 1);
    const reason = await armRoundWakeup(actor.id, sessionId, 1, 910001);

    const callLLM = jest.fn().mockResolvedValueOnce({
      content: null,
      toolCalls: [
        { id: "call_1", name: "submit_playground_action", arguments: { session_id: sessionId, content: "I open with a question" } },
      ],
    });
    mockInference(callLLM);

    const { runPulseBatch } = await import("@/lib/agent-pulse/runner");
    const result = await runPulseBatch(1);

    expect(result.results[0]).toMatchObject({ agentId: actor.id, reason, outcome: "acted" });
    expect((await getWakeupByAgentReasonEvent(actor.id, reason, 910001))?.result).toBe("acted");

    // A REAL action row — which also proves the execution guard's memory twin PASSES for an enabled
    // agent holding a live claim (the runner supplies one for this reason since u6 stitch item 1);
    // a wrong twin would have refused this submit and the outcome would read `error`.
    const { getPlaygroundActions } = await import("@/lib/store/playground/memory");
    const actions = await getPlaygroundActions(sessionId, 1);
    expect(actions.map((a) => a.agentId)).toContain(actor.id);
  });

  it("a REFUSED submit (already acted this round) completes re-armable 'error', never 'acted'", async () => {
    const actor = await agent("pg2");
    await setLoopEnabled(actor.id, true);
    const { sessionId } = await seedSession(actor.id, 1);
    // The agent already has this round's action — the gated insert's duplicate refusal, which the
    // tool surfaces as `{success: false}` and the runtime still treats as a terminal call.
    const { submitPlaygroundActionGated } = await import("@/lib/store/playground/memory");
    const seeded = await submitPlaygroundActionGated({
      id: nextName("act"),
      sessionId,
      agentId: actor.id,
      round: 1,
      content: "already said my piece",
    });
    expect(seeded.ok).toBe(true);

    const reason = await armRoundWakeup(actor.id, sessionId, 1, 910002);
    const callLLM = jest.fn().mockResolvedValueOnce({
      content: null,
      toolCalls: [
        { id: "call_1", name: "submit_playground_action", arguments: { session_id: sessionId, content: "a second move" } },
      ],
    });
    mockInference(callLLM);

    const { runPulseBatch } = await import("@/lib/agent-pulse/runner");
    const result = await runPulseBatch(1);

    expect(result.results[0].outcome).toBe("error");
    const row = await getWakeupByAgentReasonEvent(actor.id, reason, 910002);
    expect(row?.result).toBe("error");
    // Re-armable per P3.2's predicate: completed, and NOT 'acted'.
    expect(row?.completedAt).not.toBeNull();
    expect(row?.result).not.toBe("acted");

    // And no second action row was created for the round.
    const { getPlaygroundActions } = await import("@/lib/store/playground/memory");
    expect((await getPlaygroundActions(sessionId, 1)).length).toBe(1);
  });

  it("a submit that SUCCEEDS for a different round than the wakeup was armed for completes 'error'", async () => {
    const actor = await agent("pg3");
    await setLoopEnabled(actor.id, true);
    // The session has already moved to round 2; the wakeup was armed for round 1. The submit lands
    // (the service reads the CURRENT round), so the tool returns success — and `acted` would strand
    // round 1's turn as answered when it never was.
    const { sessionId } = await seedSession(actor.id, 2);
    const reason = await armRoundWakeup(actor.id, sessionId, 1, 910003);

    const callLLM = jest.fn().mockResolvedValueOnce({
      content: null,
      toolCalls: [
        { id: "call_1", name: "submit_playground_action", arguments: { session_id: sessionId, content: "late to the party" } },
      ],
    });
    mockInference(callLLM);

    const { runPulseBatch } = await import("@/lib/agent-pulse/runner");
    const result = await runPulseBatch(1);

    expect(result.results[0].outcome).toBe("error");
    expect((await getWakeupByAgentReasonEvent(actor.id, reason, 910003))?.result).toBe("error");
  });
});

/**
 * u6 D fix round 1, finding 1 — an `idle` tick is fenced and guarded like every other reason.
 *
 * `idle` is the one reason the runner dispatches through the legacy `tickAgent`, and it used to run
 * its terminal tool with NEITHER the lease-renewal fence NOR the execution guard: a claimed idle
 * wakeup whose agent was disabled mid-tick could still post, vote, follow or comment, on the
 * highest-volume reason there is. `tickAgent` now takes the runner's pulse bundle and threads both
 * into its domain-stage turn.
 *
 * Real memory store throughout, exactly like the reply cases above — only inference and the RSS fetch
 * are mocked.
 */
describe("runPulseBatch — idle: the fence and the guard reach the legacy tick", () => {
  beforeEach(() => {
    jest.resetModules();
    // The `idle` focus gathers EVERY sense, including headlines a real `getNewsItems` would fetch
    // over the network. Mocked to keep this suite offline; nothing below asserts news.
    jest.doMock("@/lib/rss", () => ({ getNewsItems: jest.fn(async () => []) }));
  });

  /** Two LLM rounds: the discovery stage declares a domain, the domain stage asks for the tool. */
  function idleLlm(postId: string, content: string, beforeTerminalCall?: () => Promise<void>) {
    return jest
      .fn()
      .mockImplementationOnce(async () => ({ content: "DOMAIN: discussion", toolCalls: [] }))
      .mockImplementationOnce(async () => {
        if (beforeTerminalCall) await beforeTerminalCall();
        return {
          content: null,
          toolCalls: [{ id: "call_1", name: "create_comment", arguments: { post_id: postId, content } }],
        };
      });
  }

  /**
   * Arms the idle row through the plain `enqueueWakeup` path — the same event-less shape
   * `enqueueIdleWakeup` produces. Deliberately NOT through the runner: importing that module here
   * would load it (and its inference adapter) before `mockInference` gets to replace the adapter.
   */
  async function seedIdleAgent(label: string) {
    const author = await agent(label);
    await setLoopEnabled(author.id, true);
    const group = await createGroup(nextName("grp"), "u6 group", "", author.id);
    const post = await seedPost(author.id, group.id, "an idle tick will find this");
    const enq = await enqueueWakeup({
      agentId: author.id,
      reason: "idle",
      eventId: null,
      payload: {},
      delivery: "internal",
    });
    expect(enq.created).toBe(true);
    return { author, post };
  }

  it("an enabled idle tick still acts — the guard the runner now supplies passes for a live claim", async () => {
    const { author, post } = await seedIdleAgent("idle1");
    const callLLM = idleLlm(post.id, "an idle thought");
    mockInference(callLLM);

    const { runPulseBatch, IDLE_WAKEUP_REASON } = await import("@/lib/agent-pulse/runner");
    const result = await runPulseBatch(1);

    expect(result.results[0]).toMatchObject({ agentId: author.id, reason: IDLE_WAKEUP_REASON, outcome: "acted" });
    // A REAL comment, written through the guarded action: a guard that did not pass would have
    // refused this write and the outcome would read `error`.
    const comments = await listComments(post.id);
    expect(comments.some((c) => c.authorId === author.id && c.content === "an idle thought")).toBe(true);
  });

  it("a disable landing mid-tick stops the terminal mutation and writes no loop state", async () => {
    const { author, post } = await seedIdleAgent("idle2");
    const before = { ...agentLoopState.get(author.id)! };

    // "Mid-tick" is the moment the domain-stage LLM call resolves: by then a human has turned this
    // agent's autonomy off. The fence must refuse before `create_comment` executes.
    const callLLM = idleLlm(post.id, "should never land", async () => {
      await setLoopEnabled(author.id, false);
    });
    mockInference(callLLM);

    const { runPulseBatch, IDLE_WAKEUP_REASON } = await import("@/lib/agent-pulse/runner");
    const result = await runPulseBatch(1);

    // No terminal mutation.
    const comments = await listComments(post.id);
    expect(comments.some((c) => c.content === "should never land")).toBe(false);

    // A fenced, re-armable, non-`acted` outcome.
    expect(result.results[0].outcome).toBe("skip");
    // The idle row carries no event id (`enqueueIdleWakeup` is the event-less producer), so it is
    // read from the queue directly rather than through the event-keyed lookup the cases above use.
    const row = [...wakeupQueue.rows.values()].find(
      (w) => w.agentId === author.id && w.reason === IDLE_WAKEUP_REASON
    )!;
    expect(row.completedAt).not.toBeNull();
    expect(row.result).not.toBe("acted");

    // And nothing was written about an agent this tick no longer owned: `enabled` is the ONE field
    // the human's disable moved, and every other field — the `next_eligible_at` cooldown above all —
    // is byte-identical to what it was before the tick.
    const after = agentLoopState.get(author.id)!;
    expect({ ...after, enabled: before.enabled }).toEqual(before);
  });
});

/**
 * u6 D fix round 1, finding 2 — fence loss ends the tick with NO further unfenced writes.
 *
 * A failed pre-terminal renewal used to fall through to the ordinary "the model declined" branch,
 * which calls `recordSkip` — an `agent_loop_state` write (`next_eligible_at`, `last_seen_at`) made
 * under ownership the runner had just been told it lost. A later re-enable, or the claim's new owner,
 * then inherited that stale cooldown.
 */
describe("runPulseBatch — fence loss writes no loop state", () => {
  beforeEach(() => {
    jest.resetModules();
  });

  async function seedReplyWakeup(label: string, eventId: number) {
    const author = await agent(label);
    await setLoopEnabled(author.id, true);
    const group = await createGroup(nextName("grp"), "u6 group", "", author.id);
    const post = await seedPost(author.id, group.id, "a post whose reply never lands");
    await enqueueWakeup({
      agentId: author.id,
      reason: "comment_on_my_post",
      eventId,
      payload: { post_id: post.id, comment_id: `seed_${eventId}`, parent_comment_id: null },
      delivery: "internal",
    });
    const row = await getWakeupByAgentReasonEvent(author.id, "comment_on_my_post", eventId);
    return { author, post, wakeupId: row!.id };
  }

  it("a disable before the renewal leaves agent_loop_state byte-identical — no cooldown bump", async () => {
    const { author, post } = await seedReplyWakeup("fence1", 900101);
    const before = { ...agentLoopState.get(author.id)! };

    const callLLM = jest.fn().mockImplementationOnce(async () => {
      await setLoopEnabled(author.id, false);
      return {
        content: null,
        toolCalls: [{ id: "call_1", name: "create_comment", arguments: { post_id: post.id, content: "no" } }],
      };
    });
    mockInference(callLLM);

    const { runPulseBatch } = await import("@/lib/agent-pulse/runner");
    await runPulseBatch(1);

    const after = agentLoopState.get(author.id)!;
    expect({ ...after, enabled: before.enabled }).toEqual(before);

    // The token was still ours here — the renewal failed on `enabled`, not on ownership — so the one
    // completion this path attempts lands, freeing the agent's one-inflight slot, and stays re-armable.
    const row = await getWakeupByAgentReasonEvent(author.id, "comment_on_my_post", 900101);
    expect(row?.result).toBe("skip");
  });

  it("a claim superseded mid-tick writes nothing at all — the new owner's row is untouched", async () => {
    const { author, post, wakeupId } = await seedReplyWakeup("fence2", 900102);
    const before = { ...agentLoopState.get(author.id)! };

    // Abandonment + re-arm + re-claim by another runner, compressed into one line: the row now
    // carries somebody else's token, so this runner's renewal AND its completion both match zero rows.
    const callLLM = jest.fn().mockImplementationOnce(async () => {
      wakeupQueue.rows.get(wakeupId)!.claimToken = "another-runners-token";
      return {
        content: null,
        toolCalls: [{ id: "call_1", name: "create_comment", arguments: { post_id: post.id, content: "no" } }],
      };
    });
    mockInference(callLLM);

    const { runPulseBatch } = await import("@/lib/agent-pulse/runner");
    await runPulseBatch(1);

    // The superseded runner completed nothing: the new owner's claim is exactly as it left it.
    const row = wakeupQueue.rows.get(wakeupId)!;
    expect(row.claimToken).toBe("another-runners-token");
    expect(row.completedAt).toBeNull();
    expect(row.result).toBeNull();

    // No comment, and no loop-state write either.
    expect((await listComments(post.id)).some((c) => c.content === "no")).toBe(false);
    expect(agentLoopState.get(author.id)!).toEqual(before);
  });
});

describe("runPulseBatch — autonomy-disable: pending wakeups are never claimed", () => {
  beforeEach(() => {
    jest.resetModules();
  });

  it("a disabled agent's due wakeup is never claimed (excluded by the claim predicate)", async () => {
    const author = await agent("author4");
    // Deliberately NOT enabled.
    const group = await createGroup(nextName("grp"), "u6 group", "", author.id);
    const post = await seedPost(author.id, group.id, "a post nobody will see");
    await enqueueWakeup({
      agentId: author.id,
      reason: "comment_on_my_post",
      eventId: 900004,
      payload: { post_id: post.id, comment_id: "seed_comment_4", parent_comment_id: null },
      delivery: "internal",
    });

    const callLLM = jest.fn();
    mockInference(callLLM);

    const { runPulseBatch } = await import("@/lib/agent-pulse/runner");
    const result = await runPulseBatch(1);

    expect(result.claimed).toBe(0);
    expect(callLLM).not.toHaveBeenCalled();
    const wakeupRow = await getWakeupByAgentReasonEvent(author.id, "comment_on_my_post", 900004);
    expect(wakeupRow?.claimedAt).toBeNull();
    expect(wakeupRow?.completedAt).toBeNull();
  });
});
