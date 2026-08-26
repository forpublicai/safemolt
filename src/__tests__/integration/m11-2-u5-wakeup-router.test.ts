/**
 * M11-2 P3.2 (train a4, lane C) `[integration]` — the wakeup router and the notifications
 * consumer's markable `playground_round_open` row, driven through the REAL drain.
 *
 * The memory-mode suite proves the branch decisions. Only this one can prove the things that are
 * properties of the database rather than of a code path:
 *
 *  - the round-open notification's freshness gate is a **locked subquery** (`SELECT id FROM
 *    playground_sessions WHERE … FOR SHARE`), so the statement has to PARSE and its 13 projected
 *    columns have to line up with the insert's column list — a memory twin can assert neither;
 *  - the un-acted predicate is a `NOT EXISTS` over `playground_actions` in that same statement, so a
 *    submission landing between the consumer's read and the insert suppresses the row rather than
 *    racing it;
 *  - **`resolveWakeupDelivery` returning `null` has no memory-mode fixture at all** — memory mode
 *    resolves `"internal"` unconditionally (a recorded scope decision in `store/wakeups/memory.ts`,
 *    since `agent_loop_state` has no memory twin), so the "loop disabled ⇒ create nothing" rule is
 *    only observable here;
 *  - and the two consumers have **separate cursors and separate receipts** over one event, which is
 *    what a real drain shows and an injected in-process dispatcher cannot.
 *
 * Every fixture agent is real: `agent_wakeups.agent_id`, `agent_loop_state.agent_id` and
 * `notifications.agent_id` all carry `REFERENCES agents(id)`, so an unseeded id raises 23503.
 *
 * @jest-environment node
 */
import { eventConsumers } from "@/lib/events/consumers/registry";
import { emitEvent } from "@/lib/store";
import { drainEventConsumer } from "@/lib/store/events/drain-db";
import type { PreparedEvent } from "@/lib/events/kinds";

import { activateRealConsumers } from "./helpers/activate-consumers";
import { closeIntegrationConnections, pgPool } from "./helpers/db";

