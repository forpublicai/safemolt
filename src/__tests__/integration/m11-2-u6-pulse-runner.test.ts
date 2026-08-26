/**
 * M11-2 u6 (P3.3) `[integration]` — what only a real database can show about the wakeup runner's
 * claim/lease/completion/housekeeping statements and the execution guard.
 *
 * Memory-mode coverage lives in `src/__tests__/lib/store/wakeups/claim.test.ts` (the store's own
 * semantics, one synchronous section at a time) and `src/__tests__/lib/agent-pulse/runner.test.ts`
 * (dispatch, focus, cooldown bookkeeping, e2e comment ⇒ reply). What ONLY Postgres can show:
 *  - the claim CTE's `FOR UPDATE SKIP LOCKED` really does hand two concurrent claimants two
 *    DIFFERENT rows of the same agent, and the partial unique index `idx_wakeups_one_inflight`
 *    really does abort the loser's statement — including its budget increment — rather than merely
 *    being a predicate memory mode can approximate with "no `await` between the check and the
 *    write";
 *  - the execution guard's `FOR SHARE` lock on `agent_loop_state` gives a concurrent disable a real
 *    serialization order against the decisive comment insert, not a race a single JS thread cannot
 *    produce at all.
 */
import { closeIntegrationConnections, pgPool } from "./helpers/db";
import { rejections, runConcurrently } from "./helpers/concurrency";
import {
  abandonExpiredWakeupLeases,
  claimNextWakeup,
  completeWakeup,
  enqueueWakeup,
  pruneTerminalWakeups,
  renewWakeupLease,
  terminalizeDisabledAgentWakeups,
} from "@/lib/store/wakeups/db";
import { createCommentWithOutcome } from "@/lib/store/comments/db";
import { submitPlaygroundActionGated } from "@/lib/store/playground/db";
import type { ExecutionGuard } from "@/lib/store/execution-guard";

const RUN = `${Date.now().toString(36)}_${Math.floor(Math.random() * 1e6).toString(36)}`;
let seq = 0;
const nextId = (kind: string) => `u6pr_${kind}_${RUN}_${(seq += 1)}`;

async function seedAgent(): Promise<string> {
  const id = nextId("agent");
  await pgPool().query(
    `INSERT INTO agents (id, name, description, api_key, points, vote_points, evaluation_points,
                         legacy_unattributed_points, follower_count, is_claimed, created_at, is_vetted)
     VALUES ($1, $1, '', $2, 0, 0, 0, 0, 0, false, NOW(), true)`,
    [id, `u6pr_key_${id}`]
  );
  return id;
}

async function seedLoopState(agentId: string, enabled: boolean): Promise<void> {
  await pgPool().query(`INSERT INTO agent_loop_state (agent_id, enabled) VALUES ($1, $2)`, [agentId, enabled]);
}

async function setEnabled(agentId: string, enabled: boolean): Promise<void> {
  await pgPool().query(`UPDATE agent_loop_state SET enabled = $2 WHERE agent_id = $1`, [agentId, enabled]);
}

/** A fresh synthetic event id — `agent_wakeups.event_id` has no foreign key. */
let syntheticEventId = 950_000_000;
const nextEventId = () => (syntheticEventId += 1);

async function seedIdleWakeup(agentId: string): Promise<void> {
  const created = await enqueueWakeup({
    agentId,
    reason: "idle",
    eventId: null,
    payload: { run: RUN },
    delivery: "internal",
  });
  if (!created.created) throw new Error("expected a fresh idle wakeup to be created");
}

async function budgetCount(agentId: string, bucket: "general" | "playground"): Promise<number> {
  const { rows } = await pgPool().query(
    `SELECT count FROM pulse_budget_counters WHERE agent_id = $1 AND day = CURRENT_DATE AND bucket = $2`,
    [agentId, bucket]
  );
  return rows[0] ? Number(rows[0].count) : 0;
}

