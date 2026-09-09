/**
 * M11b lane R (P6.2) `[integration]` — reactions against the real database.
 *
 * What only a database can show, and what this file is for:
 *  - **the FOR SHARE subject lock**: a reaction attempted after the subject's tombstone lands
 *    must see `deleted_at IS NOT NULL` and refuse, and a reaction that lands first must be cleaned
 *    up by `deletePost`'s batch in the SAME transaction as the tombstone;
 *  - **the ON CONFLICT DO NOTHING / under-cap gate under real concurrency**: N racing duplicate adds
 *    must leave exactly one row, one event and one quota increment — a property no single-threaded
 *    test can observe;
 *  - **the delayed-consume window**: a `reaction.added` event that drains after its subject is gone
 *    must produce no notification and still receipt cleanly, never wedging the floor;
 *  - **rate-limit parity across the real route and the real tool executor**, and that DELETE stays
 *    uncapped through both even once the cap has bound.
 *
 * @jest-environment node
 */
// `jest.mock` (module-registry replacement), not `jest.spyOn`: this file's compiled ESM exports
// are non-configurable, so `spyOn` cannot redefine `memoryIngestFanoutCap` in place. The factory
// wraps the real implementation in a `jest.fn`, so every OTHER call in this suite is unaffected.
jest.mock("@/lib/memory/fanout-cap", () => {
  const actual = jest.requireActual("@/lib/memory/fanout-cap");
  return { ...actual, memoryIngestFanoutCap: jest.fn(actual.memoryIngestFanoutCap) };
});

import { POST as POST_POST_REACTION, DELETE as DELETE_POST_REACTION } from "@/app/api/v1/posts/[id]/reactions/route";
import { createComment } from "@/lib/actions/comments";
import { createPost, deletePost } from "@/lib/actions/posts";
import { addReaction, removeReaction } from "@/lib/actions/reactions";
import { executors } from "@/lib/agent-tools/definitions/reactions";
import { notificationsConsumer } from "@/lib/events/consumers/notifications";
import { eventConsumers } from "@/lib/events/consumers/registry";
import { memoryIngestFanoutCap } from "@/lib/memory/fanout-cap";
import { createReactionNotificationIdempotent } from "@/lib/store";
import { addReaction as dbAddReaction, removeReaction as dbRemoveReaction } from "@/lib/store/reactions/db";
import { getEventById } from "@/lib/store/events/db";
import { drainEventConsumer } from "@/lib/store/events/drain-db";
import { secondsUntilUtcMidnight } from "@/lib/store/rate-limit-windows";
import { claimNextWakeup, completeWakeup, enqueueWakeup } from "@/lib/store/wakeups/db";
import type { ExecutionGuard } from "@/lib/store/execution-guard";
import type { StoredAgent, StoredEvent } from "@/lib/store-types";

import { withMiddlewareHeaders } from "../helpers/middleware-headers";
import { activateRealConsumers } from "./helpers/activate-consumers";
import { pidOf, raceAgainstHeldLock, rejections, runConcurrently, waitForWaiter } from "./helpers/concurrency";
import { closeIntegrationConnections, pgClient, pgPool } from "./helpers/db";

const RUN = `${Date.now().toString(36)}_${Math.floor(Math.random() * 1e6).toString(36)}`;
let seq = 0;
const nextId = (kind: string) => `b1r_${kind}_${RUN}_${(seq += 1)}`;

const LONG_BODY =
  "A body long enough to survive the memory chunker's minimum chunk length, which is fifty characters.";

let baselineEventId = 0;

async function seedAgent(): Promise<StoredAgent> {
  const id = nextId("agent");
  const apiKey = `b1r_key_${id}`;
  await pgPool().query(
    `INSERT INTO agents (id, name, description, api_key, points, vote_points, evaluation_points,
                         legacy_unattributed_points, follower_count, is_claimed, created_at, is_vetted)
     VALUES ($1, $2, '', $3, 0, 0, 0, 0, 0, false, NOW(), true)`,
    [id, `${id}_named`, apiKey]
  );
  return { id, name: `${id}_named`, apiKey, isVetted: true } as StoredAgent;
}

/** A group whose membership is written to both places `isGroupMember`/the audience read look. */
async function seedGroup(ownerId: string): Promise<string> {
  const id = nextId("group");
  await pgPool().query(
    `INSERT INTO groups (id, name, display_name, description, owner_id, member_ids, moderator_ids,
                         pinned_post_ids, created_at)
     VALUES ($1, $1, $1, '', $2, $3::jsonb, '[]'::jsonb, '[]'::jsonb, NOW())`,
    [id, ownerId, JSON.stringify([ownerId])]
  );
  await pgPool().query(
    `INSERT INTO group_members (agent_id, group_id, joined_at) VALUES ($1, $2, NOW())
     ON CONFLICT DO NOTHING`,
    [ownerId, id]
  );
  return id;
}

async function clearRateWindow(agentId: string): Promise<void> {
  await pgPool().query(`DELETE FROM agent_rate_limits WHERE agent_id = $1`, [agentId]);
}

