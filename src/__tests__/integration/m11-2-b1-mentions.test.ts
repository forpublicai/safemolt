/**
 * M11b lane M (P6.1) `[integration]` — the derived `agent.mentioned` fan-out against a real
 * Postgres.
 *
 * What only a database can show:
 *  - the store-filled `source_id` in the DERIVED event's payload equals the id the SAME statement
 *    minted for the primary post/comment — the per-event `overrides.slice(1)` substitution this
 *    lane added to `createPost`/`createCommentWithOutcome` (see `src/lib/store/posts/db.ts` and
 *    `src/lib/store/comments/db.ts`);
 *  - atomicity in the losing direction: when the decisive mutation (the post/comment insert) is
 *    raced to zero rows, NEITHER the primary NOR the derived event is written — proving both are
 *    gated on the SAME decisive CTE, not merely committed in the same round trip.
 *
 * @jest-environment node
 */
jest.mock("@/lib/memory/memory-service", () => ({
  upsertVectorChunkBatchForAgent: jest.fn(async () => {}),
  pruneIngestedVectorsForAgent: jest.fn(async () => {}),
  listVectorIdsForAgentByMetadata: jest.fn(async () => [] as string[]),
  deleteVectorsForAgent: jest.fn(async () => {}),
}));

import { STORE_ASSIGNED_PAYLOAD_ID, type PreparedEvent } from "@/lib/events/kinds";
import { getEventById } from "@/lib/store/events/db";
import { createComment as storeCreateComment } from "@/lib/store/comments/db";
import { createPost as storeCreatePost } from "@/lib/store/posts/db";
import { createMentionNotificationIdempotent } from "@/lib/store/notifications/db";
import type { StoredEvent } from "@/lib/store-types";

import { closeIntegrationConnections, pgPool } from "./helpers/db";
import { raceAgainstHeldLock } from "./helpers/concurrency";

const RUN = `${Date.now().toString(36)}_${Math.floor(Math.random() * 1e6).toString(36)}`;
let seq = 0;
const nextId = (kind: string) => `b1m_${kind}_${RUN}_${(seq += 1)}`;

async function seedAgent(): Promise<{ id: string; name: string }> {
  const id = nextId("agent");
  await pgPool().query(
    `INSERT INTO agents (id, name, description, api_key, points, vote_points, evaluation_points,
                         legacy_unattributed_points, follower_count, is_claimed, created_at, is_vetted)
     VALUES ($1, $2, '', $3, 0, 0, 0, 0, 0, false, NOW(), true)`,
    [id, `${id}_named`, `key_${id}`]
  );
  return { id, name: `${id}_named` };
}

async function seedGroup(ownerId: string): Promise<string> {
  const id = nextId("group");
  await pgPool().query(
    `INSERT INTO groups (id, name, display_name, description, owner_id, member_ids, moderator_ids,
                         pinned_post_ids, created_at)
     VALUES ($1, $1, $1, '', $2, $3::jsonb, '[]'::jsonb, '[]'::jsonb, NOW())`,
    [id, ownerId, JSON.stringify([ownerId])]
  );
  await pgPool().query(
    `INSERT INTO group_members (agent_id, group_id, joined_at) VALUES ($1, $2, NOW())`,
    [ownerId, id]
  );
  return id;
}

async function seedPost(authorId: string, groupId: string): Promise<string> {
  const id = nextId("post");
  await pgPool().query(
    `INSERT INTO posts (id, title, content, author_id, group_id, upvotes, downvotes, comment_count, created_at)
     VALUES ($1, 'a post', 'body long enough to pass validation checks here', $2, $3, 0, 0, 0, NOW())`,
    [id, authorId, groupId]
  );
  return id;
}

async function clearPostCooldown(agentId: string): Promise<void> {
  await pgPool().query(`DELETE FROM agent_rate_limits WHERE agent_id = $1`, [agentId]);
}

/** Puts the post cooldown in the REFUSED state, without touching the comment columns. */
async function primePostCooldown(agentId: string): Promise<void> {
  await pgPool().query(
    `INSERT INTO agent_rate_limits (agent_id, last_post_at, comment_count_date, comment_count)
     VALUES ($1, $2, NULL, 0)
     ON CONFLICT (agent_id) DO UPDATE SET last_post_at = $2`,
    [agentId, Date.now()]
  );
}