const RUN = `${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;
let seq = 0;
const nextId = (kind: string) => `u5rt${kind}${RUN}${(seq += 1)}`;

const REAL_CONSUMERS = eventConsumers.map((consumer) => consumer.name);
const PLAYGROUND_ROUND = "playground_round";

/** Every event this file writes lands above this id, so cleanup needs no marker column. */
let baselineEventId = 0;

/**
 * A real agent, and whether its autonomous loop is on.
 *
 * `loopEnabled: false` seeds no `agent_loop_state` row at all, which is the OTHER half of
 * `resolveWakeupDelivery`'s `null`: a missing row and `enabled = false` both mean "create nothing".
 */
async function seedAgent(options: { loopEnabled?: boolean | "absent" } = {}): Promise<string> {
  const id = nextId("agent");
  await pgPool().query(
    `INSERT INTO agents (id, name, description, api_key, points, vote_points, evaluation_points,
                         legacy_unattributed_points, follower_count, is_claimed, created_at, is_vetted)
     VALUES ($1, $1, '', $2, 0, 0, 0, 0, 0, false, NOW(), true)`,
    [id, `u5rtkey${id}`]
  );
  const loop = options.loopEnabled ?? true;
  if (loop !== "absent") {
    await pgPool().query(`INSERT INTO agent_loop_state (agent_id, enabled) VALUES ($1, $2)`, [
      id,
      loop,
    ]);
  }
  return id;
}

/**
 * A live session in a school of its own.
 *
 * `idx_pg_sessions_one_live_per_school` admits ONE live session per school, and these fixtures hold
 * several at once, so each takes a run-unique school. Seeded with raw SQL rather than through
 * `createPlaygroundSession`, because that emits `playground.session_created` and the fixture would
 * then be writing state the assertions are counting.
 */
async function seedSession(options: {
  participants: { agentId: string; status?: "active" | "forfeited" }[];
  status?: "pending" | "active" | "completed" | "cancelled";
  currentRound?: number;
}): Promise<string> {
  const id = nextId("sess");
  const participants = options.participants.map((p) => ({
    agentId: p.agentId,
    agentName: `${p.agentId}named`,
    status: p.status ?? "active",
  }));
  await pgPool().query(
    `INSERT INTO playground_sessions
       (id, game_id, school_id, status, participants, transcript, current_round, max_rounds,
        created_at, started_at)
     VALUES ($1, 'pub-debate', $2, $3, $4::jsonb, '[]'::jsonb, $5, 6, NOW(), NOW())`,
    [
      id,
      `u5rtschool${id}`,
      options.status ?? "active",
      JSON.stringify(participants),
      options.currentRound ?? 1,
    ]
  );
  return id;
}

async function seedAction(sessionId: string, agentId: string, round: number): Promise<void> {
  await pgPool().query(
    `INSERT INTO playground_actions (id, session_id, agent_id, round, content)
     VALUES ($1, $2, $3, $4, 'already moved')`,
    [nextId("act"), sessionId, agentId, round]
  );
}

async function emitRoundOpened(sessionId: string, round: number): Promise<number> {
  const emitted = await emitEvent({
    kind: "playground.round_opened",
    subjectType: "playground_session",
    subjectId: sessionId,
    payload: { session_id: sessionId, round },
  } satisfies PreparedEvent<"playground.round_opened">);
  return emitted.id;
}

/**
 * Drain until nothing moves — **a single pass is not enough on a shared database.**
 *
 * `drainEventConsumer` processes one batch per call, and the reserved database carries every other
 * suite's events between a consumer's activation fence and the event under test. One pass leaves the
 * cursor short of it, and the assertion then reports "no effect" for an event the drain has simply
 * not reached yet — a harness artifact indistinguishable from a real dispatch failure.
 */
async function drainAll(): Promise<void> {
  for (const consumer of eventConsumers) {
    for (let pass = 0; pass < 50; pass += 1) {
      const counts = await drainEventConsumer(consumer, { batchSize: 500 });
      if (counts.processed === 0) break;
    }
  }
}

async function wakeupsFor(agentId: string): Promise<
  { reason: string; event_id: number | null; delivery: string; payload: Record<string, unknown> }[]
> {
  const { rows } = await pgPool().query(
    `SELECT reason, event_id::int AS event_id, delivery, payload
     FROM agent_wakeups WHERE agent_id = $1 ORDER BY id ASC`,
    [agentId]
  );
  return rows as { reason: string; event_id: number | null; delivery: string; payload: Record<string, unknown> }[];
}

async function notificationsFor(agentId: string): Promise<Record<string, unknown>[]> {
  const { rows } = await pgPool().query(
    `SELECT type, priority, actor, target, href, metadata, dedup_key, read_at
     FROM notifications WHERE agent_id = $1 ORDER BY id ASC`,
    [agentId]
  );
  return rows as Record<string, unknown>[];
}

async function receipted(eventId: number): Promise<string[]> {
  const { rows } = await pgPool().query<{ consumer: string }>(
    `SELECT consumer FROM event_receipts WHERE event_id = $1 ORDER BY consumer`,
    [eventId]
  );
  return rows.map((row) => row.consumer);
}

beforeAll(async () => {
  const { rows } = await pgPool().query(`SELECT COALESCE(max(id), 0) AS id FROM events`);
  baselineEventId = Number(rows[0].id);
  // Neutralize orphaned LIVE sessions before seeding: `idx_pg_sessions_one_live_per_school` admits
  // one live session per school regardless of id, so a run-unique suffix cannot dodge a leftover —
  // and an interrupted prior run skips afterAll and leaves exactly that. Fixture orphans (any RUN)
  // and stale live sessions from any origin both free the index; fresh non-fixture rows survive.
  await pgPool().query(
    `UPDATE playground_sessions SET status = 'cancelled', completed_at = NOW()
     WHERE status IN ('pending', 'active')
       AND (id LIKE 'u5rt%' OR created_at < NOW() - INTERVAL '1 hour')`
  );
  await activateRealConsumers();
});

afterAll(async () => {
  const like = `u5rt%${RUN}%`;
  await pgPool().query(`DELETE FROM event_receipts WHERE consumer = ANY($1::text[])`, [REAL_CONSUMERS]);
  await pgPool().query(`DELETE FROM event_consumer_failures WHERE consumer = ANY($1::text[])`, [REAL_CONSUMERS]);
  await pgPool().query(`DELETE FROM event_dead_letters WHERE consumer = ANY($1::text[])`, [REAL_CONSUMERS]);
  await pgPool().query(`DELETE FROM event_consumers WHERE consumer = ANY($1::text[])`, [REAL_CONSUMERS]);
  await pgPool().query(
    `DELETE FROM events WHERE kind = 'system.activation_fence' AND payload->>'consumer' = ANY($1::text[])`,
    [REAL_CONSUMERS]
  );
  await pgPool().query(`DELETE FROM event_consumer_shadow WHERE event_id > $1`, [baselineEventId]);
  await pgPool().query(`DELETE FROM events WHERE id > $1`, [baselineEventId]);
  await pgPool().query(`DELETE FROM agent_wakeups WHERE agent_id LIKE $1`, [like]);
  await pgPool().query(`DELETE FROM agent_loop_state WHERE agent_id LIKE $1`, [like]);
  await pgPool().query(`DELETE FROM notifications WHERE agent_id LIKE $1`, [like]);
  await pgPool().query(`DELETE FROM activity_contexts WHERE activity_id LIKE $1`, [like]);
  await pgPool().query(`DELETE FROM activity_events WHERE actor_id LIKE $1 OR entity_id LIKE $1`, [like]);
  await pgPool().query(`DELETE FROM comments WHERE author_id LIKE $1`, [like]);
  await pgPool().query(`DELETE FROM posts WHERE author_id LIKE $1`, [like]);
  await pgPool().query(`DELETE FROM group_members WHERE group_id LIKE $1 OR agent_id LIKE $1`, [like]);
  await pgPool().query(`DELETE FROM groups WHERE id LIKE $1`, [like]);
  await pgPool().query(`DELETE FROM playground_actions WHERE session_id LIKE $1 OR agent_id LIKE $1`, [like]);
  await pgPool().query(`DELETE FROM playground_sessions WHERE id LIKE $1`, [like]);
  await pgPool().query(`DELETE FROM agents WHERE id LIKE $1`, [like]);
  await closeIntegrationConnections();
});

describe("playground.round_opened — the router's wakeups", () => {
  it("wakes exactly the participants who have not acted, and receipts on every consumer", async () => {
    const acted = await seedAgent();
    const first = await seedAgent();
    const second = await seedAgent();
    const session = await seedSession({
      currentRound: 3,
      participants: [{ agentId: acted }, { agentId: first }, { agentId: second }],
    });
    await seedAction(session, acted, 3);

    const eventId = await emitRoundOpened(session, 3);
    await drainAll();

    // Four consumers, four cursors, four receipts — one event, independently owned effects.
    expect(await receipted(eventId)).toEqual([...REAL_CONSUMERS].sort());

    for (const agentId of [first, second]) {
      const rows = await wakeupsFor(agentId);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        reason: PLAYGROUND_ROUND,
        event_id: eventId,
        delivery: "internal",
        payload: { session_id: session, round: 3 },
      });
    }
    expect(await wakeupsFor(acted)).toEqual([]);
  });

  /**
   * **The `null`-delivery rule, which memory mode cannot express.**
   *
   * `resolveWakeupDelivery` answers `internal` only for a loop-enabled agent; a disabled row and a
   * missing row both answer `null`, and `null` means "create no wakeup for this agent at all" rather
   * than "create one with delivery `none`".
   */
  it("creates nothing for an agent whose loop is off or has no loop state", async () => {
    const on = await seedAgent();
    const off = await seedAgent({ loopEnabled: false });
    const unknown = await seedAgent({ loopEnabled: "absent" });
    const session = await seedSession({
      currentRound: 1,
      participants: [{ agentId: on }, { agentId: off }, { agentId: unknown }],
    });

    await emitRoundOpened(session, 1);
    await drainAll();

    expect(await wakeupsFor(on)).toHaveLength(1);
    expect(await wakeupsFor(off)).toEqual([]);
    expect(await wakeupsFor(unknown)).toEqual([]);
  });

  it("wakes nobody once the session has advanced past the event's round", async () => {
    const agent = await seedAgent();
    const session = await seedSession({ currentRound: 2, participants: [{ agentId: agent }] });
    const eventId = await emitRoundOpened(session, 1);

    await drainAll();

    // Receipt, no effect — a stale nudge would spend the agent's loop budget on a closed turn.
    expect(await receipted(eventId)).toEqual([...REAL_CONSUMERS].sort());
    expect(await wakeupsFor(agent)).toEqual([]);
  });

  it("wakes nobody for a completed session, and skips a forfeited participant", async () => {
    const done = await seedAgent();
    const finished = await seedSession({
      status: "completed",
      currentRound: 1,
      participants: [{ agentId: done }],
    });
    const active = await seedAgent();
    const gone = await seedAgent();
    const live = await seedSession({
      currentRound: 1,
      participants: [{ agentId: active }, { agentId: gone, status: "forfeited" }],
    });

    await emitRoundOpened(finished, 1);
    await emitRoundOpened(live, 1);
    await drainAll();

    expect(await wakeupsFor(done)).toEqual([]);
    expect(await wakeupsFor(active)).toHaveLength(1);
    expect(await wakeupsFor(gone)).toEqual([]);
  });

  /**
   * Redelivery is ordinary in an at-least-once pipeline, and `idx_wakeups_dedup_event` is what
   * absorbs it: the second insert's `ON CONFLICT DO NOTHING` writes nothing.
   */
  it("is idempotent when the same event is consumed twice", async () => {
    const agent = await seedAgent();
    const session = await seedSession({ currentRound: 1, participants: [{ agentId: agent }] });
    const eventId = await emitRoundOpened(session, 1);

    await drainAll();
    await pgPool().query(`DELETE FROM event_receipts WHERE event_id = $1 AND consumer = 'wakeup-router'`, [
      eventId,
    ]);
    await drainAll();

    expect(await wakeupsFor(agent)).toHaveLength(1);
  });
});

describe("playground.round_opened — the notifications consumer's markable row", () => {
  it("writes one row per un-acted participant, with the session as its target", async () => {
    const acted = await seedAgent();
    const waiting = await seedAgent();
    const session = await seedSession({
      currentRound: 4,
      participants: [{ agentId: acted }, { agentId: waiting }],
    });
    await seedAction(session, acted, 4);

    const eventId = await emitRoundOpened(session, 4);
    await drainAll();

    const inbox = await notificationsFor(waiting);
    expect(inbox).toHaveLength(1);
    expect(inbox[0]).toMatchObject({
      type: "playground_round_open",
      priority: "normal",
      read_at: null,
      actor: { id: "system", name: "Game Master" },
      target: { type: "playground_session", id: session },
      href: "/playground",
      metadata: { session_id: session, round: 4 },
      dedup_key: `playground_round_open:${waiting}:${eventId}`,
    });
    expect(await notificationsFor(acted)).toEqual([]);
  });

  /** The `dedup_key` unique index absorbs a redelivery, exactly as it does for the a1 kinds. */
  it("creates no duplicate when the same event is consumed twice", async () => {
    const agent = await seedAgent();
    const session = await seedSession({ currentRound: 1, participants: [{ agentId: agent }] });
    const eventId = await emitRoundOpened(session, 1);

    await drainAll();
    await pgPool().query(`DELETE FROM event_receipts WHERE event_id = $1 AND consumer = 'notifications'`, [
      eventId,
    ]);
    await drainAll();

    expect(await notificationsFor(agent)).toHaveLength(1);
  });

  /**
   * **The freshness gate is the LOCKED subquery, not the consumer's re-fetch.**
   *
   * Here the consumer's read would have succeeded — the session was active on round 1 when the
   * event drained — and the round is advanced underneath before the drain runs, so the statement's
   * own `WHERE status = 'active' AND current_round = $5` is the thing that has to write nothing.
   */
  it("writes nothing once the session has moved off the event's round", async () => {
    const agent = await seedAgent();
    const session = await seedSession({ currentRound: 1, participants: [{ agentId: agent }] });
    const eventId = await emitRoundOpened(session, 1);
    await pgPool().query(`UPDATE playground_sessions SET current_round = 2 WHERE id = $1`, [session]);

    await drainAll();

    expect(await receipted(eventId)).toEqual([...REAL_CONSUMERS].sort());
    expect(await notificationsFor(agent)).toEqual([]);
    expect(await wakeupsFor(agent)).toEqual([]);
  });

  /** The `NOT EXISTS` half of the same statement: a submission suppresses the row on its own. */
  it("writes nothing for a participant who acted before the drain", async () => {
    const agent = await seedAgent();
    const session = await seedSession({ currentRound: 1, participants: [{ agentId: agent }] });
    await emitRoundOpened(session, 1);
    await seedAction(session, agent, 1);

    await drainAll();

    expect(await notificationsFor(agent)).toEqual([]);
    expect(await wakeupsFor(agent)).toEqual([]);
  });
});

describe("comment.created — the router's wakeups against real rows", () => {
  async function seedThread(): Promise<{ author: string; group: string; post: string }> {
    const author = await seedAgent();
    const group = nextId("group");
    await pgPool().query(
      `INSERT INTO groups (id, name, display_name, description, owner_id, member_ids, moderator_ids,
                           pinned_post_ids, created_at)
       VALUES ($1, $1, $1, '', $2, $3::jsonb, '[]'::jsonb, '[]'::jsonb, NOW())`,
      [group, author, JSON.stringify([author])]
    );
    const post = nextId("post");
    await pgPool().query(
      `INSERT INTO posts (id, title, content, author_id, group_id, upvotes, downvotes, comment_count, created_at)
       VALUES ($1, 'Hello', 'World', $2, $3, 0, 0, 0, NOW())`,
      [post, author, group]
    );
    return { author, group, post };
  }

  async function seedCommentRow(
    postId: string,
    authorId: string,
    parentId: string | null
  ): Promise<string> {
    const id = nextId("cmt");
    await pgPool().query(
      `INSERT INTO comments (id, post_id, author_id, content, parent_id, upvotes, created_at)
       VALUES ($1, $2, $3, 'text', $4, 0, NOW())`,
      [id, postId, authorId, parentId]
    );
    return id;
  }

  async function emitCommentCreated(
    commentId: string,
    postId: string,
    parentId: string | null,
    actorAgentId: string
  ): Promise<number> {
    const emitted = await emitEvent({
      kind: "comment.created",
      actorAgentId,
      subjectType: "comment",
      subjectId: commentId,
      payload: { comment_id: commentId, post_id: postId, parent_id: parentId },
    } satisfies PreparedEvent<"comment.created">);
    return emitted.id;
  }

  it("wakes the post author for a top-level comment and the parent author for a reply", async () => {
    const { author, post } = await seedThread();
    const commenter = await seedAgent();
    const replier = await seedAgent();
    const topLevel = await seedCommentRow(post, commenter, null);
    const reply = await seedCommentRow(post, replier, topLevel);

    const topEvent = await emitCommentCreated(topLevel, post, null, commenter);
    const replyEvent = await emitCommentCreated(reply, post, topLevel, replier);
    await drainAll();

    const authorWakeups = await wakeupsFor(author);
    expect(authorWakeups).toHaveLength(1);
    expect(authorWakeups[0]).toMatchObject({
      reason: "comment_on_my_post",
      event_id: topEvent,
      delivery: "internal",
      payload: { post_id: post, comment_id: topLevel, parent_comment_id: null },
    });

    const commenterWakeups = await wakeupsFor(commenter);
    expect(commenterWakeups).toHaveLength(1);
    expect(commenterWakeups[0]).toMatchObject({
      reason: "reply_to_my_comment",
      event_id: replyEvent,
      payload: { post_id: post, comment_id: reply, parent_comment_id: topLevel },
    });

    // A reply wakes the parent author and NOT the post author too — mutually exclusive branches.
    expect(authorWakeups.map((row) => row.event_id)).not.toContain(replyEvent);
    expect(await wakeupsFor(replier)).toEqual([]);
  });

  it("wakes nobody for an author commenting on their own post", async () => {
    const { author, post } = await seedThread();
    const own = await seedCommentRow(post, author, null);

    await emitCommentCreated(own, post, null, author);
    await drainAll();

    expect(await wakeupsFor(author)).toEqual([]);
  });

  /** A deleted post hides its rows from `getPost`/`getComment`, so the event has nothing to route. */
  it("wakes nobody once the post is a tombstone", async () => {
    const { author, post } = await seedThread();
    const commenter = await seedAgent();
    const comment = await seedCommentRow(post, commenter, null);
    const eventId = await emitCommentCreated(comment, post, null, commenter);
    await pgPool().query(`UPDATE posts SET deleted_at = NOW() WHERE id = $1`, [post]);

    await drainAll();

    expect(await receipted(eventId)).toEqual([...REAL_CONSUMERS].sort());
    expect(await wakeupsFor(author)).toEqual([]);
  });
});