async function maxEventId(): Promise<number> {
  const { rows } = await pgPool().query<{ id: string }>(`SELECT COALESCE(max(id), 0) AS id FROM events`);
  return Number(rows[0].id);
}

async function eventsSince(marker: number): Promise<StoredEvent[]> {
  const { rows } = await pgPool().query<{ id: string }>(`SELECT id FROM events WHERE id > $1 ORDER BY id`, [marker]);
  return Promise.all(rows.map(async (row) => (await getEventById(Number(row.id)))!));
}

async function reactionRows(subjectType: "post" | "comment", subjectId: string): Promise<unknown[]> {
  const { rows } = await pgPool().query(
    `SELECT agent_id, emoji FROM content_reactions WHERE subject_type = $1 AND subject_id = $2`,
    [subjectType, subjectId]
  );
  return rows;
}

/** Post plus, for a comment subject, one live comment on it. Returns the id to react against. */
async function makeSubject(
  surface: "post" | "comment",
  author: StoredAgent,
  group: string
): Promise<{ subjectId: string; postId: string }> {
  await clearRateWindow(author.id);
  const created = await createPost({ agent: author, groupName: group, title: nextId("title"), content: LONG_BODY });
  if (!created.ok) throw new Error("fixture post refused");
  const postId = created.data.post.id;
  if (surface === "post") return { subjectId: postId, postId };
  const commented = await createComment({ agent: author, postId, content: "a fixture comment" });
  if (!commented.ok) throw new Error("fixture comment refused");
  return { subjectId: commented.data.comment.id, postId };
}

function reactionRequest(caller: StoredAgent, subjectId: string, method: "POST" | "DELETE", emoji: string): Request {
  return new Request(
    `https://safemolt.com/api/v1/posts/${subjectId}/reactions`,
    withMiddlewareHeaders({
      method,
      headers: { Authorization: `Bearer ${caller.apiKey}`, "content-type": "application/json" },
      body: JSON.stringify({ emoji }),
    })
  );
}
const routeParams = (id: string) => ({ params: Promise.resolve({ id }) });

/** A real claimed wakeup, for the execution-guard tests — mirrors `m11-2-u6-pulse-runner.test.ts`. */
async function claimGuardFor(agentId: string): Promise<ExecutionGuard> {
  await pgPool().query(
    `INSERT INTO agent_loop_state (agent_id, enabled) VALUES ($1, true)
     ON CONFLICT (agent_id) DO UPDATE SET enabled = true`,
    [agentId]
  );
  const created = await enqueueWakeup({ agentId, reason: "idle", eventId: null, payload: {}, delivery: "internal" });
  if (!created.created) throw new Error("expected a fresh idle wakeup");
  const claim = await claimNextWakeup({ claimToken: nextId("token"), leaseMs: 600_000, generalCap: 50, playgroundCap: 50 });
  if (claim.candidates !== 1 || !claim.claimed) throw new Error("expected a successful claim");
  return { agentId, wakeupId: claim.claimed.id, claimToken: claim.claimed.claimToken! };
}

beforeAll(async () => {
  baselineEventId = await maxEventId();
});

afterAll(async () => {
  const like = `b1r_%_${RUN}%`;
  const consumerNames = eventConsumers.map((c) => c.name);
  await pgPool().query(`DELETE FROM event_receipts WHERE consumer = ANY($1::text[])`, [consumerNames]);
  await pgPool().query(`DELETE FROM event_consumer_failures WHERE consumer = ANY($1::text[])`, [consumerNames]);
  await pgPool().query(`DELETE FROM event_dead_letters WHERE consumer = ANY($1::text[])`, [consumerNames]);
  await pgPool().query(`DELETE FROM event_consumers WHERE consumer = ANY($1::text[])`, [consumerNames]);
  await pgPool().query(`DELETE FROM ingest_progress WHERE event_id > $1`, [baselineEventId]);
  await pgPool().query(`DELETE FROM ingest_event_claims WHERE event_id > $1`, [baselineEventId]);
  await pgPool().query(`DELETE FROM events WHERE id > $1`, [baselineEventId]);
  await pgPool().query(`DELETE FROM content_reactions WHERE agent_id LIKE $1`, [like]);
  await pgPool().query(`DELETE FROM notifications WHERE agent_id LIKE $1`, [like]);
  await pgPool().query(`DELETE FROM agent_rate_limits WHERE agent_id LIKE $1`, [like]);
  await pgPool().query(`DELETE FROM agent_wakeups WHERE agent_id LIKE $1`, [like]);
  await pgPool().query(`DELETE FROM agent_loop_state WHERE agent_id LIKE $1`, [like]);
  await pgPool().query(
    `DELETE FROM comments WHERE author_id LIKE $1 OR post_id IN (SELECT id FROM posts WHERE author_id LIKE $1)`,
    [like]
  );
  await pgPool().query(`DELETE FROM posts WHERE author_id LIKE $1 OR group_id LIKE $1`, [like]);
  await pgPool().query(`DELETE FROM groups WHERE id LIKE $1`, [like]);
  await pgPool().query(`DELETE FROM agents WHERE id LIKE $1`, [like]);
  await closeIntegrationConnections();
});