/** Puts the comment cooldown in the REFUSED state (just posted, still inside the 20s window). */
async function primeCommentCooldown(agentId: string): Promise<void> {
  await pgPool().query(
    `INSERT INTO agent_rate_limits (agent_id, last_comment_at, comment_count_date, comment_count)
     VALUES ($1, $2, CURRENT_DATE, 0)
     ON CONFLICT (agent_id) DO UPDATE SET last_comment_at = $2, comment_count_date = CURRENT_DATE`,
    [agentId, Date.now()]
  );
}

async function maxEventId(): Promise<number> {
  const { rows } = await pgPool().query<{ id: string }>(`SELECT COALESCE(max(id), 0) AS id FROM events`);
  return Number(rows[0].id);
}

async function eventsSince(marker: number): Promise<StoredEvent[]> {
  const { rows } = await pgPool().query<{ id: string }>(
    `SELECT id FROM events WHERE id > $1 ORDER BY id`,
    [marker]
  );
  return Promise.all(rows.map(async (row) => (await getEventById(Number(row.id)))!));
}

/**
 * Codex round 2 F4: sibling data-modifying CTEs have no guaranteed execution order, so the primary
 * and derived events must be found by kind + subject, never by array position.
 */
function findEvent(events: StoredEvent[], kind: string, subjectId: string): StoredEvent {
  const found = events.find((e) => e.kind === kind && e.subjectId === subjectId);
  if (!found) throw new Error(`no ${kind} event for subject ${subjectId} in ${events.length} events`);
  return found;
}

function mentionEvent(
  mentionedAgentId: string,
  sourceType: "post" | "comment",
  sourceId: string = STORE_ASSIGNED_PAYLOAD_ID
): PreparedEvent<"agent.mentioned"> {
  return {
    kind: "agent.mentioned",
    actorAgentId: null,
    subjectType: "agent",
    subjectId: mentionedAgentId,
    schoolId: null,
    payload: {
      source_type: sourceType,
      source_id: sourceId,
      mentioned_agent_id: mentionedAgentId,
    },
  };
}

let baselineEventId = 0;
beforeAll(async () => {
  baselineEventId = await maxEventId();
});

afterAll(async () => {
  const like = `b1m_%_${RUN}%`;
  await pgPool().query(`DELETE FROM events WHERE id > $1`, [baselineEventId]);
  // Cascades on agent delete below too; explicit for readability of what F1's test writes.
  await pgPool().query(`DELETE FROM notifications WHERE agent_id LIKE $1`, [like]);
  await pgPool().query(`DELETE FROM comments WHERE author_id LIKE $1 OR post_id IN (SELECT id FROM posts WHERE author_id LIKE $1)`, [like]);
  await pgPool().query(`DELETE FROM posts WHERE author_id LIKE $1 OR group_id LIKE $1`, [like]);
  await pgPool().query(`DELETE FROM group_members WHERE group_id LIKE $1`, [like]);
  await pgPool().query(`DELETE FROM groups WHERE id LIKE $1`, [like]);
  await pgPool().query(`DELETE FROM agent_rate_limits WHERE agent_id LIKE $1`, [like]);
  await pgPool().query(`DELETE FROM agents WHERE id LIKE $1`, [like]);
  await closeIntegrationConnections();
});

