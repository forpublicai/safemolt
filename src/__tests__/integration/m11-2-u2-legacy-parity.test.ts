/**
 * M11-2 u2 `[integration]` — LEGACY vs CONSUMER parity. The seed of u3's verification script.
 *
 * Every gate here has the same shape, and the shape is the point: run the **real legacy inline
 * path** (the store call an agent's request makes today), canonicalize the rows it wrote, delete
 * them, then run the consumer's `describe` and `apply` for the same logical action and diff. A test
 * that compared the consumer's `describe` with its own `apply` would pass for a consumer that is
 * uniformly wrong; only the legacy side is the reference.
 *
 * The cases here are the ones a naive consumer gets wrong:
 *  - the **deployed deletion ordering** — inline delete first, event drained afterwards, so the
 *    shadow keys must come from the payload and not from a live read that would find nothing;
 *  - a **withdrawn follower**, which the legacy writer tolerates with an id fallback;
 *  - a **withdrawn followee**, where the legacy trail row used to outlive its own subject;
 *  - a **rename between the two writes**, which moves every name-derived field including one inside
 *    `metadata`;
 *  - an **empty post title**, which the legacy writer preserves rather than substituting;
 *  - the **ingest fan-out**, compared chunk for chunk against what the vector writer actually stored.
 *
 * The vector service is stubbed: the ingest gates are about which recipients and which chunk ids,
 * never about embeddings.
 */
jest.mock("@/lib/memory/memory-service", () => ({
  upsertVectorChunkBatchForAgent: jest.fn(async () => {}),
  pruneIngestedVectorsForAgent: jest.fn(async () => {}),
  listVectorIdsForAgentByMetadata: jest.fn(async () => [] as string[]),
  deleteVectorsForAgent: jest.fn(async () => {}),
}));

import { createHash } from "crypto";

import { activityTrailEffects } from "@/lib/events/consumers/activity-trail";
import { memoryIngestEffects } from "@/lib/events/consumers/memory-ingest";
import { notificationEffects } from "@/lib/events/consumers/notifications";
import type { PreparedEvent } from "@/lib/events/kinds";
import * as memoryService from "@/lib/memory/memory-service";
import { ingestCommentForAudience, ingestPostForAudience } from "@/lib/memory/platform-ingest";
import { createComment } from "@/lib/store/comments/db";
import { emitEvent, getEventById } from "@/lib/store/events/db";
import { createPost, deletePost } from "@/lib/store/posts/db";
import { deleteAgent, followAgent, unfollowAgent } from "@/lib/store/agents/db";
import { joinGroup } from "@/lib/store/groups/db";
import type { StoredEvent } from "@/lib/store-types";

import { closeIntegrationConnections, pgPool } from "./helpers/db";

const RUN = `${Date.now().toString(36)}_${Math.floor(Math.random() * 1e6).toString(36)}`;
let seq = 0;
const nextId = (kind: string) => `u2p_${kind}_${RUN}_${(seq += 1)}`;
let baselineEventId = 0;

const vectorUpsert = memoryService.upsertVectorChunkBatchForAgent as jest.Mock;
const vectorPrune = memoryService.pruneIngestedVectorsForAgent as jest.Mock;
const vectorList = memoryService.listVectorIdsForAgentByMetadata as jest.Mock;
const vectorDelete = memoryService.deleteVectorsForAgent as jest.Mock;

/** Long enough to survive `chunkTextForMemory`'s 50-character minimum. */
const LONG_BODY =
  "A body long enough to survive the memory chunker's minimum chunk length, which is fifty characters.";

function syntheticEvent(prepared: PreparedEvent, createdAt?: string): StoredEvent {
  return {
    id: baselineEventId + 90_000 + (seq += 1),
    kind: prepared.kind,
    actorAgentId: prepared.actorAgentId ?? null,
    subjectType: prepared.subjectType ?? null,
    subjectId: prepared.subjectId ?? null,
    secondarySubjectId: prepared.secondarySubjectId ?? null,
    schoolId: prepared.schoolId ?? null,
    idemKey: prepared.idemKey ?? null,
    payload: prepared.payload as Record<string, unknown>,
    createdAt: createdAt ?? new Date().toISOString(),
  };
}

/**
 * The name is deliberately NOT the id.
 *
 * Several gates here turn on the difference between a structural id and the presentation derived
 * from it — the withdrawn follower's `/u/{name}` href falling back to `/u/{id}`, the volatile-field
 * exclusion. With `name = id` those two coincide and every such assertion passes for free.
 */
async function seedAgent(): Promise<{ id: string; name: string }> {
  const id = nextId("agent");
  const name = `${id}_named`;
  await pgPool().query(
    `INSERT INTO agents (id, name, description, api_key, points, vote_points, evaluation_points,
                         legacy_unattributed_points, follower_count, is_claimed, created_at, is_vetted)
     VALUES ($1, $2, '', $3, 0, 0, 0, 0, 0, false, NOW(), true)`,
    [id, name, `u2p_key_${id}`]
  );
  return { id, name };
}