/** The tombstone `deletePost`'s own batch element writes, held open on a dedicated connection. */
const TOMBSTONE_SQL = `
  UPDATE posts SET deleted_at = NOW(), deleted_by_agent_id = $2, deleted_karma_reversed_at = NOW()
  WHERE id = $1 AND deleted_at IS NULL
`;

describe.each(["post", "comment"] as const)("%s reactions vs deletePost — both orderings", (surface) => {
  // Activated here (idempotent, see `activateRealConsumers`) rather than only in the
  // delayed-consume describe below, because "reaction-first" now drains too (F1, F4).
  beforeAll(async () => {
    await activateRealConsumers();
  });

  it("delete-first (real overlapping transaction): addReaction blocks on the tombstone, then is not_found", async () => {
    const author = await seedAgent();
    const reactor = await seedAgent();
    const group = await seedGroup(author.id);
    const { subjectId, postId } = await makeSubject(surface, author, group);
    const marker = await maxEventId();

    // The tombstone is held OPEN — not committed — so `addReaction` genuinely contends for the
    // post lock rather than racing a delete that already finished (codex round 1, F4).
    const race = await raceAgainstHeldLock({
      hold: async (holder) => {
        await holder.query(TOMBSTONE_SQL, [postId, author.id]);
      },
      contend: () => addReaction({ agent: reactor, subjectType: surface, subjectId, emoji: "👍" }),
      contenderMarker: "race:b1r-add-post-lock",
    });

    expect(race.observedBlocked).toBe(true);
    expect(race.result.ok).toBe(false);
    if (!race.result.ok) expect(race.result.code).toBe("not_found");
    expect(await eventsSince(marker)).toEqual([]);
    expect(await reactionRows(surface, subjectId)).toEqual([]);
  });

  it("delete-first (real overlapping transaction): removeReaction against a live row blocks on the tombstone, then is not_found and leaves the row untouched", async () => {
    const author = await seedAgent();
    const reactor = await seedAgent();
    const group = await seedGroup(author.id);
    const { subjectId, postId } = await makeSubject(surface, author, group);
    expect((await addReaction({ agent: reactor, subjectType: surface, subjectId, emoji: "🎉" })).ok).toBe(true);
    const marker = await maxEventId();

    const race = await raceAgainstHeldLock({
      hold: async (holder) => {
        await holder.query(TOMBSTONE_SQL, [postId, author.id]);
      },
      contend: () => removeReaction({ agent: reactor, subjectType: surface, subjectId, emoji: "🎉" }),
      contenderMarker: "race:b1r-remove-post-lock",
    });

    expect(race.observedBlocked).toBe(true);
    expect(race.result.ok).toBe(false);
    if (!race.result.ok) expect(race.result.code).toBe("not_found");
    expect(await eventsSince(marker)).toEqual([]);
    // Mutation check: dropping F7's `EXISTS (SELECT 1 FROM subject)` gate lets this DELETE match
    // the still-physically-present row once the tombstone commits, reporting "removed" instead.
    expect(await reactionRows(surface, subjectId)).toHaveLength(1);
  });

  it("reaction-first: deletePost genuinely BLOCKS behind an uncommitted reaction, then cleans up the reaction and a prior drained notification (codex round 3, F3)", async () => {
    const author = await seedAgent();
    const reactor = await seedAgent();
    const secondReactor = await seedAgent();
    const group = await seedGroup(author.id);
    const { subjectId, postId } = await makeSubject(surface, author, group);

    // Establish and drain a real reaction+notification FIRST — the effect the old sequential
    // version of this test already covered. This test's own job is proving deletePost actually
    // WAITS on a still-uncommitted reaction, which a sequential call can never demonstrate
    // (codex round 3, finding 3).
    const marker = await maxEventId();
    expect((await addReaction({ agent: reactor, subjectType: surface, subjectId, emoji: "👍" })).ok).toBe(true);
    expect((await eventsSince(marker)).map((e) => e.kind)).toEqual(["reaction.added"]);
    await drainEventConsumer(notificationsConsumer, { batchSize: 200 });
    const { rows: notifBefore } = await pgPool().query(
      `SELECT 1 FROM notifications WHERE metadata->>'subject_id' = $1 AND metadata->>'subject_type' = $2`,
      [subjectId, surface]
    );
    expect(notifBefore).toHaveLength(1);

    // A SECOND reactor's add is held OPEN (uncommitted) on a raw connection — `addReaction`'s own
    // `sql.transaction` cannot be paused mid-flight from JS, so this reproduces its exact lock
    // shape (subject FOR SHARE, then the insert) to prove `deletePost` genuinely queues behind it.
    // `d1:post-delete-lock` marks `deletePost`'s own FIRST statement (`posts/db.ts`), the one that
    // must wait for our held FOR SHARE.
    const race = await raceAgainstHeldLock({
      hold: async (holder) => {
        await holder.query(
          surface === "post"
            ? `SELECT id FROM posts WHERE id = $1 AND deleted_at IS NULL FOR SHARE`
            : `SELECT p.id FROM posts p WHERE p.id = (SELECT post_id FROM comments WHERE id = $1) AND p.deleted_at IS NULL FOR SHARE`,
          [surface === "post" ? postId : subjectId]
        );
        await holder.query(
          `INSERT INTO content_reactions (agent_id, subject_type, subject_id, emoji, created_at) VALUES ($1, $2, $3, $4, NOW())`,
          [secondReactor.id, surface, subjectId, "🎉"]
        );
      },
      contend: () => deletePost({ agent: author, postId }),
      contenderMarker: "d1:post-delete-lock",
    });

    expect(race.observedBlocked).toBe(true);
    expect(race.result.ok).toBe(true);

    // Both cleanup effects: the reaction rows (including the one committed only once the hold
    // released) and the first reaction's drained notification are gone, cleaned by the SAME
    // transaction as the tombstone.
    expect(await reactionRows(surface, subjectId)).toEqual([]);
    const { rows: notifAfter } = await pgPool().query(
      `SELECT 1 FROM notifications WHERE metadata->>'subject_id' = $1 AND metadata->>'subject_type' = $2`,
      [subjectId, surface]
    );
    expect(notifAfter).toEqual([]);
  });

  it("F2: the reaction notification writer itself blocks on a held tombstone, then refuses", async () => {
    const author = await seedAgent();
    const reactor = await seedAgent();
    const group = await seedGroup(author.id);
    const { subjectId, postId } = await makeSubject(surface, author, group);

    // Exercises `reactionNotificationSelectSql`'s OWN lock/gate directly, independent of
    // `addReaction` — codex round 2 finding 2: the prior suite only proved addReaction blocked.
    const race = await raceAgainstHeldLock({
      hold: async (holder) => {
        await holder.query(TOMBSTONE_SQL, [postId, author.id]);
      },
      contend: () =>
        createReactionNotificationIdempotent({
          dedupKey: `${nextId("dedup")}`,
          subjectType: surface,
          subjectId,
          emoji: "👍",
          actorAgentId: reactor.id,
          createdAt: new Date().toISOString(),
        }),
      contenderMarker: "race:m11-2-notification-locked-target",
    });

    expect(race.observedBlocked).toBe(true);
    // Mutation check: dropping `live_post`'s `FOR SHARE` gate lets this insert a notification for a
    // subject the tombstone (committed by the time the write resumes) already removed.
    expect(race.result).toBeNull();
  });

  it("F2: a tombstone failure after the reaction cleanup element ran rolls back the whole delete, including the cleanup", async () => {
    const author = await seedAgent();
    const reactor = await seedAgent();
    const group = await seedGroup(author.id);
    const { subjectId, postId } = await makeSubject(surface, author, group);
    expect((await addReaction({ agent: reactor, subjectType: surface, subjectId, emoji: "👍" })).ok).toBe(true);
    expect(await reactionRows(surface, subjectId)).toHaveLength(1);

    // `deletePost`'s LAST batch element (the tombstone) binds this cap into its own `LIMIT $3::int`
    // (element 6b, the reaction cleanup, runs immediately before it in the SAME transaction). An
    // out-of-int4-range value is documented in `fanout-cap.ts` as the one thing that fails that
    // statement with a real `22003` — bypassing the function's own clamp is the only way to reach it.
    jest.mocked(memoryIngestFanoutCap).mockReturnValueOnce(Number.MAX_SAFE_INTEGER);
    await expect(deletePost({ agent: author, postId })).rejects.toMatchObject({ code: "22003" });

    // Mutation check: were the cleanup and the tombstone two separately auto-committed statements
    // instead of one transaction, the cleanup above would have already committed and this would be
    // empty; instead the whole batch rolled back and the reaction row is back.
    expect(await reactionRows(surface, subjectId)).toHaveLength(1);
    const { rows } = await pgPool().query(`SELECT deleted_at FROM posts WHERE id = $1`, [postId]);
    expect(rows[0].deleted_at).toBeNull();
  });
});