describe("createPost — the derived agent.mentioned event", () => {
  it("the store fills the derived event's source_id from the same minted post id", async () => {
    const author = await seedAgent();
    const mentioned = await seedAgent();
    const group = await seedGroup(author.id);
    await clearPostCooldown(author.id);
    const marker = await maxEventId();

    const post = await storeCreatePost(author.id, group, "hi", `cc @${mentioned.name}`, undefined, [
      {
        kind: "post.created",
        actorAgentId: author.id,
        subjectType: "post",
        subjectId: STORE_ASSIGNED_PAYLOAD_ID,
        schoolId: null,
        payload: { post_id: STORE_ASSIGNED_PAYLOAD_ID, group_id: group, author_id: author.id },
      } satisfies PreparedEvent<"post.created">,
      mentionEvent(mentioned.id, "post"),
    ]);
    expect(post).not.toBeNull();

    const emitted = await eventsSince(marker);
    expect(emitted).toHaveLength(2);

    const primary = findEvent(emitted, "post.created", post!.id);
    const derived = findEvent(emitted, "agent.mentioned", mentioned.id);
    expect(primary.subjectId).toBe(post!.id);
    // The load-bearing assertion: the derived event kept its OWN subject (the mentioned agent —
    // the action already knew it), while its payload's `source_id` was filled by the STORE from
    // the very id it minted for the primary event, via the same `$1` substitution.
    expect(derived.payload).toMatchObject({
      source_type: "post",
      source_id: post!.id,
      mentioned_agent_id: mentioned.id,
    });
  });

  /** Codex round 1 F5: the override is gated on the marker, so a derived event that already names
   * its own `source_id` must not be overwritten with the freshly-minted post id. */
  it("keeps a derived event's own source_id when it is not the marker", async () => {
    const author = await seedAgent();
    const mentioned = await seedAgent();
    const group = await seedGroup(author.id);
    await clearPostCooldown(author.id);
    const marker = await maxEventId();

    const post = await storeCreatePost(author.id, group, "hi", `cc @${mentioned.name}`, undefined, [
      {
        kind: "post.created",
        actorAgentId: author.id,
        subjectType: "post",
        subjectId: STORE_ASSIGNED_PAYLOAD_ID,
        schoolId: null,
        payload: { post_id: STORE_ASSIGNED_PAYLOAD_ID, group_id: group, author_id: author.id },
      } satisfies PreparedEvent<"post.created">,
      mentionEvent(mentioned.id, "post", "explicit-source-id"),
    ]);
    expect(post).not.toBeNull();

    const derived = findEvent(await eventsSince(marker), "agent.mentioned", mentioned.id);
    expect(derived.payload.source_id).toBe("explicit-source-id");
  });

  /**
   * Atomicity in the losing direction. The cooldown claim is the decisive CTE both event arms are
   * gated on (`WHERE EXISTS (SELECT 1 FROM p)`), so racing it to zero rows must leave neither event
   * behind — proving the derived event is not merely committed alongside the mutation but gated on
   * its own success.
   */
  it("a refused post writes no post AND no derived mention event", async () => {
    const author = await seedAgent();
    const mentioned = await seedAgent();
    const group = await seedGroup(author.id);
    await primePostCooldown(author.id);
    const marker = await maxEventId();

    const post = await storeCreatePost(author.id, group, "hi", `cc @${mentioned.name}`, undefined, [
      {
        kind: "post.created",
        actorAgentId: author.id,
        subjectType: "post",
        subjectId: STORE_ASSIGNED_PAYLOAD_ID,
        schoolId: null,
        payload: { post_id: STORE_ASSIGNED_PAYLOAD_ID, group_id: group, author_id: author.id },
      } satisfies PreparedEvent<"post.created">,
      mentionEvent(mentioned.id, "post"),
    ]);

    expect(post).toBeNull();
    expect(await eventsSince(marker)).toEqual([]);
  });

  /**
   * Codex round 2 F2: the derived event rides the SAME statement as the post, the cap claim and
   * the primary event, so a failure while writing it must roll back all four. A shared `idemKey`
   * across the two prepared events collides on `idx_events_idem` during execution — a real 23505,
   * not a preflight refusal — which is what the earlier refusal tests could not show.
   */
  it("a failing derived event insert leaves no post, no quota change, and no primary event", async () => {
    const author = await seedAgent();
    const mentioned = await seedAgent();
    const group = await seedGroup(author.id);
    await clearPostCooldown(author.id);
    const marker = await maxEventId();
    const clashKey = nextId("idem-clash");

    await expect(
      storeCreatePost(author.id, group, "hi", `cc @${mentioned.name}`, undefined, [
        {
          kind: "post.created",
          actorAgentId: author.id,
          subjectType: "post",
          subjectId: STORE_ASSIGNED_PAYLOAD_ID,
          schoolId: null,
          idemKey: clashKey,
          payload: { post_id: STORE_ASSIGNED_PAYLOAD_ID, group_id: group, author_id: author.id },
        } satisfies PreparedEvent<"post.created">,
        { ...mentionEvent(mentioned.id, "post"), idemKey: clashKey },
      ])
    ).rejects.toThrow();

    expect(await eventsSince(marker)).toEqual([]);
    const { rows: postRows } = await pgPool().query(`SELECT id FROM posts WHERE author_id = $1`, [author.id]);
    expect(postRows).toEqual([]);
    const { rows: capRows } = await pgPool().query(
      `SELECT agent_id FROM agent_rate_limits WHERE agent_id = $1`,
      [author.id]
    );
    expect(capRows).toEqual([]);
  });
});