async function readWakeup(id: number): Promise<Record<string, unknown>> {
  const { rows } = await pgPool().query(`SELECT * FROM agent_wakeups WHERE id = $1`, [id]);
  return rows[0] as Record<string, unknown>;
}

async function seedGroupAndPost(authorId: string): Promise<{ groupId: string; postId: string }> {
  const groupId = nextId("group");
  const postId = nextId("post");
  await pgPool().query(
    `INSERT INTO groups (id, name, display_name, description, owner_id, created_at)
     VALUES ($1, $1, 'u6pr group', '', $2, NOW())`,
    [groupId, authorId]
  );
  await pgPool().query(
    `INSERT INTO posts (id, group_id, author_id, title, content, upvotes, downvotes, comment_count, created_at)
     VALUES ($1, $2, $3, 'host post', 'body', 0, 0, 0, NOW())`,
    [postId, groupId, authorId]
  );
  return { groupId, postId };
}

/** An ACTIVE session on round 1 with `agentId` listed as an active participant — the one shape the
 *  gated insert admits, so anything it refuses came from the guard and nothing else. Each fixture
 *  gets a school of its own, because `idx_pg_sessions_one_live_per_school` admits one live session
 *  per school and these tests seed several at once. */
async function seedPlaygroundSession(agentId: string): Promise<string> {
  const sessionId = nextId("session");
  await pgPool().query(
    `INSERT INTO playground_sessions (id, game_id, school_id, status, participants, transcript,
                                      current_round, current_round_prompt, max_rounds, created_at, started_at)
     VALUES ($1, 'u6pr-game', $3, 'active', $2::jsonb, '[]'::jsonb, 1, 'your move', 4, NOW(), NOW())`,
    [
      sessionId,
      JSON.stringify([{ agentId, agentName: agentId, status: "active", missedRounds: 0 }]),
      `school_${sessionId}`,
    ]
  );
  return sessionId;
}

async function countActions(sessionId: string): Promise<number> {
  const { rows } = await pgPool().query(
    `SELECT count(*)::int AS n FROM playground_actions WHERE session_id = $1`,
    [sessionId]
  );
  return Number(rows[0].n);
}

let baselineEventId = 0;

/**
 * Orphan neutralization: a prior interrupted run of this file (or a genuinely failed assertion) can
 * leave `u6pr_agent_*` rows behind — RUN-suffixed ids mean a fresh run's own assertions cannot
 * collide with them, but `idx_wakeups_one_inflight` is one-per-agent-in-the-whole-table, not
 * one-per-run, so a stale in-flight claim from a dead run is otherwise invisible debt. Swept by
 * PREFIX, not by this run's own `RUN` value, so it also cleans up whatever the run before THIS one
 * left behind.
 */