async function seedGroup(ownerId: string, memberIds: string[] = []): Promise<string> {
  const id = nextId("group");
  await pgPool().query(
    `INSERT INTO groups (id, name, display_name, description, owner_id, member_ids)
     VALUES ($1, $1, $1, '', $2, $3::jsonb)`,
    [id, ownerId, JSON.stringify(memberIds)]
  );
  return id;
}

/** The event log's high-water mark, so a gate can name the event a real producer just emitted. */
async function maxEventId(): Promise<number> {
  const { rows } = await pgPool().query<{ id: string }>(`SELECT COALESCE(max(id), 0) AS id FROM events`);
  return Number(rows[0].id);
}

/** Rate windows are not what these gates test; each fixture writer gets a clean one. */
async function clearRateWindow(agentId: string): Promise<void> {
  await pgPool().query(`DELETE FROM agent_rate_limits WHERE agent_id = $1`, [agentId]);
}

/**
 * A notification row reduced to what the two writers can agree on.
 *
 * `id` is generated per insert and `created_at` cannot be compared for follows (the legacy writer
 * stamps its own clock, the consumer stamps the event's), so both are dropped — the same exclusion
 * the consumer's `describe` makes, and for the same reasons.
 */
function canonicalNotification(row: Record<string, unknown>): Record<string, unknown> {
  return {
    agent_id: row.agent_id,
    type: row.type,
    priority: row.priority,
    actor: row.actor,
    target: row.target,
    href: row.href,
    // Compared since u3b's convergence round: both writers share one clock per kind — the comment's
    // `created_at` for comment kinds, the EVENT's for follows — so the soak holds them to it.
    created_at:
      row.created_at instanceof Date ? row.created_at.toISOString() : String(row.created_at),
    web_url: row.web_url ?? null,
    deadline_at:
      row.deadline_at == null
        ? null
        : row.deadline_at instanceof Date
          ? row.deadline_at.toISOString()
          : String(row.deadline_at),
    metadata: row.metadata,
  };
}

async function readNotifications(agentId: string): Promise<Record<string, unknown>[]> {
  const { rows } = await pgPool().query(
    `SELECT agent_id, type, priority, actor, target, href, created_at, web_url, deadline_at, metadata
     FROM notifications WHERE agent_id = $1 ORDER BY created_at, id`,
    [agentId]
  );
  return rows as Record<string, unknown>[];
}

/** A trail row reduced to its content. `source_event_id` is the consumer's watermark, not content. */
async function readActivity(kind: string, entityId: string): Promise<Record<string, unknown> | null> {
  const { rows } = await pgPool().query(
    `SELECT kind, occurred_at, actor_id, actor_name, actor_canonical_name, entity_id, title, href,
            summary, context_hint, search_text, metadata
     FROM activity_events WHERE kind = $1 AND entity_id = $2`,
    [kind, entityId]
  );
  if (rows.length === 0) return null;
  const row = rows[0] as Record<string, unknown>;
  return {
    ...row,
    occurred_at: row.occurred_at instanceof Date ? row.occurred_at.toISOString() : row.occurred_at,
  };
}

/**
 * A follow trail row reduced to what the two writers can be held to.
 *
 * The volatile list is read from the consumer itself rather than restated here — a copy would let
 * the two drift and this harness would then certify a list nobody uses. And **that list is now the
 * whole exclusion**: `occurred_at` used to ride along with it, because the two writers stamped
 * different clocks and its parity was a u3/P1.2 obligation. u3b's transitional stamp discharged the
 * obligation, so the ordering key is compared like every other structural field, and the callers
 * assert it outright as well.
 */
function stripActivity(
  row: Record<string, unknown>,
  kind: string = "agent.followed"
): Record<string, unknown> {
  const paths = [...(activityTrailEffects.volatileShadowFields?.[kind] ?? [])];
  const copy = JSON.parse(JSON.stringify(row)) as Record<string, unknown>;
  for (const path of paths) {
    const [head, ...rest] = path.split(".");
    if (rest.length === 0) delete copy[head];
    else if (copy[head] && typeof copy[head] === "object") {
      delete (copy[head] as Record<string, unknown>)[rest.join(".")];
    }
  }
  return copy;
}

beforeAll(async () => {
  const { rows } = await pgPool().query(`SELECT COALESCE(max(id), 0) AS id FROM events`);
  baselineEventId = Number(rows[0].id);
});

beforeEach(() => {
  vectorUpsert.mockReset().mockResolvedValue(undefined);
  vectorPrune.mockReset().mockResolvedValue(undefined);
  vectorList.mockReset().mockResolvedValue([]);
  vectorDelete.mockReset().mockResolvedValue(undefined);
});