describe("concurrent duplicate reacts", () => {
  it("N racing adds of the exact same (agent, subject, emoji) leave one row, one event, one quota increment", async () => {
    const author = await seedAgent();
    const reactor = await seedAgent();
    const group = await seedGroup(author.id);
    const { subjectId } = await makeSubject("post", author, group);
    const marker = await maxEventId();

    const N = 6;
    const outcomes = await runConcurrently(
      Array.from({ length: N }, () => () =>
        addReaction({ agent: reactor, subjectType: "post", subjectId, emoji: "👍" })
      )
    );
    // Every call resolves (refusals are `ActionResult`, not a rejection); the loser(s) come back
    // `already_reacted` rather than throwing.
    expect(rejections(outcomes)).toEqual([]);
    expect(outcomes.filter((o) => o.ok && o.value.ok)).toHaveLength(1);

    // Mutation check: if the insert's `ON CONFLICT DO NOTHING` / `under_cap` gate were removed, more
    // than one of these racing calls could land a row, and `content_reactions` would carry more than
    // one — instead exactly one survives, and the map is never empty.
    const rows = await reactionRows("post", subjectId);
    expect(rows).not.toEqual([]);
    expect(rows).toHaveLength(1);
    expect((await eventsSince(marker)).filter((e) => e.kind === "reaction.added")).toHaveLength(1);

    // Mutation check: if the `bump` CTE fired on every attempt instead of only `EXISTS (SELECT 1 FROM
    // inserted)`, `reaction_count` would read N instead of 1 — the quota would be charged once per
    // racing call rather than once per row actually written.
    const { rows: quota } = await pgPool().query<{ reaction_count: number }>(
      `SELECT reaction_count FROM agent_rate_limits WHERE agent_id = $1`,
      [reactor.id]
    );
    expect(quota[0].reaction_count).toBe(1);
  });

  it("F5: two identical requests contending on the rate row's COMMITTED lock never answer rate_limited — one added, one already_reacted (codex round 3)", async () => {
    const author = await seedAgent();
    const reactor = await seedAgent();
    const group = await seedGroup(author.id);
    const { subjectId } = await makeSubject("post", author, group);
    // Committed BEFORE the race (codex round 3, finding 5): an uncommitted seed insert blocks any
    // second writer trivially, whether or not the fix is present, so it proved nothing — reverting
    // to two separately auto-committed statements still passed the old version of this test (round
    // 2's own mutation-check said as much). Locking an ALREADY-COMMITTED row is a real, deterministic
    // contention both real callers' seed statements must genuinely wait on.
    await pgPool().query(
      `INSERT INTO agent_rate_limits (agent_id, reaction_count_date, reaction_count) VALUES ($1, CURRENT_DATE, 0)`,
      [reactor.id]
    );
    const prevLimit = process.env.REACTION_DAILY_LIMIT;
    process.env.REACTION_DAILY_LIMIT = "1";
    try {
      const race = await raceAgainstHeldLock({
        hold: async (holder) => {
          await holder.query("SELECT agent_id FROM agent_rate_limits WHERE agent_id = $1 FOR NO KEY UPDATE", [
            reactor.id,
          ]);
        },
        contend: () =>
          runConcurrently([
            () => addReaction({ agent: reactor, subjectType: "post", subjectId, emoji: "👍" }),
            () => addReaction({ agent: reactor, subjectType: "post", subjectId, emoji: "👍" }),
          ]),
        // No marker: the fixed shape blocks at the seed statement, but the mutation this test
        // guards against (the seed's lock dropped) moves the wait into the decisive statement's
        // `pre` CTE instead — both are the SAME row, held by the SAME connection.
      });

      expect(race.observedBlocked).toBe(true);
      expect(rejections(race.result)).toEqual([]);
      const codes = race.result.map((o) => {
        if (!o.ok) return "rejected";
        return o.value.ok ? "added" : o.value.code;
      });
      // Mutation check (recorded in the fix report): weakening the seed's lock so it no longer
      // conflicts with the held row lets both real calls proceed straight into the decisive
      // statement, where the loser's `existing` CTE keeps its pre-wait snapshot while `pre` is
      // refreshed by the wait — reporting the wrong refusal, `rate_limited`, instead of the right
      // one, `already_reacted`.
      expect(codes.sort()).toEqual(["added", "already_reacted"]);
    } finally {
      if (prevLimit === undefined) delete process.env.REACTION_DAILY_LIMIT;
      else process.env.REACTION_DAILY_LIMIT = prevLimit;
    }
  });

  it("F6: a decisive-statement failure rolls back the seed, in the same transaction", async () => {
    const author = await seedAgent();
    const reactor = await seedAgent();
    const group = await seedGroup(author.id);
    const { subjectId } = await makeSubject("post", author, group);

    // `dailyLimit` binds unquoted into statement 3's `current_count < $4`; NaN has no valid integer
    // text form, so Postgres raises a real error there — after statement 2 (the seed) has already
    // run in the same open transaction.
    await expect(
      dbAddReaction({ agentId: reactor.id, subjectType: "post", subjectId, emoji: "👍", dailyLimit: NaN })
    ).rejects.toBeTruthy();

    // Mutation check: were the seed and the decisive statement two separately auto-committed calls
    // instead of one `sql.transaction`, the seed would have survived this failure and this would
    // find a row.
    const { rows } = await pgPool().query(`SELECT 1 FROM agent_rate_limits WHERE agent_id = $1`, [reactor.id]);
    expect(rows).toEqual([]);
  });
});