beforeAll(async () => {
  await pgPool().query(`DELETE FROM playground_actions WHERE session_id LIKE 'u6pr_session_%'`);
  await pgPool().query(`DELETE FROM playground_sessions WHERE id LIKE 'u6pr_session_%'`);
  // One-per-scope index orphan neutralization: `idx_pg_sessions_one_live_per_school` admits one live
  // session per school regardless of id, so a run-unique suffix cannot dodge a leftover — and an
  // interrupted prior run skips afterAll and leaves exactly that. Each fixture seeds its own school,
  // so only same-named orphans and genuinely stale live rows can be in the way.
  await pgPool().query(
    `UPDATE playground_sessions SET status = 'cancelled', completed_at = NOW()
     WHERE status IN ('pending', 'active')
       AND (id LIKE 'u6pr%' OR created_at < NOW() - INTERVAL '1 hour')`
  );
  await pgPool().query(`DELETE FROM notifications WHERE agent_id LIKE 'u6pr_agent_%' OR actor->>'id' LIKE 'u6pr_agent_%'`);
  await pgPool().query(`DELETE FROM comments WHERE author_id LIKE 'u6pr_agent_%'`);
  await pgPool().query(`DELETE FROM posts WHERE author_id LIKE 'u6pr_agent_%'`);
  await pgPool().query(`DELETE FROM groups WHERE owner_id LIKE 'u6pr_agent_%'`);
  await pgPool().query(`DELETE FROM agent_rate_limits WHERE agent_id LIKE 'u6pr_agent_%'`);
  await pgPool().query(`DELETE FROM activity_events WHERE actor_id LIKE 'u6pr_agent_%'`);
  await pgPool().query(`DELETE FROM agent_wakeups WHERE agent_id LIKE 'u6pr_agent_%'`);
  await pgPool().query(`DELETE FROM pulse_budget_counters WHERE agent_id LIKE 'u6pr_agent_%'`);
  await pgPool().query(`DELETE FROM agent_loop_state WHERE agent_id LIKE 'u6pr_agent_%'`);
  await pgPool().query(`DELETE FROM agents WHERE id LIKE 'u6pr_agent_%'`);

  const { rows } = await pgPool().query(`SELECT COALESCE(max(id), 0) AS id FROM events`);
  baselineEventId = Number(rows[0].id);
});

afterAll(async () => {
  // Explicit deletes first (comments/posts/groups/wakeups/loop-state all cascade from agents, but
  // removing them ahead of the agent keeps a failed agent cleanup from stranding this run's rows).
  await pgPool().query(`DELETE FROM notifications WHERE agent_id LIKE $1 OR actor->>'id' LIKE $1`, [
    `u6pr_agent_${RUN}%`,
  ]);
  await pgPool().query(`DELETE FROM comments WHERE author_id LIKE $1`, [`u6pr_agent_${RUN}%`]);
  await pgPool().query(`DELETE FROM posts WHERE author_id LIKE $1`, [`u6pr_agent_${RUN}%`]);
  await pgPool().query(`DELETE FROM groups WHERE owner_id LIKE $1`, [`u6pr_agent_${RUN}%`]);
  await pgPool().query(`DELETE FROM agent_rate_limits WHERE agent_id LIKE $1`, [`u6pr_agent_${RUN}%`]);
  await pgPool().query(`DELETE FROM playground_actions WHERE session_id LIKE $1`, [`u6pr_session_${RUN}%`]);
  await pgPool().query(`DELETE FROM playground_sessions WHERE id LIKE $1`, [`u6pr_session_${RUN}%`]);
  await pgPool().query(`DELETE FROM activity_events WHERE actor_id LIKE $1`, [`u6pr_agent_${RUN}%`]);
  await pgPool().query(`DELETE FROM agent_wakeups WHERE agent_id LIKE $1`, [`u6pr_agent_${RUN}%`]);
  await pgPool().query(`DELETE FROM pulse_budget_counters WHERE agent_id LIKE $1`, [`u6pr_agent_${RUN}%`]);
  await pgPool().query(`DELETE FROM agent_loop_state WHERE agent_id LIKE $1`, [`u6pr_agent_${RUN}%`]);
  await pgPool().query(`DELETE FROM events WHERE id > $1`, [baselineEventId]);
  await pgPool().query(`DELETE FROM agents WHERE id LIKE $1`, [`u6pr_agent_${RUN}%`]);
  await closeIntegrationConnections();
});