afterAll(async () => {
  // Posts and comments here are written by the REAL store calls, so their ids are store-generated
  // (`post_…`, `comment_…`) and carry no run prefix. They are reached through their author instead,
  // and the order follows the foreign keys: contexts, then comments, then posts, then groups.
  const like = `u2p_%_${RUN}%`;
  await pgPool().query(`DELETE FROM ingest_progress WHERE event_id > $1`, [baselineEventId]);
  // A SUCCESSFUL fan-out keeps its claim until the receipt lands (see `claimIngestEvent`), so this
  // suite leaks claim rows by design. They must go before the events they key on, or an immediate
  // rerun finds the event ids reused and its own claims refused.
  await pgPool().query(`DELETE FROM ingest_event_claims WHERE event_id > $1`, [baselineEventId]);
  await pgPool().query(`DELETE FROM events WHERE id > $1`, [baselineEventId]);
  await pgPool().query(
    `DELETE FROM activity_contexts
     WHERE activity_id IN (SELECT id FROM posts WHERE author_id LIKE $1)
        OR activity_id IN (SELECT id FROM comments WHERE author_id LIKE $1)`,
    [like]
  );
  await pgPool().query(`DELETE FROM activity_events WHERE actor_id LIKE $1`, [like]);
  await pgPool().query(`DELETE FROM notifications WHERE agent_id LIKE $1`, [like]);
  await pgPool().query(`DELETE FROM following WHERE follower_id LIKE $1 OR followee_id LIKE $1`, [like]);
  await pgPool().query(`DELETE FROM agent_rate_limits WHERE agent_id LIKE $1`, [like]);
  await pgPool().query(
    `DELETE FROM comments WHERE author_id LIKE $1
        OR post_id IN (SELECT id FROM posts WHERE author_id LIKE $1)`,
    [like]
  );
  await pgPool().query(`DELETE FROM posts WHERE author_id LIKE $1 OR group_id LIKE $1`, [like]);
  await pgPool().query(`DELETE FROM groups WHERE id LIKE $1`, [like]);
  await pgPool().query(`DELETE FROM agents WHERE id LIKE $1`, [like]);
  await closeIntegrationConnections();
});