describe("F1: the seed's rate-row lock does not deadlock with a withdrawal's FK check", () => {
  it("does NOT block a concurrent FOR KEY SHARE — the mode a withdrawal's own RI check takes", async () => {
    const author = await seedAgent();
    const reactor = await seedAgent();
    const group = await seedGroup(author.id);
    const { subjectId } = await makeSubject("post", author, group);
    // A pre-existing, committed row is what makes a real withdrawal's RI check need to LOCK this
    // row at all (a row that does not exist yet is simply invisible to it, never blocking).
    expect((await addReaction({ agent: reactor, subjectType: "post", subjectId, emoji: "🎉" })).ok).toBe(true);
    const { subjectId: secondSubject } = await makeSubject("post", author, group);

    // codex round 2, finding 1: `pre`'s old `FOR UPDATE` conflicts with `FOR KEY SHARE`, so a
    // reaction holding it while a withdrawal holds the actor's `agents` row (wanting THIS row via
    // its `agent_rate_limits` FK check) deadlocked (40P01). `FOR NO KEY UPDATE` does not conflict.
    const race = await raceAgainstHeldLock({
      hold: async (holder) => {
        await holder.query("SELECT agent_id FROM agent_rate_limits WHERE agent_id = $1 FOR KEY SHARE", [reactor.id]);
      },
      contend: () => addReaction({ agent: reactor, subjectType: "post", subjectId: secondSubject, emoji: "👍" }),
      // `pre` (statement 3), not the seed (statement 2): the seed's own no-op update is already a
      // non-key lock either way, so the deadlock's actual site is `pre`'s explicit lock mode.
      contenderMarker: "race:b1r-pre-lock",
    });

    // Mutation check: reverting `pre` to `FOR UPDATE` (and the seed's no-op back to the key column)
    // flips this to `true` — the reaction queues behind the held FOR KEY SHARE instead of proceeding.
    expect(race.observedBlocked).toBe(false);
    expect(race.result.ok).toBe(true);
  });
});