describe("claimNextWakeup — real one-inflight and budget races", () => {
  it("two concurrent claims for one agent's two due wakeups: exactly one wins, never both", async () => {
    const agent = await seedAgent();
    await seedLoopState(agent, true);
    await seedIdleWakeup(agent);
    // A second idle-shaped row needs a distinct reason/event pairing to pass the idle dedup index —
    // reuse a comment-notification-shaped reason instead, which is event-keyed and independent.
    await enqueueWakeup({
      agentId: agent,
      reason: "comment_on_my_post",
      eventId: nextEventId(),
      payload: { run: RUN },
      delivery: "internal",
    });

    const claim = () =>
      claimNextWakeup({
        claimToken: nextId("token"),
        leaseMs: 600_000,
        generalCap: 50,
        playgroundCap: 50,
      });
    const outcomes = await runConcurrently([claim, claim]);
    expect(rejections(outcomes)).toEqual([]);

    const succeeded: { id: number; claimToken: string; agentId: string }[] = [];
    for (const outcome of outcomes) {
      if (!outcome.ok) continue;
      const { value } = outcome;
      if (value.candidates === 1 && value.claimed) {
        succeeded.push({ id: value.claimed.id, claimToken: value.claimed.claimToken!, agentId: value.claimed.agentId });
      }
    }

    // Exactly one of the two concurrent attempts actually claimed a row. The other's statement
    // either lost the `idx_wakeups_one_inflight` race and retried into an empty candidate set (this
    // agent is now excluded by `NOT EXISTS`), or — a narrower interleaving — saw the winner's claim
    // already committed on its very first attempt. Both resolve to `claimed: null`-shaped answers,
    // never a second successful claim.
    expect(succeeded).toHaveLength(1);
    expect(succeeded[0].agentId).toBe(agent);

    // The database invariant this whole statement exists to protect: never two live claims for one
    // agent.
    const { rows } = await pgPool().query(
      `SELECT count(*)::int AS n FROM agent_wakeups WHERE agent_id = $1 AND claimed_at IS NOT NULL AND completed_at IS NULL`,
      [agent]
    );
    expect(rows[0].n).toBe(1);

    // Budget: only the ONE successful claim spent its bucket. A 23505-aborted statement rolls back
    // its own budget increment along with the claim — this is the "aborted claim spends nothing"
    // gate, and it needs a real transaction abort to observe (a memory-mode approximation has no
    // rollback to get wrong).
    const generalSpent = await budgetCount(agent, "general");
    expect(generalSpent).toBe(1);
  });

  it("an over-cap candidate is completed budget_exhausted in-statement, spending nothing further", async () => {
    const agent = await seedAgent();
    await seedLoopState(agent, true);
    await seedIdleWakeup(agent);
    // Pre-fill today's general bucket to the cap.
    await pgPool().query(
      `INSERT INTO pulse_budget_counters (agent_id, day, bucket, count) VALUES ($1, CURRENT_DATE, 'general', 3)`,
      [agent]
    );

    const result = await claimNextWakeup({
      claimToken: nextId("token"),
      leaseMs: 600_000,
      generalCap: 3,
      playgroundCap: 3,
    });
    expect(result).toEqual({ candidates: 1, claimed: null });

    // The counter did not move past the cap.
    expect(await budgetCount(agent, "general")).toBe(3);

    // The candidate itself was terminalized in-statement, not left pending for a future sweep to
    // rediscover forever.
    const { rows } = await pgPool().query(
      `SELECT completed_at, result FROM agent_wakeups WHERE agent_id = $1 ORDER BY id DESC LIMIT 1`,
      [agent]
    );
    expect(rows[0].result).toBe("budget_exhausted");
    expect(rows[0].completed_at).not.toBeNull();
  });

  it("a disabled agent's due wakeup is never a candidate at all", async () => {
    const agent = await seedAgent();
    await seedLoopState(agent, false);
    await seedIdleWakeup(agent);

    const result = await claimNextWakeup({
      claimToken: nextId("token"),
      leaseMs: 600_000,
      generalCap: 50,
      playgroundCap: 50,
    });
    expect(result).toEqual({ candidates: 0 });
  });
});