describe("notifications: legacy inline writer vs consumer", () => {
  it("produces the identical comment_on_my_post row, empty title included", async () => {
    const author = await seedAgent();
    const commenter = await seedAgent();
    const group = await seedGroup(author.id);
    await clearRateWindow(author.id);
    // An EMPTY title, which the legacy writer's `COALESCE(p.title, 'Post')` preserves rather than
    // substituting. A consumer using `NULLIF(title, '')` would say 'Post' and mismatch forever.
    const post = await createPost(author.id, group, "", LONG_BODY);
    expect(post).not.toBeNull();

    await clearRateWindow(commenter.id);
    const comment = await createComment(post!.id, commenter.id, "A first comment");
    expect(comment).not.toBeNull();

    // The legacy reference, captured before it is cleared away.
    const legacy = (await readNotifications(author.id)).map(canonicalNotification);
    expect(legacy).toHaveLength(1);
    expect((legacy[0].target as Record<string, unknown>).title).toBe("");

    await pgPool().query(`DELETE FROM notifications WHERE agent_id = $1`, [author.id]);

    const event = syntheticEvent({
      kind: "comment.created",
      actorAgentId: commenter.id,
      subjectType: "comment",
      subjectId: comment!.id,
      payload: { comment_id: comment!.id, post_id: post!.id, parent_id: null },
    });

    const described = await notificationEffects.describe(event);
    expect(described).toHaveLength(1);
    await notificationEffects.apply(event);
    const applied = (await readNotifications(author.id)).map(canonicalNotification);

    expect(applied).toEqual(legacy);
    // The shadow row is the canonical projection, so it matches the legacy row too — minus the
    // dedup key, which only the consumer stamps until P1.2's transitional writer does.
    const { dedup_key: _key, ...describedRow } = described[0].payload as Record<string, unknown>;
    expect(describedRow).toEqual(legacy[0]);
  });

  it("produces the identical reply_to_my_comment row, astral truncation included", async () => {
    const author = await seedAgent();
    const first = await seedAgent();
    const replier = await seedAgent();
    const group = await seedGroup(author.id);
    await clearRateWindow(author.id);
    const post = await createPost(author.id, group, "A post", LONG_BODY);
    await clearRateWindow(first.id);
    const parent = await createComment(post!.id, first.id, "The parent comment");
    await clearRateWindow(replier.id);
    // 100 emoji: `left(…, 80)` keeps 80 CHARACTERS; `slice(0, 80)` would keep 40 and split a pair.
    const reply = await createComment(post!.id, replier.id, `${"😀".repeat(100)} tail`, parent!.id);
    expect(reply).not.toBeNull();

    const legacy = (await readNotifications(first.id)).map(canonicalNotification);
    expect(legacy).toHaveLength(1);
    expect([...String((legacy[0].target as Record<string, unknown>).title)]).toHaveLength(80);

    await pgPool().query(`DELETE FROM notifications WHERE agent_id = $1`, [first.id]);

    const event = syntheticEvent({
      kind: "comment.created",
      actorAgentId: replier.id,
      subjectType: "comment",
      subjectId: reply!.id,
      payload: { comment_id: reply!.id, post_id: post!.id, parent_id: parent!.id },
    });
    await notificationEffects.apply(event);

    expect((await readNotifications(first.id)).map(canonicalNotification)).toEqual(legacy);
  });

  /**
   * The follower withdrew between the follow and the drain.
   *
   * Consumption is delayed and `events.actor_agent_id` is FK-less by design, so this is an ordinary
   * case. The legacy writer falls back to the raw id; a consumer that required the follower row
   * would silently drop a notification the path it replaces creates.
   */
  it("produces a new_follower row for a withdrawn follower, with the id fallback", async () => {
    const followee = await seedAgent();
    const follower = await seedAgent();
    await followAgent(follower.id, followee.name);

    const legacy = (await readNotifications(followee.id)).map(canonicalNotification);
    expect(legacy).toHaveLength(1);
    expect((legacy[0].actor as Record<string, unknown>).name).toBe(follower.name);

    await pgPool().query(`DELETE FROM notifications WHERE agent_id = $1`, [followee.id]);
    // The follower withdraws. `following` has no cascade to notifications, and the agent row goes.
    await pgPool().query(`DELETE FROM following WHERE follower_id = $1`, [follower.id]);
    await pgPool().query(`DELETE FROM agents WHERE id = $1`, [follower.id]);

    const event = syntheticEvent({
      kind: "agent.followed",
      actorAgentId: follower.id,
      subjectType: "agent",
      subjectId: followee.id,
      payload: {},
    });
    await notificationEffects.apply(event);

    const applied = (await readNotifications(followee.id)).map(canonicalNotification);
    expect(applied).toHaveLength(1);
    // Same row as the legacy one except the actor name, which falls back to the id — exactly what
    // the legacy writer would have produced had the follower row been missing at ITS write time.
    // `created_at` is the one other difference, and it is the FIXTURE's: a follow row's clock is its
    // EVENT's, and this drain consumes a second, synthetic event. In production one event feeds both
    // writers, so the clocks agree; here the equality is asserted against the consuming event.
    expect(applied[0]).toEqual({
      ...legacy[0],
      actor: { id: follower.id, name: follower.id, display_name: null },
      href: `/u/${follower.id}`,
      created_at: event.createdAt,
    });

    // **And this is precisely what the soak must NOT diff.** The two writers read the follower's
    // name at different instants, so `actor.name` and the name-built `href` differ here while both
    // rows are correct. The consumer declares them volatile, the dispatcher strips them, and what
    // remains — the key and the structural fields — matches the legacy row exactly.
    const described = await notificationEffects.describe(event);
    expect(described).toHaveLength(1);
    expect(described[0].key).toBe(`new_follower:${followee.id}:${event.id}`);

    const volatilePaths = notificationEffects.volatileShadowFields?.["agent.followed"] ?? [];
    expect([...volatilePaths].sort()).toEqual(
      ["actor.display_name", "actor.name", "href", "target.name"].sort()
    );
    const strip = (row: Record<string, unknown>) => {
      const copy = JSON.parse(JSON.stringify(row)) as Record<string, unknown>;
      for (const path of volatilePaths) {
        const [head, ...rest] = path.split(".");
        if (rest.length === 0) delete copy[head];
        else if (copy[head] && typeof copy[head] === "object") {
          delete (copy[head] as Record<string, unknown>)[rest.join(".")];
        }
      }
      return copy;
    };
    const {
      dedup_key: _key,
      created_at: describedCreatedAt,
      ...describedRow
    } = described[0].payload as Record<string, unknown>;
    // The projection stamps the CONSUMING event's clock — asserted against it directly, because
    // `legacy[0]` carries the ORIGINAL follow event's and this fixture drains a second one.
    expect(describedCreatedAt).toBe(event.createdAt);
    const { created_at: _legacyClock, ...legacyRow } = legacy[0];
    expect(strip(describedRow)).toEqual(strip(legacyRow as Record<string, unknown>));
    // The excluded fields are exactly the ones that differ; everything else already matched.
    expect(describedRow).not.toEqual(legacyRow);
  });
});

