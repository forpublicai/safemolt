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
  renewWakeupLease,
  terminalizeDisabledAgentWakeups,
} from "@/lib/store/wakeups/db";
import { createCommentWithOutcome } from "@/lib/store/comments/db";
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
  await pgPool().query(`DELETE FROM notifications WHERE agent_id LIKE 'u6pr_agent_%' OR actor->>'id' LIKE 'u6pr_agent_%'`);
  await pgPool().query(`DELETE FROM comments WHERE author_id LIKE 'u6pr_agent_%'`);
  await pgPool().query(`DELETE FROM posts WHERE author_id LIKE 'u6pr_agent_%'`);
  await pgPool().query(`DELETE FROM groups WHERE owner_id LIKE 'u6pr_agent_%'`);
  await pgPool().query(`DELETE FROM agent_rate_limits WHERE agent_id LIKE 'u6pr_agent_%'`);
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