describe("renewWakeupLease — token-fenced, enabled-checked", () => {
  it("renews for the right token while enabled; refuses the wrong token; refuses once disabled", async () => {
    const agent = await seedAgent();
    await seedLoopState(agent, true);
    await seedIdleWakeup(agent);
    const claim = await claimNextWakeup({
      claimToken: nextId("token"),
      leaseMs: 600_000,
      generalCap: 50,
      playgroundCap: 50,
    });
    if (claim.candidates !== 1 || !claim.claimed) throw new Error("expected a successful claim");
    const { id, claimToken } = claim.claimed;
    if (!claimToken) throw new Error("a freshly claimed wakeup must carry a claim_token");

    expect(await renewWakeupLease(id, "not-the-real-token", 600_000)).toBe(false);
    expect(await renewWakeupLease(id, claimToken, 600_000)).toBe(true);

    await setEnabled(agent, false);
    // P3.2's kill-switch guarantee: a disable landing before the renewal makes it fail, exactly as
    // the plan's own renewal SQL requires (`EXISTS (... ls.enabled)`).
    expect(await renewWakeupLease(id, claimToken, 600_000)).toBe(false);
  });
});

describe("completeWakeup — token-fenced completion", () => {
  it("completes once for the right token; a second completion attempt (even with the same token) fails", async () => {
    const agent = await seedAgent();
    await seedLoopState(agent, true);
    await seedIdleWakeup(agent);
    const claim = await claimNextWakeup({
      claimToken: nextId("token"),
      leaseMs: 600_000,
      generalCap: 50,
      playgroundCap: 50,
    });
    if (claim.candidates !== 1 || !claim.claimed) throw new Error("expected a successful claim");
    const { id, claimToken } = claim.claimed;
    if (!claimToken) throw new Error("a freshly claimed wakeup must carry a claim_token");

    expect(await completeWakeup(id, claimToken, "acted")).toBe(true);
    expect(await completeWakeup(id, claimToken, "acted")).toBe(false);

    const row = await readWakeup(id);
    expect(row.result).toBe("acted");
  });
});

describe("housekeeping sweeps", () => {
  it("abandons an expired-lease claim and frees the one-inflight slot", async () => {
    const agent = await seedAgent();
    await seedLoopState(agent, true);
    await seedIdleWakeup(agent);
    const claim = await claimNextWakeup({
      claimToken: nextId("token"),
      leaseMs: 600_000,
      generalCap: 50,
      playgroundCap: 50,
    });
    if (claim.candidates !== 1 || !claim.claimed) throw new Error("expected a successful claim");
    await pgPool().query(`UPDATE agent_wakeups SET lease_expires_at = NOW() - INTERVAL '1 minute' WHERE id = $1`, [
      claim.claimed.id,
    ]);

    const abandoned = await abandonExpiredWakeupLeases();
    expect(abandoned).toBeGreaterThanOrEqual(1);
    const row = await readWakeup(claim.claimed.id);
    expect(row.result).toBe("abandoned");
    expect(row.completed_at).not.toBeNull();

    // The one-inflight slot is free again: a fresh idle wakeup for the SAME agent is claimable.
    await seedIdleWakeup(agent);
    const second = await claimNextWakeup({
      claimToken: nextId("token"),
      leaseMs: 600_000,
      generalCap: 50,
      playgroundCap: 50,
    });
    if (second.candidates !== 1) throw new Error("expected the freed slot to be claimable again");
    expect(second.claimed).not.toBeNull();
  });

  it("terminalizes a disabled agent's pending wakeup as autonomy_disabled, leaving an enabled agent's alone", async () => {
    const disabledAgent = await seedAgent();
    await seedLoopState(disabledAgent, false);
    await seedIdleWakeup(disabledAgent);

    const enabledAgent = await seedAgent();
    await seedLoopState(enabledAgent, true);
    await seedIdleWakeup(enabledAgent);

    await terminalizeDisabledAgentWakeups();

    const { rows: disabledRows } = await pgPool().query(
      `SELECT result, completed_at FROM agent_wakeups WHERE agent_id = $1`,
      [disabledAgent]
    );
    expect(disabledRows[0].result).toBe("autonomy_disabled");
    expect(disabledRows[0].completed_at).not.toBeNull();

    const { rows: enabledRows } = await pgPool().query(
      `SELECT result, completed_at FROM agent_wakeups WHERE agent_id = $1`,
      [enabledAgent]
    );
    expect(enabledRows[0].result).toBeNull();
    expect(enabledRows[0].completed_at).toBeNull();
  });
});