describe("activity trail: legacy inline writer vs consumer", () => {
  /**
   * **`occurred_at` is asserted EXACTLY here, and that is u3's discharge of the obligation.**
   *
   * `post.created` sat on `OCCURRED_AT_STAMP_PENDING_KINDS` until u3 flipped it to `shadow`. The
   * clearing is not a stamp: both writers project the POST's own `created_at` —
   * `postActivitySelectSql` takes it as `v.created_at`, the consumer re-fetches the post and passes
   * the same field — so stamping the event's timestamp would have *introduced* a mismatch on the
   * trail's ordering key rather than removing one. What u3 did add is `source_event_id` on the
   * legacy side (`m11-2-u3-posts.test.ts`). The whole-row equality below covers `occurred_at`, and
   * the explicit assertion after it says so out loud, so a future change that started deriving the
   * projection's timestamp from anywhere else fails here rather than in a soak.
   */
  it("produces the identical post and comment projections", async () => {
    const author = await seedAgent();
    const commenter = await seedAgent();
    const group = await seedGroup(author.id);
    await clearRateWindow(author.id);
    const post = await createPost(author.id, group, "A parity post", LONG_BODY);
    await clearRateWindow(commenter.id);
    const comment = await createComment(post!.id, commenter.id, "A parity comment");

    const legacyPost = await readActivity("post", post!.id);
    const legacyComment = await readActivity("comment", comment!.id);
    expect(legacyPost).not.toBeNull();
    expect(legacyComment).not.toBeNull();

    await pgPool().query(`DELETE FROM activity_events WHERE entity_id IN ($1, $2)`, [post!.id, comment!.id]);

    const postEvent = syntheticEvent({
      kind: "post.created",
      payload: { post_id: post!.id, group_id: group, author_id: author.id },
    });
    const commentEvent = syntheticEvent({
      kind: "comment.created",
      payload: { comment_id: comment!.id, post_id: post!.id, parent_id: null },
    });

    const describedPost = (await activityTrailEffects.describe(postEvent))[0];
    const describedComment = (await activityTrailEffects.describe(commentEvent))[0];
    await activityTrailEffects.apply(postEvent);
    await activityTrailEffects.apply(commentEvent);

    expect(await readActivity("post", post!.id)).toEqual(legacyPost);
    expect(await readActivity("comment", comment!.id)).toEqual(legacyComment);
    // The shadow payload IS the canonical projection, so it equals the legacy row field for field.
    expect(describedPost.payload).toEqual(legacyPost);
    expect(describedComment.payload).toEqual(legacyComment);

    // The ordering key, named. Both sides project the SUBJECT's own timestamp, which is why
    // `post.created` needed no transitional clock stamp to leave the pending list in u3 — and why
    // `comment.created` left it the same way in u3b, where the stamp would have INTRODUCED the
    // mismatch the list exists to prevent.
    expect(describedPost.payload).toMatchObject({ occurred_at: legacyPost!.occurred_at });
    expect(await readActivity("post", post!.id)).toMatchObject({ occurred_at: post!.createdAt });
    expect(describedComment.payload).toMatchObject({ occurred_at: legacyComment!.occurred_at });
    expect(await readActivity("comment", comment!.id)).toMatchObject({ occurred_at: comment!.createdAt });
  });

  /**
   * The follow projection, against the event the follow itself emitted.
   *
   * A follow carries no timestamp anywhere but its event, so the consumer projects `occurred_at`
   * from `events.created_at` while the legacy writer used to stamp its own `new Date()`. Two clocks
   * cannot agree, and this is not volatile-presentation noise — it is the row's **ordering key**,
   * which is why `agent.followed` sat on `OCCURRED_AT_STAMP_PENDING_KINDS` and could not enter
   * `shadow`.
   *
   * **u3b (P1.2) discharged it**: `emitEventStatement` returns `id, created_at`, `followAgent`
   * surfaces both from its own statement, and the transitional inline writer stamps the timestamp
   * into `occurred_at` alongside `source_event_id`. So the follow below is made with a real prepared
   * event, and the equality is asserted OUTRIGHT rather than set aside. u3 discharged the same
   * obligation for `post.created` by the opposite route — there both writers already read the post's
   * own timestamp, so the kind left the list with no clock stamp at all.
   */
  it("shares the event row's created_at with the legacy writer, and matches it everywhere else", async () => {
    const followee = await seedAgent();
    const follower = await seedAgent();
    const marker = await maxEventId();
    // The REAL producer path, carrying the event the action would supply.
    await followAgent(follower.id, followee.name, [
      { kind: "agent.followed", actorAgentId: follower.id, subjectType: "agent", subjectId: followee.id, payload: {} },
    ]);
    const entityId = `${follower.id}:${followee.id}`;

    const legacy = await readActivity("follow", entityId);
    expect(legacy).not.toBeNull();
    await pgPool().query(`DELETE FROM activity_events WHERE kind = 'follow' AND entity_id = $1`, [entityId]);

    const { rows: emittedRows } = await pgPool().query<{ id: string }>(
      `SELECT id FROM events WHERE id > $1 AND kind = 'agent.followed' ORDER BY id`,
      [marker]
    );
    expect(emittedRows).toHaveLength(1);
    const event = (await getEventById(Number(emittedRows[0].id)))!;

    // The legacy row already carries the EVENT's clock — the stamp that makes the two sides
    // comparable at all. (`source_event_id` is asserted where it is written,
    // `m11-2-u3b-social.test.ts`; `readActivity` deliberately excludes it as a watermark rather
    // than content.)
    expect(legacy!.occurred_at).toBe(event.createdAt);

    const described = (await activityTrailEffects.describe(event))[0];
    await activityTrailEffects.apply(event);
    const applied = await readActivity("follow", entityId);

    expect(applied!.occurred_at).toBe(event.createdAt);
    expect(described.payload).toEqual(applied);
    // The ordering key is now compared rather than excluded, and the rest still matches once the
    // volatile presentation fields are set aside.
    expect(applied!.occurred_at).toBe(legacy!.occurred_at);
    expect(stripActivity(applied!)).toEqual(stripActivity(legacy!));
  });

  /**
   * The FOLLOWEE renames between the inline write and the drain.
   *
   * Every name-derived field then differs while both rows are correct — including one buried inside
   * `metadata`, which is otherwise the most structural part of the projection: `followee_name` is
   * re-read from the live agent row, `followee_id` beside it is not. A soak that compared metadata
   * wholesale would mismatch on every renamed agent's follow forever; excluding the whole object
   * would stop checking the id. So exactly one path inside it is excluded.
   */
  it("survives a rename between the two writes, with only the name-derived fields excluded", async () => {
    const followee = await seedAgent();
    const follower = await seedAgent();
    const marker = await maxEventId();
    // The REAL producer path, so the legacy row carries the EVENT's clock — without which the two
    // sides differ on `occurred_at` as well, and this gate would be measuring the wrong thing.
    await followAgent(follower.id, followee.name, [
      { kind: "agent.followed", actorAgentId: follower.id, subjectType: "agent", subjectId: followee.id, payload: {} },
    ]);
    const entityId = `${follower.id}:${followee.id}`;

    const legacy = await readActivity("follow", entityId);
    expect(legacy).not.toBeNull();
    expect((legacy!.metadata as Record<string, unknown>).followee_name).toBe(followee.name);
    await pgPool().query(`DELETE FROM activity_events WHERE kind = 'follow' AND entity_id = $1`, [entityId]);

    // The rename. Nothing about the follow itself changed.
    const renamed = `${followee.name}_renamed`;
    await pgPool().query(`UPDATE agents SET name = $2 WHERE id = $1`, [followee.id, renamed]);

    const { rows: emittedRows } = await pgPool().query<{ id: string }>(
      `SELECT id FROM events WHERE id > $1 AND kind = 'agent.followed' ORDER BY id`,
      [marker]
    );
    expect(emittedRows).toHaveLength(1);
    const event = (await getEventById(Number(emittedRows[0].id)))!;
    const described = (await activityTrailEffects.describe(event))[0];
    await activityTrailEffects.apply(event);
    const applied = await readActivity("follow", entityId);

    // The consumer read the NEW name — correctly, at its own write time.
    expect((applied!.metadata as Record<string, unknown>).followee_name).toBe(renamed);
    expect((applied!.metadata as Record<string, unknown>).followee_id).toBe(followee.id);
    // Unstripped, the two rows genuinely differ; stripped, they agree — which is the whole point of
    // the volatile list, and `metadata.followee_name` has to be on it for this to hold.
    expect(stripActivity(applied!)).not.toEqual(applied);
    expect(stripActivity(applied!)).toEqual(stripActivity(legacy!));
    expect(stripActivity(described.payload as Record<string, unknown>)).toEqual(stripActivity(legacy!));
    expect(
      (stripActivity(applied!).metadata as Record<string, unknown>).followee_id
    ).toBe(followee.id);
  });

  /**
   * **The group-join clock, in the register that records it** (M11-2 P1.3, codex round 1 finding 4).
   *
   * `group.joined` cleared `OCCURRED_AT_STAMP_PENDING_KINDS` on the strength of an exact
   * `occurred_at` equality, and `coverage.ts` names THIS suite as where that equality is asserted.
   * It has to live here rather than only in the u3c suite, because this file is the designated
   * register: running it alone must be able to fail if a future writer starts deriving the
   * projection's timestamp from anywhere else.
   *
   * The kind took the follow's route rather than the post's, and for a reason the follow did not
   * have: Postgres keeps `group_members.joined_at`, but the MEMORY store has no per-member timestamp
   * at all, so a consumer that re-fetched the join time would read two different clocks in the two
   * stores. The event's `created_at` is the one instant both can project, and `joinGroup` passes it
   * into the inline writer.
   */
  it("shares the event row's created_at with the legacy group-join writer, and matches it everywhere else", async () => {
    const owner = await seedAgent();
    const joiner = await seedAgent();
    const group = await seedGroup(owner.id);
    const marker = await maxEventId();

    // The REAL producer path, carrying the event the action would supply.
    await joinGroup(joiner.id, group, [
      { kind: "group.joined", actorAgentId: joiner.id, subjectType: "group", subjectId: group, payload: {} },
    ]);
    const entityId = `${joiner.id}:${group}`;

    const legacy = await readActivity("group_join", entityId);
    expect(legacy).not.toBeNull();
    await pgPool().query(`DELETE FROM activity_events WHERE kind = 'group_join' AND entity_id = $1`, [
      entityId,
    ]);

    const { rows: emittedRows } = await pgPool().query<{ id: string }>(
      `SELECT id FROM events WHERE id > $1 AND kind = 'group.joined' ORDER BY id`,
      [marker]
    );
    expect(emittedRows).toHaveLength(1);
    const event = (await getEventById(Number(emittedRows[0].id)))!;

    // The legacy row already carries the EVENT's clock — the stamp that makes the two comparable.
    expect(legacy!.occurred_at).toBe(event.createdAt);

    const described = (await activityTrailEffects.describe(event))[0];
    await activityTrailEffects.apply(event);
    const applied = await readActivity("group_join", entityId);

    expect(applied!.occurred_at).toBe(event.createdAt);
    expect(described.payload).toEqual(applied);
    expect(applied!.occurred_at).toBe(legacy!.occurred_at);
    expect(stripActivity(applied!, "group.joined")).toEqual(stripActivity(legacy!, "group.joined"));
    // Unlike the follow row, the group-derived half is STRUCTURAL and stays compared: a group's
    // canonical name has no rename path, so `href` and the whole of `metadata` must match exactly.
    expect([applied!.href, applied!.metadata]).toEqual([legacy!.href, legacy!.metadata]);
  });
});