describe("F2: a self-reaction with no existing rate row does not deadlock with a withdrawal (codex round 3)", () => {
  it("addReaction queues behind a held withdrawal post-lock and both sides resolve without a 40P01", async () => {
    const author = await seedAgent();
    const dummyOwner = await seedAgent();
    const group = await seedGroup(author.id);
    const { postId } = await makeSubject("post", author, group);
    // No prior `agent_rate_limits` row: the seed's insert is genuinely NEW, so its FK check
    // actually takes the `agents` lock the finding describes (an existing row's no-op update
    // takes a weaker lock that never triggers this).
    await clearRateWindow(author.id);
    // A withdrawal's own group-ownership refusal lives in the action layer, not in this raw
    // reproduction of its store-level SQL — reassign ownership so it cannot mask the lock-order
    // question this test is actually about.
    await pgPool().query(`UPDATE groups SET owner_id = $1 WHERE id = $2`, [dummyOwner.id, group]);

    const holder = await pgClient();
    let holderError: { code?: string } | null = null;
    let reactionSettled: { ok: true; value: Awaited<ReturnType<typeof addReaction>> } | { ok: false; error: { code?: string } };
    try {
      await holder.query("BEGIN");
      const holderPid = await pidOf(holder);
      // Mirrors `deleteAgent`'s own FIRST lock (`agents/db.ts`, `d1:agent-delete-post-lock`) —
      // taken and held BEFORE the reaction starts, so it is guaranteed to still be there to queue
      // behind.
      await holder.query(
        "/* d1:agent-delete-post-lock */ SELECT id FROM posts WHERE author_id = $1 ORDER BY id FOR UPDATE",
        [author.id]
      );

      const reactionPromise = addReaction({ agent: author, subjectType: "post", subjectId: postId, emoji: "👍" }).then(
        (value) => ({ ok: true as const, value }),
        (error: unknown) => ({ ok: false as const, error: error as { code?: string } })
      );

      // Only run withdrawal's remaining steps once the reaction is GENUINELY queued behind this
      // post lock — the exact interleaving codex round 3 finding 2 describes, not a guess at timing.
      await waitForWaiter(holderPid, "race:b1r-add-post-lock");
      await holder.query("SELECT id FROM comments WHERE author_id = $1 ORDER BY id FOR UPDATE", [author.id]);
      try {
        await holder.query("DELETE FROM agents WHERE id = $1", [author.id]);
      } catch (error) {
        holderError = error as { code?: string };
      }
      await holder.query(holderError ? "ROLLBACK" : "COMMIT");
      reactionSettled = await reactionPromise;
    } finally {
      await holder.end();
    }

    // Mutation check: reverting `addReaction` to seed-before-subject-lock (the pre-round-3 order)
    // lets its seed grab the `agents` FOR KEY SHARE lock before it ever reaches this post lock, so
    // withdrawal's DELETE then waits on THAT lock while the reaction waits on withdrawal's post
    // lock — a genuine 40P01 on one side (recorded in the fix report).
    expect(holderError?.code).not.toBe("40P01");
    expect(reactionSettled.ok ? undefined : reactionSettled.error.code).not.toBe("40P01");
    // The post still exists (this path never deletes it), so withdrawal's own FK check refuses it
    // — "one side refuses", exactly as the finding names — and the reaction completes normally.
    expect(holderError?.code).toBe("23503");
    expect(reactionSettled.ok && reactionSettled.value.ok).toBe(true);
  });
});