describe("the execution guard — a real FOR SHARE lock against a real disable", () => {
  it("passes for an enabled agent with a live claim, and its comment lands with an event", async () => {
    const author = await seedAgent();
    const commenter = await seedAgent();
    await seedLoopState(commenter, true);
    const { postId } = await seedGroupAndPost(author);
    await seedIdleWakeup(commenter);
    const claim = await claimNextWakeup({
      claimToken: nextId("token"),
      leaseMs: 600_000,
      generalCap: 50,
      playgroundCap: 50,
    });
    if (claim.candidates !== 1 || !claim.claimed) throw new Error("expected a successful claim");

    const guard: ExecutionGuard = {
      agentId: commenter,
      wakeupId: claim.claimed.id,
      claimToken: claim.claimed.claimToken!,
    };
    const outcome = await createCommentWithOutcome(postId, commenter, "guarded reply", undefined, [], guard);
    expect(outcome.guardPassed).toBe(true);
    expect(outcome.comment).not.toBeNull();
  });

  it("refuses — no comment, no event — once the agent is disabled before the guarded statement runs", async () => {
    const author = await seedAgent();
    const commenter = await seedAgent();
    await seedLoopState(commenter, true);
    const { postId } = await seedGroupAndPost(author);
    await seedIdleWakeup(commenter);
    const claim = await claimNextWakeup({
      claimToken: nextId("token"),
      leaseMs: 600_000,
      generalCap: 50,
      playgroundCap: 50,
    });
    if (claim.candidates !== 1 || !claim.claimed) throw new Error("expected a successful claim");

    // The human disables autonomy AFTER the claim (and its lease renewal, in a real tick) but
    // BEFORE the guarded mutation reaches its statement — the exact gap the plan names.
    await setEnabled(commenter, false);

    const guard: ExecutionGuard = {
      agentId: commenter,
      wakeupId: claim.claimed.id,
      claimToken: claim.claimed.claimToken!,
    };
    const before = await pgPool().query(`SELECT count(*)::int AS n FROM comments WHERE author_id = $1`, [commenter]);
    const outcome = await createCommentWithOutcome(postId, commenter, "should not land", undefined, [], guard);
    expect(outcome.guardPassed).toBe(false);
    expect(outcome.comment).toBeNull();
    const after = await pgPool().query(`SELECT count(*)::int AS n FROM comments WHERE author_id = $1`, [commenter]);
    expect(after.rows[0].n).toBe(before.rows[0].n);
  });

  it("refuses once the claim token no longer matches (superseded by a re-arm)", async () => {
    const author = await seedAgent();
    const commenter = await seedAgent();
    await seedLoopState(commenter, true);
    const { postId } = await seedGroupAndPost(author);
    await seedIdleWakeup(commenter);
    const claim = await claimNextWakeup({
      claimToken: nextId("token"),
      leaseMs: 600_000,
      generalCap: 50,
      playgroundCap: 50,
    });
    if (claim.candidates !== 1 || !claim.claimed) throw new Error("expected a successful claim");

    // A stale token — as if a re-arm had cleared and reassigned it.
    const guard: ExecutionGuard = {
      agentId: commenter,
      wakeupId: claim.claimed.id,
      claimToken: "stale-superseded-token",
    };
    const outcome = await createCommentWithOutcome(postId, commenter, "should not land either", undefined, [], guard);
    expect(outcome.guardPassed).toBe(false);
    expect(outcome.comment).toBeNull();
  });
});