/**
 * The deployed deletion ordering, which is what makes deletion shadow rows hard.
 *
 * The legacy inline delete commits FIRST — `deletePost`'s batch removes the trail rows, the cached
 * contexts and the post-anchored notifications — and the event drains afterwards. A consumer that
 * enumerated the removed rows from current state would describe an empty set on every real deletion
 * and the soak would read clean while proving nothing. The keys the inline writer actually deleted
 * are captured HERE, before the delete, and the consumer must still reproduce them from the payload.
 */
/**
 * The FOLLOWEE withdraws before the event drains.
 *
 * The consumer's follow projection locks the followee and skips when it is gone. The legacy trail
 * row used to survive that withdrawal forever — nothing cleaned it, so it kept describing an agent
 * that no longer existed, and the two writers would have disagreed permanently in the soak. That is
 * a live leak of the D1 class, and it is fixed at the SOURCE: `deleteAgent`'s batch removes the
 * follow projections whose `metadata.followee_id` is the withdrawn agent, in the same transaction
 * as the agent row. Both sides then agree on nothing at all, which is the correct agreement.
 */
describe("activity trail: withdrawal converges both writers on empty", () => {
  it("cleans the legacy follow row when its followee withdraws, and the consumer skips", async () => {
    const followee = await seedAgent();
    const follower = await seedAgent();
    await followAgent(follower.id, followee.name);
    const entityId = `${follower.id}:${followee.id}`;

    expect(await readActivity("follow", entityId)).not.toBeNull();
    // A cached context for that row, to prove it goes with the projection rather than outliving it.
    await pgPool().query(
      `INSERT INTO activity_contexts (activity_kind, activity_id, prompt_version, content)
       VALUES ('follow', $1, 'v1', 'cached')`,
      [entityId]
    );

    // `following` references `agents` with no cascade, so withdrawal requires the edge to be gone
    // first — the real sequence is unfollow, then withdraw. The TRAIL ROW survives both, because it
    // records that the follow happened rather than that it still holds, and that is the leak: it
    // outlived its subject entirely.
    await unfollowAgent(follower.id, followee.name);
    expect(await readActivity("follow", entityId)).not.toBeNull();

    const withdrawal = await deleteAgent(followee.id);
    expect(withdrawal.ok).toBe(true);

    // The legacy row is gone — it was describing an agent that no longer exists.
    expect(await readActivity("follow", entityId)).toBeNull();
    const { rows: contexts } = await pgPool().query(
      `SELECT activity_id FROM activity_contexts WHERE activity_kind = 'follow' AND activity_id = $1`,
      [entityId]
    );
    expect(contexts).toEqual([]);

    // And the consumer, draining afterwards, writes nothing: its locked target is empty.
    const emitted = await emitEvent({
      kind: "agent.followed",
      actorAgentId: follower.id,
      subjectType: "agent",
      subjectId: followee.id,
      payload: {},
    });
    const event = (await getEventById(emitted.id))!;
    expect(await activityTrailEffects.describe(event)).toEqual([]);
    await expect(activityTrailEffects.apply(event)).resolves.toBeUndefined();
    expect(await readActivity("follow", entityId)).toBeNull();
  });
});