describe("F1: the execution guard gates the decisive statement (db, codex round 3)", () => {
  it("addReaction writes and emits with a live claim, then refuses execution_guard_failed once disabled before the write", async () => {
    const author = await seedAgent();
    const reactor = await seedAgent();
    const group = await seedGroup(author.id);
    const { subjectId } = await makeSubject("post", author, group);
    const guard = await claimGuardFor(reactor.id);
    const marker = await maxEventId();

    const ok = await dbAddReaction(
      { agentId: reactor.id, subjectType: "post", subjectId, emoji: "👍", dailyLimit: 200 },
      [],
      guard
    );
    expect(ok.outcome).toBe("added");
    // Completed so the idle dedup (one pending-or-claimed row per agent) admits a fresh claim.
    await completeWakeup(guard.wakeupId, guard.claimToken, "acted");

    const { subjectId: subjectId2 } = await makeSubject("post", author, group);
    const guard2 = await claimGuardFor(reactor.id);
    await pgPool().query(`UPDATE agent_loop_state SET enabled = false WHERE agent_id = $1`, [reactor.id]);

    const refused = await dbAddReaction(
      { agentId: reactor.id, subjectType: "post", subjectId: subjectId2, emoji: "👍", dailyLimit: 200 },
      [],
      guard2
    );

    // Mutation check: dropping `guard` from the `inserted` CTE's cross-joined `FROM` list lets
    // this insert and emit despite the disabled loop state.
    expect(refused.outcome).toBe("execution_guard_failed");
    expect(await reactionRows("post", subjectId2)).toEqual([]);
    expect((await eventsSince(marker)).filter((e) => e.kind === "reaction.added")).toEqual([]);
  });

  it("removeReaction refuses execution_guard_failed once disabled before the write, leaving the row", async () => {
    const author = await seedAgent();
    const reactor = await seedAgent();
    const group = await seedGroup(author.id);
    const { subjectId } = await makeSubject("post", author, group);
    expect((await dbAddReaction({ agentId: reactor.id, subjectType: "post", subjectId, emoji: "🎉", dailyLimit: 200 })).outcome).toBe("added");

    const guard = await claimGuardFor(reactor.id);
    await pgPool().query(`UPDATE agent_loop_state SET enabled = false WHERE agent_id = $1`, [reactor.id]);

    const result = await dbRemoveReaction(
      { agentId: reactor.id, subjectType: "post", subjectId, emoji: "🎉" },
      [],
      guard
    );

    expect(result.outcome).toBe("execution_guard_failed");
    expect(await reactionRows("post", subjectId)).toHaveLength(1);
  });
});

describe("F4: db validates events before any statement (parity with memory)", () => {
  it("addReaction throws on an invalid event even against a missing subject, rather than answering not_found", async () => {
    const reactor = await seedAgent();
    const badEvent = {
      kind: "not.a.real.kind",
      actorAgentId: reactor.id,
      subjectType: "post",
      subjectId: "no-such-post",
      payload: {},
    } as never;

    // `emitEventCtes` renders (and validates) before `sql!.transaction` is even called, so this
    // never reaches Postgres at all — matching memory's F4 fix, which validates before its own
    // subject check.
    await expect(
      dbAddReaction(
        { agentId: reactor.id, subjectType: "post", subjectId: "no-such-post", emoji: "👍", dailyLimit: 200 },
        [badEvent]
      )
    ).rejects.toThrow();
  });
});

describe("delayed-consume: a reaction.added event that drains after its subject is gone", () => {
  beforeAll(async () => {
    await activateRealConsumers();
  });

  it("produces no notification and still receipts cleanly", async () => {
    const author = await seedAgent();
    const reactor = await seedAgent();
    const group = await seedGroup(author.id);
    const { subjectId, postId } = await makeSubject("post", author, group);

    const marker = await maxEventId();
    expect((await addReaction({ agent: reactor, subjectType: "post", subjectId, emoji: "👍" })).ok).toBe(true);
    const [event] = await eventsSince(marker);
    expect(event.kind).toBe("reaction.added");

    // The subject is gone BEFORE the consumer ever looks at the event.
    expect((await deletePost({ agent: author, postId })).ok).toBe(true);

    await drainEventConsumer(notificationsConsumer, { batchSize: 200 });

    const { rows: notif } = await pgPool().query(
      `SELECT 1 FROM notifications WHERE metadata->>'subject_id' = $1 AND metadata->>'subject_type' = 'post'`,
      [subjectId]
    );
    // Mutation check: if `planReactionNotification`'s liveness re-check (`getPost(subjectId)`) were
    // removed and the consumer trusted the event's `author_id` blindly, this would find a row for a
    // post that no longer exists; instead the plan answers null and nothing is written.
    expect(notif).toEqual([]);

    const { rows: receipt } = await pgPool().query(
      `SELECT 1 FROM event_receipts WHERE event_id = $1 AND consumer = 'notifications'`,
      [event.id]
    );
    // A plan that returns null still has to receipt — otherwise the floor never advances past a
    // reaction on deleted content and the drain retries it forever.
    expect(receipt).toHaveLength(1);
  });
});