/**
 * u6 stitch item 1 (d): the SAME guard, on the playground turn. `submitPlaygroundActionGated` is the
 * `playground_round` reason's terminal mutation, so without this the kill switch was a
 * statement-level guarantee for social actions and a racing check for playground ones.
 *
 * Everything except the guard is deliberately admissible here — active session, current round, active
 * participant, no duplicate, no resolution lease — so a refusal can only have come from the guard.
 */
describe("the execution guard — the playground turn (u6 stitch)", () => {
  async function claimFor(agentId: string): Promise<ExecutionGuard> {
    await seedIdleWakeup(agentId);
    const claim = await claimNextWakeup({
      claimToken: nextId("token"),
      leaseMs: 600_000,
      generalCap: 50,
      playgroundCap: 50,
    });
    if (claim.candidates !== 1 || !claim.claimed) throw new Error("expected a successful claim");
    return { agentId, wakeupId: claim.claimed.id, claimToken: claim.claimed.claimToken! };
  }

  it("passes for an enabled agent with a live claim — the action row lands", async () => {
    const actor = await seedAgent();
    await seedLoopState(actor, true);
    const sessionId = await seedPlaygroundSession(actor);
    const guard = await claimFor(actor);

    const outcome = await submitPlaygroundActionGated(
      { id: nextId("action"), sessionId, agentId: actor, round: 1, content: "a guarded move" },
      [],
      guard
    );
    expect(outcome.ok).toBe(true);
    expect(await countActions(sessionId)).toBe(1);
  });

  it("refuses — no action row, no event — once the agent is disabled before the guarded statement runs", async () => {
    const actor = await seedAgent();
    await seedLoopState(actor, true);
    const sessionId = await seedPlaygroundSession(actor);
    const guard = await claimFor(actor);
    // The human disables autonomy AFTER the claim (and its lease renewal, in a real tick) but BEFORE
    // the guarded mutation reaches its statement — the exact gap the plan names.
    await setEnabled(actor, false);

    const { rows: before } = await pgPool().query(`SELECT count(*)::int AS n FROM events`);
    const outcome = await submitPlaygroundActionGated(
      { id: nextId("action"), sessionId, agentId: actor, round: 1, content: "should not land" },
      [
        {
          kind: "playground.action_submitted",
          actorAgentId: actor,
          subjectType: "playground_session",
          subjectId: sessionId,
          schoolId: null,
          idemKey: `u6pr_guard_refused:${sessionId}:1:${actor}`,
          payload: { session_id: sessionId, round: 1, agent_id: actor },
        },
      ],
      guard
    );
    expect(outcome).toEqual({ ok: false, reason: "execution_guard_failed" });
    expect(await countActions(sessionId)).toBe(0);
    const { rows: after } = await pgPool().query(`SELECT count(*)::int AS n FROM events`);
    expect(after[0].n).toBe(before[0].n);
  });

  it("refuses once the claim token no longer matches (superseded by a re-arm)", async () => {
    const actor = await seedAgent();
    await seedLoopState(actor, true);
    const sessionId = await seedPlaygroundSession(actor);
    const guard = await claimFor(actor);

    const outcome = await submitPlaygroundActionGated(
      { id: nextId("action"), sessionId, agentId: actor, round: 1, content: "should not land either" },
      [],
      { ...guard, claimToken: "stale-superseded-token" }
    );
    expect(outcome).toEqual({ ok: false, reason: "execution_guard_failed" });
    expect(await countActions(sessionId)).toBe(0);
  });

  it("a caller that supplies NO guard is unaffected — the REST/tool path still writes", async () => {
    const actor = await seedAgent();
    // No `agent_loop_state` row at all: an ordinary REST caller has never had one, and the guard
    // fragment must not be rendered for them (it would refuse every such call).
    const sessionId = await seedPlaygroundSession(actor);
    const outcome = await submitPlaygroundActionGated({
      id: nextId("action"),
      sessionId,
      agentId: actor,
      round: 1,
      content: "an unguarded REST move",
    });
    expect(outcome.ok).toBe(true);
    expect(await countActions(sessionId)).toBe(1);
  });
});