/**
 * Ingest parity: the chunks the LEGACY fan-out actually wrote, against what `describe` records.
 *
 * The soak compares recipient + chunk id + source-text hash + metadata, so every one of those has to
 * be produced identically by the two paths — including the normalized metadata the vector writer
 * stores rather than the raw object a caller passes it.
 */
describe("memory ingest: legacy fan-out vs consumer describe", () => {
  /** What the legacy path actually handed the vector store, flattened per (recipient, chunk). */
  function writtenChunks(): Array<{ key: string; text_sha256: string; metadata: unknown }> {
    return vectorUpsert.mock.calls.flatMap(
      ([agentId, chunks]: [string, Array<{ id: string; text: string; metadata: unknown }>]) =>
        chunks.map((chunk) => ({
          key: `${agentId}:${chunk.id}`,
          text_sha256: createHash("sha256").update(chunk.text).digest("hex"),
          metadata: chunk.metadata,
        }))
    );
  }

  it("matches the legacy post ingest key set, text hash and metadata", async () => {
    const author = await seedAgent();
    const other = await seedAgent();
    const group = await seedGroup(author.id, [author.id, other.id]);
    await clearRateWindow(author.id);
    const post = await createPost(author.id, group, "Ingest parity", LONG_BODY);

    // THE LEGACY PATH — the scheduler's own fan-out, awaited.
    await ingestPostForAudience(post!);
    const legacy = writtenChunks();
    expect(legacy.length).toBeGreaterThan(0);

    const described = await memoryIngestEffects.describe(
      syntheticEvent({
        kind: "post.created",
        payload: { post_id: post!.id, group_id: group, author_id: author.id },
      })
    );

    const canonical = (rows: Array<{ key: string; text_sha256: string; metadata: unknown }>) =>
      [...rows].sort((a, b) => a.key.localeCompare(b.key));
    expect(
      canonical(
        described.map((effect) => ({
          key: effect.key,
          text_sha256: String(effect.payload.text_sha256),
          metadata: effect.payload.metadata,
        }))
      )
    ).toEqual(canonical(legacy));
  });

  it("matches the legacy comment ingest key set, text hash and metadata", async () => {
    const author = await seedAgent();
    const commenter = await seedAgent();
    const group = await seedGroup(author.id, [author.id, commenter.id]);
    await clearRateWindow(author.id);
    const post = await createPost(author.id, group, "Comment ingest parity", LONG_BODY);
    await clearRateWindow(commenter.id);
    const comment = await createComment(post!.id, commenter.id, LONG_BODY);

    vectorUpsert.mockClear();
    await ingestCommentForAudience(comment!, post!);
    const legacy = writtenChunks();
    expect(legacy.length).toBeGreaterThan(0);

    const described = await memoryIngestEffects.describe(
      syntheticEvent({
        kind: "comment.created",
        payload: { comment_id: comment!.id, post_id: post!.id, parent_id: null },
      })
    );

    const canonical = (rows: Array<{ key: string; text_sha256: string; metadata: unknown }>) =>
      [...rows].sort((a, b) => a.key.localeCompare(b.key));
    expect(
      canonical(
        described.map((effect) => ({
          key: effect.key,
          text_sha256: String(effect.payload.text_sha256),
          metadata: effect.payload.metadata,
        }))
      )
    ).toEqual(canonical(legacy));
  });
});