describe("rate limit through both surfaces", () => {
  it("a capped add through either surface writes nothing and emits nothing; DELETE stays uncapped through both", async () => {
    const prevLimit = process.env.REACTION_DAILY_LIMIT;
    process.env.REACTION_DAILY_LIMIT = "1";
    try {
      const author = await seedAgent();
      const group = await seedGroup(author.id);
      const routeReactor = await seedAgent();
      const toolReactor = await seedAgent();
      const routeFirst = await makeSubject("post", author, group);
      const routeSecond = await makeSubject("post", author, group);
      const toolFirst = await makeSubject("post", author, group);
      const toolSecond = await makeSubject("post", author, group);

      // ROUTE: first admitted, second capped.
      expect((await POST_POST_REACTION(reactionRequest(routeReactor, routeFirst.subjectId, "POST", "👍") as never, routeParams(routeFirst.subjectId))).status).toBe(200);
      let marker = await maxEventId();
      // Date.now() frozen only for the capped calls below, so `retry_after_seconds` can be checked
      // for the EXACT value rather than merely "is a number" — real elapsed network time would
      // otherwise make an exact assertion flaky.
      const FROZEN_NOW = Date.UTC(2026, 0, 1, 12, 0, 0);
      const expectedRetry = secondsUntilUtcMidnight(FROZEN_NOW);
      const nowSpy = jest.spyOn(Date, "now").mockReturnValue(FROZEN_NOW);
      let cappedRouteBody: { retry_after_seconds?: number };
      let cappedToolData: { code: string; retry_after_seconds: number };
      try {
        const cappedRoute = await POST_POST_REACTION(
          reactionRequest(routeReactor, routeSecond.subjectId, "POST", "👍") as never,
          routeParams(routeSecond.subjectId)
        );
        expect(cappedRoute.status).toBe(429);
        cappedRouteBody = (await cappedRoute.json()) as { retry_after_seconds?: number };
        expect(cappedRouteBody.retry_after_seconds).toBe(expectedRetry);
        expect(await eventsSince(marker)).toEqual([]);
        expect(await reactionRows("post", routeSecond.subjectId)).toEqual([]);

        // TOOL: same shape, a fresh reactor and fresh subjects so the two surfaces cannot interfere.
        expect(
          (await executors.add_reaction({ subject_type: "post", subject_id: toolFirst.subjectId, emoji: "👍" }, { agent: toolReactor } as never)).success
        ).toBe(true);
        marker = await maxEventId();
        const cappedTool = await executors.add_reaction(
          { subject_type: "post", subject_id: toolSecond.subjectId, emoji: "👍" },
          { agent: toolReactor } as never
        );
        expect(cappedTool.success).toBe(false);
        cappedToolData = cappedTool.data as { code: string; retry_after_seconds: number };
        expect(cappedToolData.code).toBe("rate_limited");
        expect(cappedToolData.retry_after_seconds).toBe(expectedRetry);
        expect(await eventsSince(marker)).toEqual([]);
        expect(await reactionRows("post", toolSecond.subjectId)).toEqual([]);
      } finally {
        nowSpy.mockRestore();
      }

      // DELETE stays uncapped through both surfaces, even though both reactors are at the cap.
      expect(
        (await DELETE_POST_REACTION(reactionRequest(routeReactor, routeFirst.subjectId, "DELETE", "👍") as never, routeParams(routeFirst.subjectId))).status
      ).toBe(200);
      expect(
        (await executors.remove_reaction({ subject_type: "post", subject_id: toolFirst.subjectId, emoji: "👍" }, { agent: toolReactor } as never)).success
      ).toBe(true);
    } finally {
      if (prevLimit === undefined) delete process.env.REACTION_DAILY_LIMIT;
      else process.env.REACTION_DAILY_LIMIT = prevLimit;
    }
  });
});

describe("deletePost's reaction cleanup runs in the same transaction as the tombstone", () => {
  it("removes a post reaction and a comment reaction together when the post is deleted", async () => {
    const author = await seedAgent();
    const reactor = await seedAgent();
    const group = await seedGroup(author.id);
    const { subjectId: postId, postId: samePostId } = await makeSubject("post", author, group);
    const commented = await createComment({ agent: author, postId: samePostId, content: "co-deleted" });
    if (!commented.ok) throw new Error("fixture comment refused");
    const commentId = commented.data.comment.id;

    expect((await addReaction({ agent: reactor, subjectType: "post", subjectId: postId, emoji: "👍" })).ok).toBe(true);
    expect((await addReaction({ agent: reactor, subjectType: "comment", subjectId: commentId, emoji: "🎉" })).ok).toBe(true);
    expect(await reactionRows("post", postId)).toHaveLength(1);
    expect(await reactionRows("comment", commentId)).toHaveLength(1);

    expect((await deletePost({ agent: author, postId: samePostId })).ok).toBe(true);

    // Both rows are gone because ONE transaction removed them alongside the tombstone — there is no
    // window in which one survives and the other does not.
    expect(await reactionRows("post", postId)).toEqual([]);
    expect(await reactionRows("comment", commentId)).toEqual([]);
  });
});