/**
 * u6 stitch item 4 (b) — P2.2's retention policy, the wakeup queue's share, against a real database.
 *
 * Memory-mode semantics live in `src/__tests__/lib/store/wakeups/claim.test.ts`. What only Postgres
 * shows: the statement PARSES (its `make_interval(days => …)` and its bounded candidate subquery),
 * and the exclusion holds against real rows rather than a JS filter.
 */
describe("pruneTerminalWakeups — the retention duty against real rows", () => {
  it("deletes a completed row past the window and leaves the pending, claimed and recent ones", async () => {
    const agent = await seedAgent();
    await seedLoopState(agent, true);

    // Completed 45 days ago — the only row this duty may take.
    await seedIdleWakeup(agent);
    const claim = await claimNextWakeup({
      claimToken: nextId("token"),
      leaseMs: 600_000,
      generalCap: 50,
      playgroundCap: 50,
    });
    if (claim.candidates !== 1 || !claim.claimed) throw new Error("expected a successful claim");
    const staleId = claim.claimed.id;
    await completeWakeup(staleId, claim.claimed.claimToken!, "acted");
    await pgPool().query(
      `UPDATE agent_wakeups SET completed_at = now() - INTERVAL '45 days' WHERE id = $1`,
      [staleId]
    );

    // Completed just now — inside the window.
    await enqueueWakeup({
      agentId: agent,
      reason: "comment_on_my_post",
      eventId: nextEventId(),
      payload: { run: RUN },
      delivery: "internal",
    });
    const second = await claimNextWakeup({
      claimToken: nextId("token"),
      leaseMs: 600_000,
      generalCap: 50,
      playgroundCap: 50,
    });
    if (second.candidates !== 1 || !second.claimed) throw new Error("expected a second successful claim");
    const recentId = second.claimed.id;
    await completeWakeup(recentId, second.claimed.claimToken!, "acted");

    // Pending, and deliberately backdated far past the window: age is not this duty's predicate.
    const pendingAgent = await seedAgent();
    await seedIdleWakeup(pendingAgent);
    const { rows: pendingRows } = await pgPool().query<{ id: string }>(
      `SELECT id FROM agent_wakeups WHERE agent_id = $1`,
      [pendingAgent]
    );
    const pendingId = Number(pendingRows[0].id);
    await pgPool().query(`UPDATE agent_wakeups SET due_at = now() - INTERVAL '99 days' WHERE id = $1`, [
      pendingId,
    ]);

    // Claimed and long past its lease — still owns its agent's one-inflight slot.
    const claimedAgent = await seedAgent();
    await seedLoopState(claimedAgent, true);
    await seedIdleWakeup(claimedAgent);
    const third = await claimNextWakeup({
      claimToken: nextId("token"),
      leaseMs: 600_000,
      generalCap: 50,
      playgroundCap: 50,
    });
    if (third.candidates !== 1 || !third.claimed) throw new Error("expected a third successful claim");
    const claimedId = third.claimed.id;
    await pgPool().query(
      `UPDATE agent_wakeups SET claimed_at = now() - INTERVAL '99 days',
                                lease_expires_at = now() - INTERVAL '98 days' WHERE id = $1`,
      [claimedId]
    );

    expect(await pruneTerminalWakeups(30, 1000)).toBe(1);

    const { rows: survivors } = await pgPool().query<{ id: string }>(
      `SELECT id FROM agent_wakeups WHERE id = ANY($1::bigint[]) ORDER BY id`,
      [[staleId, recentId, pendingId, claimedId]]
    );
    expect(survivors.map((r) => Number(r.id)).sort((a, b) => a - b)).toEqual(
      [recentId, pendingId, claimedId].sort((a, b) => a - b)
    );
  });
});