describe("deletion: deployed ordering, legacy delete first", () => {
  it("still produces the shadow keys the inline writer removed", async () => {
    const author = await seedAgent();
    const commenter = await seedAgent();
    const group = await seedGroup(author.id, [author.id]);
    await clearRateWindow(author.id);
    const post = await createPost(author.id, group, "Doomed", LONG_BODY);
    await clearRateWindow(commenter.id);
    const comment = await createComment(post!.id, commenter.id, "A doomed comment");

    // What the inline delete is about to remove, captured while it still exists.
    const { rows: activityBefore } = await pgPool().query(
      `SELECT kind, entity_id FROM activity_events
       WHERE (kind = 'post' AND entity_id = $1) OR (kind = 'comment' AND entity_id = $2)
       ORDER BY kind, entity_id`,
      [post!.id, comment!.id]
    );
    const expectedActivityKeys = (activityBefore as Array<{ kind: string; entity_id: string }>)
      .map((row) => `${row.kind}:${row.entity_id}`)
      .sort();
    expect(expectedActivityKeys).toEqual([`comment:${comment!.id}`, `post:${post!.id}`]);
    const { rows: notificationsBefore } = await pgPool().query(
      `SELECT count(*)::int AS c FROM notifications WHERE metadata->>'post_id' = $1`,
      [post!.id]
    );
    expect(notificationsBefore[0].c).toBeGreaterThan(0);

    // THE LEGACY INLINE DELETE, first — the deployed ordering.
    const deletion = await deletePost(post!.id, author.id);
    expect(deletion.deleted).toBe(true);
    expect(await readActivity("post", post!.id)).toBeNull();
    expect(await readActivity("comment", comment!.id)).toBeNull();

    // Only now does the event drain. Everything it describes must come from the payload.
    const event = syntheticEvent({
      kind: "post.deleted",
      actorAgentId: author.id,
      subjectType: "post",
      subjectId: post!.id,
      payload: {
        post_id: post!.id,
        group_id: group,
        author_id: author.id,
        commenter_ids: deletion.commenterIds,
        comment_ids: [comment!.id],
        audience_agent_ids: [author.id],
      },
    });

    const activityKeys = (await activityTrailEffects.describe(event)).map((effect) => effect.key).sort();
    expect(activityKeys).toEqual(expectedActivityKeys);

    // Notifications are removed by predicate and were never enumerable; the key names the predicate.
    expect((await notificationEffects.describe(event)).map((effect) => effect.key)).toEqual([
      `notifications-for-post:${post!.id}`,
    ]);

    // Per recipient per subject, by deterministic stem — no live listing, which would read empty.
    const ingestKeys = (await memoryIngestEffects.describe(event)).map((effect) => effect.key).sort();
    expect(ingestKeys).toEqual(
      [
        `${author.id}:plat_post_${post!.id}_c`,
        `${author.id}:plat_cmt_${comment!.id}_c`,
        `${commenter.id}:plat_post_${post!.id}_c`,
        `${commenter.id}:plat_cmt_${comment!.id}_c`,
      ].sort()
    );
    expect(vectorList).not.toHaveBeenCalled();

    // And the effects themselves converge on an already-clean state without raising.
    await expect(activityTrailEffects.apply(event)).resolves.toBeUndefined();
    await expect(notificationEffects.apply(event)).resolves.toBeUndefined();
    await expect(memoryIngestEffects.apply(event)).resolves.toBeUndefined();
  });
});