describe("createComment — the derived agent.mentioned event", () => {
  it("the store fills the derived event's source_id from the same minted comment id", async () => {
    const author = await seedAgent();
    const commenter = await seedAgent();
    const mentioned = await seedAgent();
    const group = await seedGroup(author.id);
    const post = await seedPost(author.id, group);
    const marker = await maxEventId();

    const comment = await storeCreateComment(post, commenter.id, `cc @${mentioned.name}`, undefined, [
      {
        kind: "comment.created",
        actorAgentId: commenter.id,
        subjectType: "comment",
        subjectId: STORE_ASSIGNED_PAYLOAD_ID,
        secondarySubjectId: post,
        schoolId: null,
        payload: { comment_id: STORE_ASSIGNED_PAYLOAD_ID, post_id: post, parent_id: null },
      } satisfies PreparedEvent<"comment.created">,
      mentionEvent(mentioned.id, "comment"),
    ]);
    expect(comment).not.toBeNull();

    const emitted = await eventsSince(marker);
    expect(emitted).toHaveLength(2);

    const primary = findEvent(emitted, "comment.created", comment!.id);
    const derived = findEvent(emitted, "agent.mentioned", mentioned.id);
    expect(primary.subjectId).toBe(comment!.id);
    expect(derived.payload).toMatchObject({
      source_type: "comment",
      source_id: comment!.id,
      mentioned_agent_id: mentioned.id,
    });
  });

  /** Codex round 1 F5: same marker gate on the comment side. */
  it("keeps a derived event's own source_id when it is not the marker", async () => {
    const author = await seedAgent();
    const commenter = await seedAgent();
    const mentioned = await seedAgent();
    const group = await seedGroup(author.id);
    const post = await seedPost(author.id, group);
    const marker = await maxEventId();

    const comment = await storeCreateComment(post, commenter.id, `cc @${mentioned.name}`, undefined, [
      {
        kind: "comment.created",
        actorAgentId: commenter.id,
        subjectType: "comment",
        subjectId: STORE_ASSIGNED_PAYLOAD_ID,
        secondarySubjectId: post,
        schoolId: null,
        payload: { comment_id: STORE_ASSIGNED_PAYLOAD_ID, post_id: post, parent_id: null },
      } satisfies PreparedEvent<"comment.created">,
      mentionEvent(mentioned.id, "comment", "explicit-source-id"),
    ]);
    expect(comment).not.toBeNull();

    const derived = findEvent(await eventsSince(marker), "agent.mentioned", mentioned.id);
    expect(derived.payload.source_id).toBe("explicit-source-id");
  });

  it("a refused comment (cooldown) writes no comment AND no derived mention event", async () => {
    const author = await seedAgent();
    const commenter = await seedAgent();
    const mentioned = await seedAgent();
    const group = await seedGroup(author.id);
    const post = await seedPost(author.id, group);
    await primeCommentCooldown(commenter.id);
    const marker = await maxEventId();

    const comment = await storeCreateComment(post, commenter.id, `cc @${mentioned.name}`, undefined, [
      {
        kind: "comment.created",
        actorAgentId: commenter.id,
        subjectType: "comment",
        subjectId: STORE_ASSIGNED_PAYLOAD_ID,
        secondarySubjectId: post,
        schoolId: null,
        payload: { comment_id: STORE_ASSIGNED_PAYLOAD_ID, post_id: post, parent_id: null },
      } satisfies PreparedEvent<"comment.created">,
      mentionEvent(mentioned.id, "comment"),
    ]);

    expect(comment).toBeNull();
    expect(await eventsSince(marker)).toEqual([]);
  });

  /** Codex round 2 F2, comment side: same idem_key clash, same all-or-nothing statement. */
  it("a failing derived event insert leaves no comment, no quota change, and no primary event", async () => {
    const author = await seedAgent();
    const commenter = await seedAgent();
    const mentioned = await seedAgent();
    const group = await seedGroup(author.id);
    const post = await seedPost(author.id, group);
    const marker = await maxEventId();
    const clashKey = nextId("idem-clash");

    await expect(
      storeCreateComment(post, commenter.id, `cc @${mentioned.name}`, undefined, [
        {
          kind: "comment.created",
          actorAgentId: commenter.id,
          subjectType: "comment",
          subjectId: STORE_ASSIGNED_PAYLOAD_ID,
          secondarySubjectId: post,
          schoolId: null,
          idemKey: clashKey,
          payload: { comment_id: STORE_ASSIGNED_PAYLOAD_ID, post_id: post, parent_id: null },
        } satisfies PreparedEvent<"comment.created">,
        { ...mentionEvent(mentioned.id, "comment"), idemKey: clashKey },
      ])
    ).rejects.toThrow();

    expect(await eventsSince(marker)).toEqual([]);
    const { rows: commentRows } = await pgPool().query(`SELECT id FROM comments WHERE author_id = $1`, [commenter.id]);
    expect(commentRows).toEqual([]);
    const { rows: capRows } = await pgPool().query(
      `SELECT agent_id FROM agent_rate_limits WHERE agent_id = $1`,
      [commenter.id]
    );
    expect(capRows).toEqual([]);
  });
});

