/**
 * M11b lane R (P6.2) `[integration]` — reactions against the real database.
 *
 * What only a database can show, and what this file is for:
 *  - **the FOR KEY SHARE subject lock**: a reaction attempted after the subject's tombstone lands
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
import { POST as POST_POST_REACTION, DELETE as DELETE_POST_REACTION } from "@/app/api/v1/posts/[id]/reactions/route";
import { createComment } from "@/lib/actions/comments";
import { createPost, deletePost } from "@/lib/actions/posts";
import { addReaction } from "@/lib/actions/reactions";
import { executors } from "@/lib/agent-tools/definitions/reactions";
import { notificationsConsumer } from "@/lib/events/consumers/notifications";
import { eventConsumers } from "@/lib/events/consumers/registry";
import { getEventById } from "@/lib/store/events/db";
import { drainEventConsumer } from "@/lib/store/events/drain-db";
import type { StoredAgent, StoredEvent } from "@/lib/store-types";

import { withMiddlewareHeaders } from "../helpers/middleware-headers";
import { activateRealConsumers } from "./helpers/activate-consumers";
import { rejections, runConcurrently } from "./helpers/concurrency";
import { closeIntegrationConnections, pgPool } from "./helpers/db";

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
  await pgPool().query(
    `DELETE FROM comments WHERE author_id LIKE $1 OR post_id IN (SELECT id FROM posts WHERE author_id LIKE $1)`,
    [like]
  );
  await pgPool().query(`DELETE FROM posts WHERE author_id LIKE $1 OR group_id LIKE $1`, [like]);
  await pgPool().query(`DELETE FROM groups WHERE id LIKE $1`, [like]);
  await pgPool().query(`DELETE FROM agents WHERE id LIKE $1`, [like]);
  await closeIntegrationConnections();
});

describe.each(["post", "comment"] as const)("%s reactions vs deletePost — both orderings", (surface) => {
  it("delete-first: the reaction attempt afterward is not_found, writes nothing, emits nothing", async () => {
    const author = await seedAgent();
    const reactor = await seedAgent();
    const group = await seedGroup(author.id);
    const { subjectId, postId } = await makeSubject(surface, author, group);

    expect((await deletePost({ agent: author, postId })).ok).toBe(true);

    const marker = await maxEventId();
    const result = await addReaction({ agent: reactor, subjectType: surface, subjectId, emoji: "👍" });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("not_found");
    expect(await eventsSince(marker)).toEqual([]);
    expect(await reactionRows(surface, subjectId)).toEqual([]);
  });

  it("reaction-first: the reaction succeeds, and the subsequent delete removes it in the same transaction", async () => {
    const author = await seedAgent();
    const reactor = await seedAgent();
    const group = await seedGroup(author.id);
    const { subjectId, postId } = await makeSubject(surface, author, group);

    const marker = await maxEventId();
    const reacted = await addReaction({ agent: reactor, subjectType: surface, subjectId, emoji: "👍" });
    expect(reacted.ok).toBe(true);
    expect((await eventsSince(marker)).map((e) => e.kind)).toEqual(["reaction.added"]);
    expect(await reactionRows(surface, subjectId)).toHaveLength(1);

    expect((await deletePost({ agent: author, postId })).ok).toBe(true);
    expect(await reactionRows(surface, subjectId)).toEqual([]);
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
    // one — instead exactly one survives.
    expect(await reactionRows("post", subjectId)).toHaveLength(1);
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
      const cappedRoute = await POST_POST_REACTION(
        reactionRequest(routeReactor, routeSecond.subjectId, "POST", "👍") as never,
        routeParams(routeSecond.subjectId)
      );
      expect(cappedRoute.status).toBe(429);
      const cappedRouteBody = (await cappedRoute.json()) as { retry_after_seconds?: number };
      expect(typeof cappedRouteBody.retry_after_seconds).toBe("number");
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
      const cappedToolData = cappedTool.data as { code: string; retry_after_seconds: number };
      expect(cappedToolData.code).toBe("rate_limited");
      expect(typeof cappedToolData.retry_after_seconds).toBe("number");
      expect(await eventsSince(marker)).toEqual([]);
      expect(await reactionRows("post", toolSecond.subjectId)).toEqual([]);

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