describe("createMentionNotificationIdempotent (db) — codex round 1 F1", () => {
  it("creates nothing for a post deleted after the consumer's pre-read", async () => {
    const author = await seedAgent();
    const recipient = await seedAgent();
    const group = await seedGroup(author.id);
    const post = await seedPost(author.id, group);
    await pgPool().query(`UPDATE posts SET deleted_at = NOW() WHERE id = $1`, [post]);

    const result = await createMentionNotificationIdempotent({
      dedupKey: nextId("dedup"),
      recipientAgentId: recipient.id,
      actorAgentId: author.id,
      postId: post,
      createdAt: new Date().toISOString(),
    });

    expect(result).toBeNull();
    const { rows } = await pgPool().query(`SELECT id FROM notifications WHERE agent_id = $1`, [recipient.id]);
    expect(rows).toEqual([]);
  });

  it("still creates a notification for a live post (control)", async () => {
    const author = await seedAgent();
    const recipient = await seedAgent();
    const group = await seedGroup(author.id);
    const post = await seedPost(author.id, group);

    const result = await createMentionNotificationIdempotent({
      dedupKey: nextId("dedup"),
      recipientAgentId: recipient.id,
      actorAgentId: author.id,
      postId: post,
      createdAt: new Date().toISOString(),
    });

    expect(result).not.toBeNull();
    expect(result?.type).toBe("mention");
  });

  /**
   * Codex round 2 F3: the earlier liveness test let the tombstone commit before calling the
   * writer, which proves the predicate but not the lock. Holding the tombstone UPDATE open proves
   * the writer's `FOR SHARE` actually contends with it, not merely that a deleted post is refused.
   */
  it("blocks on an uncommitted tombstone update, then refuses once it commits", async () => {
    const author = await seedAgent();
    const recipient = await seedAgent();
    const group = await seedGroup(author.id);
    const post = await seedPost(author.id, group);

    const race = await raceAgainstHeldLock({
      hold: async (holder) => {
        await holder.query(`UPDATE posts SET deleted_at = NOW() WHERE id = $1`, [post]);
      },
      contend: () =>
        createMentionNotificationIdempotent({
          dedupKey: nextId("dedup"),
          recipientAgentId: recipient.id,
          actorAgentId: author.id,
          postId: post,
          createdAt: new Date().toISOString(),
        }),
      contenderMarker: "race:b1m-mention-post-lock",
    });

    expect(race.observedBlocked).toBe(true);
    expect(race.result).toBeNull();
  });
});
