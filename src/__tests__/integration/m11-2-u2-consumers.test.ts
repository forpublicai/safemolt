/**
 * M11-2 u2 `[integration]` — the three consumers against the real database.
 *
 * No producer emits yet (P1.1/P1.2 are u3), so every effect here is driven by DIRECT INVOCATION
 * with synthetic events — plus one end-to-end pass through the real drain, which is the only way to
 * prove the drain↔consumer contract before the producers exist.
 *
 * What only a database can show, and what this file is for:
 *  - the locked target inside the writing statement: a projection whose subject was deleted writes
 *    nothing, and the deleted post never reappears on the trail;
 *  - the monotonic source-event guard, whose whole purpose is a REVERSE-ORDER application that a
 *    single-writer test can never produce;
 *  - the `dedup_key` unique index holding under two genuinely concurrent applications;
 *  - the recipient-progress ledger surviving a mid-fan-out failure, which needs durable rows.
 *
 * The vector service is stubbed: the ingest gates are about which recipients were processed and
 * recorded, never about embeddings.
 */
jest.mock("@/lib/memory/memory-service", () => ({
  upsertVectorChunkBatchForAgent: jest.fn(async () => {}),
  pruneIngestedVectorsForAgent: jest.fn(async () => {}),
  listVectorIdsForAgentByMetadata: jest.fn(async () => [] as string[]),
  deleteVectorsForAgent: jest.fn(async () => {}),
}));

import { activityTrailEffects } from "@/lib/events/consumers/activity-trail";
import { defineConsumer } from "@/lib/events/consumers/dispatch";
import { memoryIngestEffects } from "@/lib/events/consumers/memory-ingest";
import { notificationEffects } from "@/lib/events/consumers/notifications";
import type { CoverageManifest, CoverageState } from "@/lib/events/consumers/coverage";
import { EVENT_KINDS, type EventKind, type PreparedEvent } from "@/lib/events/kinds";
import { applyFollowActivityFromEvent } from "@/lib/store/activity/events";
import { emitEvent } from "@/lib/store/events/db";
import { activateEventConsumer, drainEventConsumer } from "@/lib/store/events/drain-db";
import * as memoryService from "@/lib/memory/memory-service";
import type { StoredEvent } from "@/lib/store-types";

import { pidOf, runConcurrently, rejections, waitForWaiter } from "./helpers/concurrency";
import { closeIntegrationConnections, pgClient, pgPool } from "./helpers/db";

const RUN = `${Date.now().toString(36)}_${Math.floor(Math.random() * 1e6).toString(36)}`;
let seq = 0;
const nextId = (kind: string) => `u2c_${kind}_${RUN}_${(seq += 1)}`;

let baselineEventId = 0;
const CONSUMER_NAMES: string[] = [];
const consumerName = (suffix: string) => {
  const name = `u2c_${suffix}_${RUN}`;
  CONSUMER_NAMES.push(name);
  return name;
};

const vectorUpsert = memoryService.upsertVectorChunkBatchForAgent as jest.Mock;
const vectorPrune = memoryService.pruneIngestedVectorsForAgent as jest.Mock;
const vectorList = memoryService.listVectorIdsForAgentByMetadata as jest.Mock;
const vectorDelete = memoryService.deleteVectorsForAgent as jest.Mock;

/** A manifest with every kind at `none` except the named ones. */
function manifestWith(state: CoverageState, kinds: EventKind[]): CoverageManifest {
  const manifest = Object.fromEntries(EVENT_KINDS.map((kind) => [kind, "none"])) as CoverageManifest;
  for (const kind of kinds) manifest[kind] = state;
  return manifest;
}

/** A synthetic event as the drain would hand it to a consumer. */
function syntheticEvent(
  id: number,
  prepared: PreparedEvent & { createdAt?: string }
): StoredEvent {
  return {
    id,
    kind: prepared.kind,
    actorAgentId: prepared.actorAgentId ?? null,
    subjectType: prepared.subjectType ?? null,
    subjectId: prepared.subjectId ?? null,
    secondarySubjectId: prepared.secondarySubjectId ?? null,
    schoolId: prepared.schoolId ?? null,
    idemKey: prepared.idemKey ?? null,
    payload: prepared.payload as Record<string, unknown>,
    createdAt: prepared.createdAt ?? new Date().toISOString(),
  };
}

async function seedAgent(): Promise<string> {
  const id = nextId("agent");
  await pgPool().query(
    `INSERT INTO agents (id, name, description, api_key, points, vote_points, evaluation_points,
                         legacy_unattributed_points, follower_count, is_claimed, created_at, is_vetted)
     VALUES ($1, $1, '', $2, 0, 0, 0, 0, 0, false, NOW(), true)`,
    [id, `u2c_key_${id}`]
  );
  return id;
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

/**
 * Bodies are deliberately long: `chunkTextForMemory` drops anything under `MIN_CHUNK_CHARS` (50),
 * so a terse fixture produces zero chunks and every ingest gate would pass vacuously.
 */
const LONG_BODY =
  "A body long enough to survive the memory chunker's minimum chunk length, which is fifty characters.";

async function seedPost(authorId: string, groupId: string, title = "Hello"): Promise<string> {
  const id = nextId("post");
  await pgPool().query(
    `INSERT INTO posts (id, title, content, author_id, group_id, created_at)
     VALUES ($1, $2, $5, $3, $4, NOW())`,
    [id, title, authorId, groupId, LONG_BODY]
  );
  return id;
}

async function seedComment(
  postId: string,
  authorId: string,
  content = LONG_BODY,
  parentId: string | null = null
): Promise<string> {
  const id = nextId("comment");
  await pgPool().query(
    `INSERT INTO comments (id, post_id, author_id, content, parent_id, created_at)
     VALUES ($1, $2, $3, $4, $5, NOW())`,
    [id, postId, authorId, content, parentId]
  );
  return id;
}

async function softDeletePost(postId: string, agentId: string): Promise<void> {
  await pgPool().query(
    `UPDATE posts SET deleted_at = NOW(), deleted_by_agent_id = $2, deleted_karma_reversed_at = NOW()
     WHERE id = $1`,
    [postId, agentId]
  );
}

/**
 * The recipients this event has FINISHED.
 *
 * A row means claimed-or-completed since the leased-claim change, so a recipient that was attempted
 * and released still has a row. `completed_at IS NOT NULL` is the only "done", and it is what every
 * assertion below means.
 */
async function progressRecipients(eventId: number): Promise<string[]> {
  const { rows } = await pgPool().query(
    `SELECT recipient_agent_id FROM ingest_progress
     WHERE event_id = $1 AND completed_at IS NOT NULL ORDER BY recipient_agent_id`,
    [eventId]
  );
  return (rows as Array<{ recipient_agent_id: string }>).map((row) => row.recipient_agent_id);
}

async function activityRow(kind: string, entityId: string) {
  const { rows } = await pgPool().query(
    `SELECT title, summary, source_event_id FROM activity_events WHERE kind = $1 AND entity_id = $2`,
    [kind, entityId]
  );
  return rows[0] as { title: string; summary: string; source_event_id: string | null } | undefined;
}

async function notificationsFor(agentId: string) {
  const { rows } = await pgPool().query(
    `SELECT id, type, dedup_key, metadata FROM notifications WHERE agent_id = $1 ORDER BY dedup_key`,
    [agentId]
  );
  return rows as Array<{ id: string; type: string; dedup_key: string; metadata: Record<string, unknown> }>;
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
  const like = `u2c_%_${RUN}%`;
  await pgPool().query(`DELETE FROM event_consumer_shadow WHERE consumer = ANY($1::text[])`, [CONSUMER_NAMES]);
  await pgPool().query(`DELETE FROM event_receipts WHERE consumer = ANY($1::text[])`, [CONSUMER_NAMES]);
  await pgPool().query(`DELETE FROM event_consumer_failures WHERE consumer = ANY($1::text[])`, [CONSUMER_NAMES]);
  await pgPool().query(`DELETE FROM event_dead_letters WHERE consumer = ANY($1::text[])`, [CONSUMER_NAMES]);
  await pgPool().query(`DELETE FROM event_consumers WHERE consumer = ANY($1::text[])`, [CONSUMER_NAMES]);
  await pgPool().query(`DELETE FROM ingest_progress WHERE event_id > $1`, [baselineEventId]);
  await pgPool().query(`DELETE FROM ingest_event_claims WHERE event_id > $1`, [baselineEventId]);
  await pgPool().query(`DELETE FROM events WHERE id > $1`, [baselineEventId]);
  await pgPool().query(`DELETE FROM activity_contexts WHERE activity_id LIKE $1`, [like]);
  await pgPool().query(`DELETE FROM activity_events WHERE entity_id LIKE $1`, [like]);
  await pgPool().query(`DELETE FROM notifications WHERE agent_id LIKE $1`, [like]);
  await pgPool().query(`DELETE FROM comments WHERE id LIKE $1`, [like]);
  await pgPool().query(`DELETE FROM posts WHERE id LIKE $1`, [like]);
  await pgPool().query(`DELETE FROM groups WHERE id LIKE $1`, [like]);
  await pgPool().query(`DELETE FROM agents WHERE id LIKE $1`, [like]);
  await closeIntegrationConnections();
});

describe("activity-trail consumer", () => {
  it("writes the projection and stamps the source event", async () => {
    const author = await seedAgent();
    const group = await seedGroup(author);
    const post = await seedPost(author, group, "Live post");

    await activityTrailEffects.apply(
      syntheticEvent(baselineEventId + 1001, {
        kind: "post.created",
        payload: { post_id: post, group_id: group, author_id: author },
      })
    );

    const row = await activityRow("post", post);
    expect(row?.title).toBe("Live post");
    expect(Number(row?.source_event_id)).toBe(baselineEventId + 1001);
  });

  /**
   * The locked target, tested where the re-fetch cannot mask it.
   *
   * `apply` re-fetches and would skip a tombstone before reaching SQL, so this drives the store
   * path DIRECTLY with an input read while the post was alive — exactly the state a consumer that
   * paused mid-effect would hold. The empty locked target must write nothing and raise nothing.
   */
  it("writes nothing when the locked target is gone, and raises nothing", async () => {
    const author = await seedAgent();
    const group = await seedGroup(author);
    const post = await seedPost(author, group, "Doomed post");
    await softDeletePost(post, author);

    const { applyPostActivityFromEvent } = await import("@/lib/store/activity/events");
    await expect(
      applyPostActivityFromEvent(
        {
          id: post,
          authorId: author,
          groupId: group,
          title: "Doomed post",
          content: "Body",
          createdAt: new Date().toISOString(),
        },
        baselineEventId + 1002
      )
    ).resolves.toBeUndefined();

    expect(await activityRow("post", post)).toBeUndefined();
  });

  /**
   * Delete-then-create convergence, both halves in one flow: the deletion effect removes the post's
   * row, its comments' rows and their cached contexts, and a `post.created` consumed AFTERWARDS
   * finds an empty target and skips. The deleted post never reappears on the trail.
   */
  it("converges when the create effect arrives after the deletion effect", async () => {
    const author = await seedAgent();
    const commenter = await seedAgent();
    const group = await seedGroup(author);
    const post = await seedPost(author, group, "Vanishing post");
    const comment = await seedComment(post, commenter);

    await activityTrailEffects.apply(
      syntheticEvent(baselineEventId + 1010, {
        kind: "post.created",
        payload: { post_id: post, group_id: group, author_id: author },
      })
    );
    await activityTrailEffects.apply(
      syntheticEvent(baselineEventId + 1011, {
        kind: "comment.created",
        payload: { comment_id: comment, post_id: post, parent_id: null },
      })
    );
    await pgPool().query(
      `INSERT INTO activity_contexts (activity_kind, activity_id, prompt_version, content)
       VALUES ('post', $1, 'v1', 'cached'), ('comment', $2, 'v1', 'cached')`,
      [post, comment]
    );
    expect(await activityRow("post", post)).toBeDefined();
    expect(await activityRow("comment", comment)).toBeDefined();

    await softDeletePost(post, author);
    await activityTrailEffects.apply(
      syntheticEvent(baselineEventId + 1012, {
        kind: "post.deleted",
        payload: {
          post_id: post,
          group_id: group,
          author_id: author,
          commenter_ids: [commenter],
          comment_ids: [],
          audience_agent_ids: [author],
        },
      })
    );

    expect(await activityRow("post", post)).toBeUndefined();
    expect(await activityRow("comment", comment)).toBeUndefined();
    const { rows: contexts } = await pgPool().query(
      `SELECT activity_id FROM activity_contexts WHERE activity_id = ANY($1::text[])`,
      [[post, comment]]
    );
    expect(contexts).toEqual([]);

    // The late create effect. Its re-fetch skips first; the locked target would stop it anyway.
    await activityTrailEffects.apply(
      syntheticEvent(baselineEventId + 1013, {
        kind: "post.created",
        payload: { post_id: post, group_id: group, author_id: author },
      })
    );
    expect(await activityRow("post", post)).toBeUndefined();

    // Idempotent: a replayed deletion effect changes nothing and raises nothing.
    await expect(
      activityTrailEffects.apply(
        syntheticEvent(baselineEventId + 1014, {
          kind: "post.deleted",
          payload: {
            post_id: post,
            group_id: group,
            author_id: author,
            commenter_ids: [commenter],
          comment_ids: [],
            audience_agent_ids: [author],
          },
        })
      )
    ).resolves.toBeUndefined();
  });

  /**
   * The monotonic guard, on the natural key that actually reuses itself: one `follower:followee`
   * activity row survives every re-follow. Consumption is unordered, so a lower event id landing
   * after a higher one must not drag the row backward.
   */
  it("refuses an older source event and lets a legacy NULL row yield", async () => {
    const follower = await seedAgent();
    const followee = await seedAgent();
    const entityId = `${follower}:${followee}`;

    await applyFollowActivityFromEvent(
      {
        followerId: follower,
        followeeId: followee,
        followeeName: followee,
        followeeDisplayName: "Newer label",
        createdAt: new Date().toISOString(),
      },
      baselineEventId + 2002
    );
    expect((await activityRow("follow", entityId))?.title).toContain("Newer label");

    await applyFollowActivityFromEvent(
      {
        followerId: follower,
        followeeId: followee,
        followeeName: followee,
        followeeDisplayName: "Older label",
        createdAt: new Date().toISOString(),
      },
      baselineEventId + 1001
    );
    const afterOlder = await activityRow("follow", entityId);
    expect(afterOlder?.title).toContain("Newer label");
    expect(Number(afterOlder?.source_event_id)).toBe(baselineEventId + 2002);

    // A legacy row carries NULL and must yield to ANY event — `COALESCE(source_event_id, 0)`.
    await pgPool().query(`UPDATE activity_events SET source_event_id = NULL WHERE kind = 'follow' AND entity_id = $1`, [
      entityId,
    ]);
    await applyFollowActivityFromEvent(
      {
        followerId: follower,
        followeeId: followee,
        followeeName: followee,
        followeeDisplayName: "Legacy yields",
        createdAt: new Date().toISOString(),
      },
      baselineEventId + 1
    );
    const afterLegacy = await activityRow("follow", entityId);
    expect(afterLegacy?.title).toContain("Legacy yields");
    expect(Number(afterLegacy?.source_event_id)).toBe(baselineEventId + 1);
  });
});

describe("notifications consumer", () => {
  it("is idempotent under replay and under two concurrent applications", async () => {
    const author = await seedAgent();
    const commenter = await seedAgent();
    const group = await seedGroup(author);
    const post = await seedPost(author, group);
    const comment = await seedComment(post, commenter);
    const event = syntheticEvent(baselineEventId + 3001, {
      kind: "comment.created",
      payload: { comment_id: comment, post_id: post, parent_id: null },
    });

    await notificationEffects.apply(event);
    await notificationEffects.apply(event);
    expect(await notificationsFor(author)).toHaveLength(1);

    // Two drainers on one event. The dedup index decides; neither may surface an error, because a
    // propagating unique violation during the dual-write phase would 500 a comment that succeeded.
    await pgPool().query(`DELETE FROM notifications WHERE agent_id = $1`, [author]);
    const outcomes = await runConcurrently([
      () => notificationEffects.apply(event),
      () => notificationEffects.apply(event),
    ]);
    expect(rejections(outcomes)).toEqual([]);
    const rows = await notificationsFor(author);
    expect(rows).toHaveLength(1);
    expect(rows[0].dedup_key).toBe(`comment_on_my_post:${author}:${baselineEventId + 3001}`);
  });

  it("converges in both orders: consume-then-delete removes, delete-then-consume never creates", async () => {
    const author = await seedAgent();
    const commenter = await seedAgent();
    const group = await seedGroup(author);

    // Order 1 — consume, then delete.
    const firstPost = await seedPost(author, group);
    const firstComment = await seedComment(firstPost, commenter);
    await notificationEffects.apply(
      syntheticEvent(baselineEventId + 3101, {
        kind: "comment.created",
        payload: { comment_id: firstComment, post_id: firstPost, parent_id: null },
      })
    );
    expect(await notificationsFor(author)).toHaveLength(1);

    await softDeletePost(firstPost, author);
    await notificationEffects.apply(
      syntheticEvent(baselineEventId + 3102, {
        kind: "post.deleted",
        payload: {
          post_id: firstPost,
          group_id: group,
          author_id: author,
          commenter_ids: [commenter],
          comment_ids: [],
          audience_agent_ids: [author],
        },
      })
    );
    expect(await notificationsFor(author)).toEqual([]);

    // Order 2 — delete, then consume. The re-fetch is what stops a fresh dead-link row.
    const secondPost = await seedPost(author, group);
    const secondComment = await seedComment(secondPost, commenter);
    await softDeletePost(secondPost, author);
    await notificationEffects.apply(
      syntheticEvent(baselineEventId + 3103, {
        kind: "comment.created",
        payload: { comment_id: secondComment, post_id: secondPost, parent_id: null },
      })
    );
    expect(await notificationsFor(author)).toEqual([]);
  });
});

describe("memory-ingest consumer", () => {
  /** Every recipient the stub was asked to write for, in order, successes and failures alike. */
  function recordedRecipients(): string[] {
    return vectorUpsert.mock.calls.map((call) => call[0] as string);
  }

  it("resumes at the first unrecorded recipient after a mid-fan-out failure", async () => {
    const author = await seedAgent();
    const others = [await seedAgent(), await seedAgent(), await seedAgent(), await seedAgent()];
    const group = await seedGroup(author, [author, ...others]);
    const post = await seedPost(author, group);
    const eventId = baselineEventId + 4001;
    const event = syntheticEvent(eventId, {
      kind: "post.created",
      payload: { post_id: post, group_id: group, author_id: author },
    });

    // The audience is author-first, then the group's members in order — five distinct agents.
    const audience = [author, ...others];
    const failing = audience[2];
    vectorUpsert.mockImplementation(async (agentId: string) => {
      if (agentId === failing) throw new Error("vector service unavailable");
    });

    await expect(memoryIngestEffects.apply(event)).rejects.toThrow("vector service unavailable");
    // Two recipients recorded — the third failed, so the drain sees no receipt and will retry.
    expect(await progressRecipients(eventId)).toEqual([...audience.slice(0, 2)].sort());
    expect(recordedRecipients()).toEqual(audience.slice(0, 3));

    vectorUpsert.mockImplementation(async () => {});
    await expect(memoryIngestEffects.apply(event)).resolves.toBeUndefined();
    expect(await progressRecipients(eventId)).toEqual([...audience].sort());
    // The two already-recorded recipients are NOT ingested again; the retry resumes at the third.
    expect(recordedRecipients()).toEqual([...audience.slice(0, 3), ...audience.slice(2)]);
  });

  it("writes recipient-scoped shadow rows once, however many times the event replays", async () => {
    const author = await seedAgent();
    const other = await seedAgent();
    const group = await seedGroup(author, [author, other]);
    const post = await seedPost(author, group);
    const name = consumerName("shadow");
    const eventId = baselineEventId + 4101;
    const event = syntheticEvent(eventId, {
      kind: "post.created",
      payload: { post_id: post, group_id: group, author_id: author },
    });

    const shadowConsumer = defineConsumer({
      name,
      coverage: manifestWith("shadow", ["post.created"]),
      effects: memoryIngestEffects,
      memoryModeDelivery: "background",
    });

    await shadowConsumer.handleEvent(event);
    const { rows: first } = await pgPool().query(
      `SELECT effect_key FROM event_consumer_shadow WHERE consumer = $1 ORDER BY effect_key`,
      [name]
    );
    expect(first.length).toBeGreaterThan(0);
    for (const row of first as Array<{ effect_key: string }>) {
      expect(row.effect_key).toMatch(new RegExp(`^(${author}|${other}):plat_post_${post}_c\\d+$`));
    }
    // Shadow writes NO projection: the legacy inline writer is still the only real writer.
    expect(vectorUpsert).not.toHaveBeenCalled();

    // A crash before the receipt replays the event. Duplicate shadow rows would corrupt the soak's
    // mismatch counts, so the unique key must absorb the replay.
    await shadowConsumer.handleEvent(event);
    const { rows: second } = await pgPool().query(
      `SELECT effect_key FROM event_consumer_shadow WHERE consumer = $1 ORDER BY effect_key`,
      [name]
    );
    expect(second).toEqual(first);
  });

  it("spends the payload's audience on a post.deleted cleanup", async () => {
    const author = await seedAgent();
    const commenter = await seedAgent();
    const group = await seedGroup(author, [author]);
    const post = await seedPost(author, group);
    await softDeletePost(post, author);
    vectorList.mockResolvedValue(["vec-1"]);

    await memoryIngestEffects.apply(
      syntheticEvent(baselineEventId + 4201, {
        kind: "post.deleted",
        payload: {
          post_id: post,
          group_id: group,
          author_id: author,
          commenter_ids: [commenter],
          comment_ids: [],
          audience_agent_ids: [author],
        },
      })
    );

    // Both the recomputable audience AND the commenter, who no post audience could ever reproduce.
    expect(vectorDelete.mock.calls.map((call) => call[0])).toEqual([author, commenter]);
  });
});

/**
 * The barrier-controlled interleavings the plan's P2.1 gate names by name.
 *
 * A serial "delete, then consume" test proves only the easy half. The dangerous half is a consumer
 * that read its subject while it was ALIVE, paused, and resumes after the delete and its cleanup
 * have committed — which is what makes a check-then-write consumer resurrect deleted content. The
 * pause is a real lock held by a real second session, and the assertion is that the statement under
 * test blocks on it (`pg_blocking_pids`, never wall-clock ordering) and then writes nothing.
 */
describe("barrier-controlled interleavings", () => {
  /**
   * Hold the post row exactly as `deletePost` does, let the contender block on it, then commit the
   * delete and its cleanup — and only then release the contender.
   *
   * @returns whether the contender was observed waiting specifically on this holder.
   */
  async function deleteUnderBarrier(options: {
    postId: string;
    authorId: string;
    marker: string;
    contend: () => Promise<unknown>;
  }): Promise<{ observedBlocked: boolean }> {
    const holder = await pgClient();
    let observedBlocked = false;
    try {
      const holderPid = await pidOf(holder);
      await holder.query("BEGIN");
      // The same `FOR UPDATE` element 1 of `deletePost` takes. Everything the contender needs is
      // behind it.
      await holder.query(`SELECT id FROM posts WHERE id = $1 FOR UPDATE`, [options.postId]);

      const contention = options.contend();
      contention.catch(() => {});
      observedBlocked = await waitForWaiter(holderPid, options.marker, 8000);

      // The delete and its projection cleanup, committed while the contender waits.
      await holder.query(
        `UPDATE posts SET deleted_at = NOW(), deleted_by_agent_id = $2, deleted_karma_reversed_at = NOW()
         WHERE id = $1`,
        [options.postId, options.authorId]
      );
      await holder.query(`DELETE FROM activity_events WHERE kind = 'post' AND entity_id = $1`, [
        options.postId,
      ]);
      await holder.query(
        `DELETE FROM activity_events WHERE kind = 'comment'
           AND entity_id IN (SELECT id FROM comments WHERE post_id = $1)`,
        [options.postId]
      );
      await holder.query(`DELETE FROM notifications WHERE metadata->>'post_id' = $1`, [options.postId]);
      await holder.query("COMMIT");
      await contention;
    } finally {
      try {
        await holder.query("ROLLBACK");
      } catch {
        /* already committed */
      }
      await holder.end();
    }
    return { observedBlocked };
  }

  it("(a) blocks the activity create write on the delete, then lands nothing", async () => {
    const author = await seedAgent();
    const group = await seedGroup(author);
    const post = await seedPost(author, group, "Racing post");
    const { applyPostActivityFromEvent } = await import("@/lib/store/activity/events");

    // The input is read while the post is ALIVE — the state a consumer paused mid-effect holds.
    const input = {
      id: post,
      authorId: author,
      groupId: group,
      title: "Racing post",
      content: LONG_BODY,
      createdAt: new Date().toISOString(),
    };

    const outcome = await deleteUnderBarrier({
      postId: post,
      authorId: author,
      marker: "race:m11-2-activity-locked-target",
      contend: () => applyPostActivityFromEvent(input, baselineEventId + 6001),
    });

    expect(outcome.observedBlocked).toBe(true);
    expect(await activityRow("post", post)).toBeUndefined();
  });

  it("(b) blocks the notification insert on the delete, then lands nothing", async () => {
    const author = await seedAgent();
    const commenter = await seedAgent();
    const group = await seedGroup(author);
    const post = await seedPost(author, group);
    const comment = await seedComment(post, commenter);
    const { createCommentNotificationIdempotent } = await import("@/lib/store/notifications/db");

    const outcome = await deleteUnderBarrier({
      postId: post,
      authorId: author,
      marker: "race:m11-2-notification-locked-target",
      contend: () =>
        createCommentNotificationIdempotent({
          dedupKey: `comment_on_my_post:${author}:${baselineEventId + 6101}`,
          type: "comment_on_my_post",
          recipientAgentId: author,
          actorAgentId: commenter,
          postId: post,
          commentId: comment,
          parentCommentId: null,
          createdAt: new Date().toISOString(),
        }),
    });

    expect(outcome.observedBlocked).toBe(true);
    expect(await notificationsFor(author)).toEqual([]);
  });

  /**
   * **The interleaving the claim exists for.** Two claimants, one recipient, a deletion landing
   * mid-flight, and the loser's compensation failing.
   *
   * Without a claim this is the unrecoverable case: A compensates and completes, B's slower upsert
   * re-adds the same deterministic chunk ids, B's compensation fails — and A's completion has
   * already let the event receipt, so B's failure is unreachable and the deleted content stays
   * indexed. With the claim, only one attempt ever runs the recipient, so whichever one owns it
   * decides, and a failure there leaves the event unreceipted.
   */
  it("(c2) never receipts while a claimant's compensation has failed, even under concurrency", async () => {
    const author = await seedAgent();
    const group = await seedGroup(author, [author]);
    const post = await seedPost(author, group);
    const eventId = baselineEventId + 6501;
    const event = syntheticEvent(eventId, {
      kind: "post.created",
      payload: { post_id: post, group_id: group, author_id: author },
    });

    // The deletion lands during the write, so the owner compensates — and its compensation fails.
    vectorUpsert.mockImplementation(async () => {
      await softDeletePost(post, author);
      await new Promise((resolve) => setTimeout(resolve, 100));
    });
    vectorDelete.mockRejectedValue(new Error("vector delete unavailable"));

    const outcomes = await runConcurrently([
      () => memoryIngestEffects.apply(event),
      () => memoryIngestEffects.apply(event),
    ]);
    // Both passes fail: one owns the fan-out and its compensation failed; the other is refused the
    // event claim outright and refuses to report a fan-out it never ran.
    expect(outcomes.every((outcome) => !outcome.ok)).toBe(true);

    // Exactly ONE pass did vector work — that is the event claim doing its job. Without it the
    // loser's upsert would land after the winner's compensating delete and re-add the chunks.
    expect(vectorUpsert).toHaveBeenCalledTimes(1);

    // Nothing is settled, so the drain cannot receipt: the recipient is still unfinished.
    const { rows } = await pgPool().query(
      `SELECT completed_at FROM ingest_progress WHERE event_id = $1`,
      [eventId]
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].completed_at).toBeNull();

    // The retry compensates successfully and only then settles the recipient.
    vectorDelete.mockResolvedValue(undefined);
    await pgPool().query(
      `UPDATE posts SET deleted_at = NULL, deleted_by_agent_id = NULL, deleted_karma_reversed_at = NULL
       WHERE id = $1`,
      [post]
    );
    await expect(memoryIngestEffects.apply(event)).resolves.toBeUndefined();
    expect(await progressRecipients(eventId)).toEqual([author]);
  });

  /**
   * **Success is judged from the LEDGER, never from this pass's own recomputed plan.**
   *
   * Pass A claims recipient R and stalls mid-flight. R then leaves the group, so pass B recomputes
   * an audience without R — and if success were judged from B's own plan, B would find everything it
   * planned complete, report the fan-out finished, and let the event receipt while A was still
   * writing for R. Registration at plan time makes R visible to B, and B refuses.
   */
  it("(c3) refuses to finish while a recipient another pass still owns is outstanding", async () => {
    const author = await seedAgent();
    const leaver = await seedAgent();
    const group = await seedGroup(author, [author, leaver]);
    const post = await seedPost(author, group);
    const eventId = baselineEventId + 6601;
    const event = syntheticEvent(eventId, {
      kind: "post.created",
      payload: { post_id: post, group_id: group, author_id: author },
    });

    // Pass A: claims both recipients and stalls forever on the second one.
    let releaseA = () => {};
    const aStalled = new Promise<void>((resolve) => {
      releaseA = resolve;
    });
    let aReachedLeaver = () => {};
    const aAtLeaver = new Promise<void>((resolve) => {
      aReachedLeaver = resolve;
    });
    vectorUpsert.mockImplementation(async (agentId: string) => {
      if (agentId !== leaver) return;
      aReachedLeaver();
      await aStalled;
    });
    const passA = memoryIngestEffects.apply(event);
    passA.catch(() => {});
    await aAtLeaver;

    // The leaver leaves. Pass B's recomputed audience no longer contains them.
    await pgPool().query(`UPDATE groups SET member_ids = $2::jsonb WHERE id = $1`, [
      group,
      JSON.stringify([author]),
    ]);

    // Pass B must NOT report success: the ledger still holds an incomplete row that A owns.
    await expect(memoryIngestEffects.apply(event)).rejects.toThrow("owned by another pass");

    releaseA();
    await passA;
    // A finished its own fan-out, so every registered recipient is complete.
    expect(await progressRecipients(eventId)).toEqual([author, leaver].sort());
    // And a later pass is REFUSED rather than allowed to re-plan behind the finished one: A keeps
    // its claim until the receipt lands, which is what closes the success-to-receipt window.
    await expect(memoryIngestEffects.apply(event)).rejects.toThrow("owned by another pass");
  });

  /**
   * A lapsed claim is RESOLVED, not waited on — including for a recipient who has left the audience.
   *
   * A crashed pass leaves a claimed, incomplete row. Once its lease lapses, the next pass reclaims
   * it; if the recipient is still in the audience it redoes the work, and if they have departed it
   * compensates their chunks away and completes the row. Either way the event becomes receiptable,
   * which is the property a bare "wait for the owner" would never reach after a crash.
   */
  it("(c4) resolves an outstanding row and compensates a departed recipient", async () => {
    const author = await seedAgent();
    const leaver = await seedAgent();
    const group = await seedGroup(author, [author, leaver]);
    const post = await seedPost(author, group);
    const eventId = baselineEventId + 6701;
    const event = syntheticEvent(eventId, {
      kind: "post.created",
      payload: { post_id: post, group_id: group, author_id: author },
    });

    // A crashed pass: the recipient was registered and never finished. Its owner is long gone —
    // the event claim it held was released or has lapsed — so the row is simply outstanding.
    await pgPool().query(
      `INSERT INTO ingest_progress (event_id, recipient_agent_id) VALUES ($1, $2)`,
      [eventId, leaver]
    );
    // And the recipient has since left the group, so no recomputed audience will name them.
    await pgPool().query(`UPDATE groups SET member_ids = $2::jsonb WHERE id = $1`, [
      group,
      JSON.stringify([author]),
    ]);

    // A previous pass had written for them, so the subject predicate finds chunks to remove.
    vectorList.mockImplementation(async (agentId: string) =>
      agentId === leaver ? [`plat_post_${post}_c0`] : []
    );

    await expect(memoryIngestEffects.apply(event)).resolves.toBeUndefined();

    // The departed recipient was compensated — whatever a previous pass wrote for them is removed
    // under the subject predicate the payload names — and only then was the row completed.
    expect(vectorDelete.mock.calls).toEqual([[leaver, [`plat_post_${post}_c0`]]]);
    expect(await progressRecipients(eventId)).toEqual([author, leaver].sort());
    // Never re-ingested for the departed recipient: they are not in the audience any more.
    expect(vectorUpsert.mock.calls.map(([agentId]: [string]) => agentId)).toEqual([author]);
  });

  /**
   * **A lapsed lease stops the slow claimant, rather than letting it write over the new owner.**
   *
   * With a short lease forced, A's claim lapses while its vector work is outstanding. The renewal
   * fails, A learns it is no longer the owner, and refuses to write again, to compensate, or to
   * complete. Without that, A could land a late upsert after B had already compensated the
   * recipient's chunks away — the interleaving the whole claim design exists to close.
   */
  it("(f) stops a claimant whose lease lapsed mid-flight, and never lets it complete", async () => {
    const author = await seedAgent();
    const group = await seedGroup(author, [author]);
    const post = await seedPost(author, group);
    const eventId = baselineEventId + 6801;
    const event = syntheticEvent(eventId, {
      kind: "post.created",
      payload: { post_id: post, group_id: group, author_id: author },
    });

    const savedLease = process.env.INGEST_EVENT_LEASE_MS;
    // A real, short lease — renewals tick at a third of it and the deadline at 80% — but long
    // enough that the deadline lands inside the STALLED CALL rather than during the claim,
    // registration and ledger round trips that precede it. A lease shorter than the setup would
    // make this pass fail before it ever reached the boundary under test.
    process.env.INGEST_EVENT_LEASE_MS = "4000";
    try {
      // The write outlives the lease, and the deletion lands inside it — the combined interleaving.
      vectorUpsert.mockImplementation(async () => {
        await softDeletePost(post, author);
        // Somebody else reclaims the EVENT while this pass is still inside its upsert.
        await pgPool().query(
          `UPDATE ingest_event_claims SET claim_token = 'stolen', lease_expires_at = now() + interval '1 hour'
           WHERE event_id = $1`,
          [eventId]
        );
        await new Promise((resolve) => setTimeout(resolve, 4500));
      });

      await expect(memoryIngestEffects.apply(event)).rejects.toThrow(/lost the fan-out claim|deadline/);

      // The stale pass neither compensated over the new owner's chunks nor completed the row.
      expect(vectorDelete).not.toHaveBeenCalled();
      const { rows } = await pgPool().query(
        `SELECT completed_at FROM ingest_progress WHERE event_id = $1`,
        [eventId]
      );
      expect(rows).toHaveLength(1);
      expect(rows[0].completed_at).toBeNull();
      // And it did not release the claim it no longer owns.
      const { rows: claims } = await pgPool().query(
        `SELECT claim_token FROM ingest_event_claims WHERE event_id = $1`,
        [eventId]
      );
      expect(claims[0]?.claim_token).toBe("stolen");
    } finally {
      if (savedLease === undefined) delete process.env.INGEST_EVENT_LEASE_MS;
      else process.env.INGEST_EVENT_LEASE_MS = savedLease;
    }
  });

  /**
   * A stale owner must stop at the FIRST external call after ownership is lost — including the
   * prune, which is the last one and therefore the easiest to leave unguarded.
   */
  it("(g) skips the prune once ownership is lost mid-recipient", async () => {
    const author = await seedAgent();
    const group = await seedGroup(author, [author]);
    const post = await seedPost(author, group);
    const eventId = baselineEventId + 6901;
    const event = syntheticEvent(eventId, {
      kind: "post.created",
      payload: { post_id: post, group_id: group, author_id: author },
    });

    const savedLease = process.env.INGEST_EVENT_LEASE_MS;
    // Long enough that the deadline lands inside the stalled upsert rather than during setup.
    process.env.INGEST_EVENT_LEASE_MS = "4000";
    try {
      // The claim is stolen while this pass is inside its upsert, and the pass then outlives its
      // own renewals.
      vectorUpsert.mockImplementation(async () => {
        await pgPool().query(
          `UPDATE ingest_event_claims SET claim_token = 'stolen', lease_expires_at = now() + interval '1 hour'
           WHERE event_id = $1`,
          [eventId]
        );
        await new Promise((resolve) => setTimeout(resolve, 4500));
      });

      await expect(memoryIngestEffects.apply(event)).rejects.toThrow(/lost the fan-out claim|deadline/);

      // The upsert DID run — the pass reached the external work and then lost ownership inside it,
      // which is the boundary under test rather than an early abort.
      expect(vectorUpsert).toHaveBeenCalledTimes(1);
      // The prune is the NEXT external write, for an agent whose recipient somebody else now owns.
      // It must not run, and neither must the compensation.
      expect(vectorPrune).not.toHaveBeenCalled();
      expect(vectorDelete).not.toHaveBeenCalled();
      expect(await progressRecipients(eventId)).toEqual([]);
    } finally {
      if (savedLease === undefined) delete process.env.INGEST_EVENT_LEASE_MS;
      else process.env.INGEST_EVENT_LEASE_MS = savedLease;
    }
  });

  /**
   * The compensation runs BEFORE the prune, so a pruning failure cannot hide a write that landed
   * across a deletion. The recipient still stays incomplete, because the prune is real work.
   */
  it("(h) compensates before pruning, and a pruning failure leaves the recipient incomplete", async () => {
    const author = await seedAgent();
    const group = await seedGroup(author, [author]);
    const post = await seedPost(author, group);
    const eventId = baselineEventId + 7001;
    const event = syntheticEvent(eventId, {
      kind: "post.created",
      payload: { post_id: post, group_id: group, author_id: author },
    });

    const order: string[] = [];
    vectorUpsert.mockImplementation(async () => {
      order.push("upsert");
      await softDeletePost(post, author);
    });
    vectorDelete.mockImplementation(async () => {
      order.push("compensate");
    });
    vectorPrune.mockImplementation(async () => {
      order.push("prune");
      throw new Error("prune unavailable");
    });

    await expect(memoryIngestEffects.apply(event)).rejects.toThrow("prune unavailable");

    // The order is the assertion: the compensation had already run when the prune failed.
    expect(order).toEqual(["upsert", "compensate", "prune"]);
    // And the recipient is not settled, so the drain sees no receipt and the retry resolves it.
    expect(await progressRecipients(eventId)).toEqual([]);
  });

  /**
   * The release-to-receipt gap: a successful pass keeps its claim until the receipt lands, and the
   * claim statement refuses once the receipt exists.
   */
  it("(i) refuses a claim in the success-to-receipt window, and again after the receipt", async () => {
    const author = await seedAgent();
    const group = await seedGroup(author, [author]);
    const post = await seedPost(author, group);
    const name = consumerName("gap");

    await activateEventConsumer(name);
    const emitted = await emitEvent({
      kind: "post.created",
      actorAgentId: author,
      subjectType: "post",
      subjectId: post,
      payload: { post_id: post, group_id: group, author_id: author },
    });
    const event = syntheticEvent(emitted.id, {
      kind: "post.created",
      payload: { post_id: post, group_id: group, author_id: author },
    });

    // A successful pass, with NO receipt written yet — exactly the window between `apply` returning
    // and the drain recording the receipt, which are two separate statements.
    await expect(memoryIngestEffects.apply(event)).resolves.toBeUndefined();
    const { rows: heldClaim } = await pgPool().query(
      `SELECT event_id FROM ingest_event_claims WHERE event_id = $1`,
      [emitted.id]
    );
    // The claim is deliberately NOT released: it is the "finished" marker until the receipt lands.
    expect(heldClaim).toHaveLength(1);

    // So a second pass cannot start a whole fan-out behind the completed one — re-planning against
    // an audience that may have changed, and failing where nothing would ever look.
    vectorUpsert.mockClear();
    await expect(memoryIngestEffects.apply(event)).rejects.toThrow("owned by another pass, or already receipted");
    expect(vectorUpsert).not.toHaveBeenCalled();

    // The receipt the drain writes once its own pass returned. From here the claim row is redundant.
    await pgPool().query(`INSERT INTO event_receipts (consumer, event_id) VALUES ($1, $2)`, [
      name,
      emitted.id,
    ]);

    // A later claim now refuses on the RECEIPT rather than on the leftover row — and collects that
    // row on the way past, so a claim kept on success blocks nothing and leaks nothing.
    const { claimIngestEvent } = await import("@/lib/store/events/consumer-state");
    expect(await claimIngestEvent(emitted.id, "late-token", name)).toBe(false);
    const { rows: collected } = await pgPool().query(
      `SELECT event_id FROM ingest_event_claims WHERE event_id = $1`,
      [emitted.id]
    );
    expect(collected).toEqual([]);
  });

  /**
   * A partial `post.deleted` cleanup must not receipt. The effect used to swallow per-recipient
   * failures, so one unreachable recipient kept a deleted post's vectors forever behind a receipt.
   */
  it("(j) receipts a post.deleted cleanup only once every recipient is cleaned", async () => {
    const author = await seedAgent();
    const commenter = await seedAgent();
    const group = await seedGroup(author, [author]);
    const post = await seedPost(author, group);
    const name = consumerName("cleanup-drain");
    const consumer = defineConsumer({
      name,
      coverage: manifestWith("on", ["post.deleted"]),
      effects: memoryIngestEffects,
      memoryModeDelivery: "background",
    });

    const savedBackoff = process.env.EVENT_RETRY_BACKOFF_MS;
    process.env.EVENT_RETRY_BACKOFF_MS = "1";
    try {
      await activateEventConsumer(name);
      await softDeletePost(post, author);
      const emitted = await emitEvent({
        kind: "post.deleted",
        actorAgentId: author,
        subjectType: "post",
        subjectId: post,
        payload: {
          post_id: post,
          group_id: group,
          author_id: author,
          commenter_ids: [commenter],
          comment_ids: [],
          audience_agent_ids: [author],
        },
      });

      vectorList.mockResolvedValue([`plat_post_${post}_c0`]);
      vectorDelete.mockImplementation(async (agentId: string) => {
        if (agentId === commenter) throw new Error("vector store unreachable");
      });

      const first = await drainEventConsumer(consumer, { batchSize: 50 });
      expect(first.failed).toBe(1);
      expect(first.receipted).toBe(0);
      // The reachable recipient was cleaned and settled; the unreachable one was not.
      expect(await progressRecipients(emitted.id)).toEqual([author]);

      vectorDelete.mockResolvedValue(undefined);
      const second = await drainEventConsumer(consumer, { batchSize: 50 });
      expect(second.receipted).toBe(1);
      expect(await progressRecipients(emitted.id)).toEqual([author, commenter].sort());
    } finally {
      if (savedBackoff === undefined) delete process.env.EVENT_RETRY_BACKOFF_MS;
      else process.env.EVENT_RETRY_BACKOFF_MS = savedBackoff;
    }
  });

  /**
   * **Contention must leave NO trace in the retry ledger.**
   *
   * A second drainer refused the fan-out claim used to look like an ordinary failure: a failures
   * row, an attempt, a backoff — and three refusals fit comfortably inside one owner's lease, at
   * which point the loser dead-letters and RECEIPTS an event whose owner is still working. The
   * `RetryLaterError` sentinel makes the drain skip the event for that pass only.
   */
  it("(k) records nothing when a drain finds the fan-out claimed, and processes it afterwards", async () => {
    const author = await seedAgent();
    const group = await seedGroup(author, [author]);
    const post = await seedPost(author, group);
    const name = consumerName("contended");
    const consumer = defineConsumer({
      name,
      coverage: manifestWith("on", ["post.created"]),
      effects: memoryIngestEffects,
      memoryModeDelivery: "background",
    });

    const savedBackoff = process.env.EVENT_RETRY_BACKOFF_MS;
    // A one-millisecond backoff, so three passes could burn every attempt in a second if the
    // refusal were recorded as a failure. It must not be.
    process.env.EVENT_RETRY_BACKOFF_MS = "1";
    try {
      await activateEventConsumer(name);
      const emitted = await emitEvent({
        kind: "post.created",
        actorAgentId: author,
        subjectType: "post",
        subjectId: post,
        payload: { post_id: post, group_id: group, author_id: author },
      });

      // Another owner holds the fan-out with a long lease — a pass that is still working.
      await pgPool().query(
        `INSERT INTO ingest_event_claims (event_id, claim_token, lease_expires_at)
         VALUES ($1, 'other-owner', now() + interval '1 hour')`,
        [emitted.id]
      );

      for (let pass = 0; pass < 3; pass += 1) {
        const counts = await drainEventConsumer(consumer, { batchSize: 50 });
        expect(counts.processed).toBe(1);
        // No failure, no dead letter, no receipt — the event is simply not this pass's to run.
        expect(counts.failed).toBe(0);
        expect(counts.deadLettered).toBe(0);
        expect(counts.receipted).toBe(0);
      }
      expect(vectorUpsert).not.toHaveBeenCalled();

      const { rows: failures } = await pgPool().query(
        `SELECT attempts FROM event_consumer_failures WHERE consumer = $1 AND event_id = $2`,
        [name, emitted.id]
      );
      expect(failures).toEqual([]);
      const { rows: dead } = await pgPool().query(
        `SELECT event_id FROM event_dead_letters WHERE consumer = $1 AND event_id = $2`,
        [name, emitted.id]
      );
      expect(dead).toEqual([]);

      // The owner finishes and releases; the next pass runs the fan-out and receipts it.
      await pgPool().query(`DELETE FROM ingest_event_claims WHERE event_id = $1`, [emitted.id]);
      const after = await drainEventConsumer(consumer, { batchSize: 50 });
      expect(after.receipted).toBe(1);
      expect(await progressRecipients(emitted.id)).toEqual([author]);
    } finally {
      if (savedBackoff === undefined) delete process.env.EVENT_RETRY_BACKOFF_MS;
      else process.env.EVENT_RETRY_BACKOFF_MS = savedBackoff;
    }
  });

  /**
   * A lease-lapsed planner must not register recipients behind its replacement's completeness
   * check, and a lease-lapsed owner must not settle a recipient somebody else is writing for.
   */
  it("(l) refuses registration and completion once the claim is gone", async () => {
    const author = await seedAgent();
    const group = await seedGroup(author, [author]);
    const post = await seedPost(author, group);
    const eventId = baselineEventId + 7101;
    const event = syntheticEvent(eventId, {
      kind: "post.created",
      payload: { post_id: post, group_id: group, author_id: author },
    });

    const { claimIngestEvent, registerIngestRecipients, completeIngestRecipient } = await import(
      "@/lib/store/events/consumer-state"
    );

    // A real claim, then somebody else takes the event over.
    expect(await claimIngestEvent(eventId, "mine", "memory-ingest")).toBe(true);
    await pgPool().query(
      `UPDATE ingest_event_claims SET claim_token = 'theirs', lease_expires_at = now() + interval '1 hour'
       WHERE event_id = $1`,
      [eventId]
    );

    // Both ledger writes are fenced on a LOCKED, unexpired, token-matching claim row.
    expect(await registerIngestRecipients(eventId, [author], "mine")).toBe(false);
    const { rows: registered } = await pgPool().query(
      `SELECT recipient_agent_id FROM ingest_progress WHERE event_id = $1`,
      [eventId]
    );
    expect(registered).toEqual([]);

    // Registration by the real owner, then a completion attempt from the stale one.
    expect(await registerIngestRecipients(eventId, [author], "theirs")).toBe(true);
    expect(await completeIngestRecipient(eventId, author, "mine")).toBe(false);
    expect(await progressRecipients(eventId)).toEqual([]);
    // The current owner can settle it.
    expect(await completeIngestRecipient(eventId, author, "theirs")).toBe(true);
    expect(await progressRecipients(eventId)).toEqual([author]);

    // And an EXPIRED claim is no better than a stolen one: the token still matches, but the lease
    // is what says the holder is still the owner.
    await pgPool().query(
      `UPDATE ingest_event_claims SET lease_expires_at = now() - interval '1 hour' WHERE event_id = $1`,
      [eventId]
    );
    expect(await registerIngestRecipients(eventId, ["someone-else"], "theirs")).toBe(false);
    expect(await completeIngestRecipient(eventId, author, "theirs")).toBe(false);

    // The consumer surfaces a refusal rather than proceeding: with a LIVE foreign claim it cannot
    // start at all. (An expired one is legitimately reclaimable, which is why the lease is restored
    // to the future here rather than left in the past.)
    await pgPool().query(
      `UPDATE ingest_event_claims SET lease_expires_at = now() + interval '1 hour' WHERE event_id = $1`,
      [eventId]
    );
    await expect(memoryIngestEffects.apply(event)).rejects.toThrow("owned by another pass");
  });

  /**
   * The window between LISTING a recipient's chunks and DELETING them.
   *
   * The ids a compensation holds are a snapshot. A stale owner that deletes them after its
   * replacement has written for the same recipient removes the replacement's chunks, and the
   * replacement has no reason ever to look again.
   */
  it("(m) does not delete after losing ownership between the listing and the delete", async () => {
    const author = await seedAgent();
    const group = await seedGroup(author, [author]);
    const post = await seedPost(author, group);
    const eventId = baselineEventId + 7201;
    const event = syntheticEvent(eventId, {
      kind: "post.deleted",
      payload: {
        post_id: post,
        group_id: group,
        author_id: author,
        commenter_ids: [],
        comment_ids: [],
        audience_agent_ids: [author],
      },
    });

    await softDeletePost(post, author);
    const savedLease = process.env.INGEST_EVENT_LEASE_MS;
    // Short enough that a renewal ticks inside the listing and reports the loss, long enough that
    // the deadline does not fire during the claim/registration round trips before it.
    process.env.INGEST_EVENT_LEASE_MS = "6000";
    try {
      // The claim is stolen DURING the listing — the awaited step between the two assertions.
      vectorList.mockImplementation(async () => {
        await pgPool().query(
          `UPDATE ingest_event_claims SET claim_token = 'stolen', lease_expires_at = now() + interval '1 hour'
           WHERE event_id = $1`,
          [eventId]
        );
        // Long enough for a renewal tick (lease/3 = 2 s) to observe the loss.
        await new Promise((resolve) => setTimeout(resolve, 2500));
        return [`plat_post_${post}_c0`];
      });

      await expect(memoryIngestEffects.apply(event)).rejects.toThrow(/lost the fan-out claim/);
      // The ids were read, and then NOT deleted — they may already belong to the new owner's write.
      expect(vectorList).toHaveBeenCalled();
      expect(vectorDelete).not.toHaveBeenCalled();
      expect(await progressRecipients(eventId)).toEqual([]);
    } finally {
      if (savedLease === undefined) delete process.env.INGEST_EVENT_LEASE_MS;
      else process.env.INGEST_EVENT_LEASE_MS = savedLease;
    }
  });

  it("(c) serializes two concurrent drains of one ingest event, recording each recipient once", async () => {
    const author = await seedAgent();
    const other = await seedAgent();
    const group = await seedGroup(author, [author, other]);
    const post = await seedPost(author, group);
    const eventId = baselineEventId + 6201;
    const event = syntheticEvent(eventId, {
      kind: "post.created",
      payload: { post_id: post, group_id: group, author_id: author },
    });

    const calls: string[] = [];
    vectorUpsert.mockImplementation(async (agentId: string) => {
      calls.push(agentId);
      // Long enough that the two passes genuinely overlap rather than serialize by luck.
      await new Promise((resolve) => setTimeout(resolve, 150));
    });

    const outcomes = await runConcurrently([
      () => memoryIngestEffects.apply(event),
      () => memoryIngestEffects.apply(event),
    ]);
    // **Either attempt may fail, and BOTH may** — that is not a defect, it is the claim working.
    // Each pass walks the recipients in order: one claims the first and the other claims the second,
    // and each then finds the remaining one owned elsewhere and refuses to report a fan-out it did
    // not finish. What may never happen is a SILENT failure, so every rejection must be that refusal
    // and nothing else.
    for (const outcome of outcomes) {
      if (!outcome.ok) {
        expect(String((outcome.error as Error).message)).toContain("owned by another pass");
      }
    }

    // ============================ THE CONTRACT, ASSERTED ============================
    // (i) COMPLETED ONCE — exactly one progress row per recipient, all of them finished.
    const { rows } = await pgPool().query(
      `SELECT recipient_agent_id, count(*)::int AS c, bool_and(completed_at IS NOT NULL) AS done
       FROM ingest_progress WHERE event_id = $1 GROUP BY recipient_agent_id ORDER BY recipient_agent_id`,
      [eventId]
    );
    expect(rows.map((row: { recipient_agent_id: string }) => row.recipient_agent_id).sort()).toEqual(
      [author, other].sort()
    );
    for (const row of rows as Array<{ c: number; done: boolean }>) {
      expect(row.c).toBe(1);
      expect(row.done).toBe(true);
    }

    // (ii) EXACTLY ONE VECTOR WRITE PER RECIPIENT. Duplicate external work is no longer tolerated:
    // the effects are only idempotent while they are pure writes, and the deletion COMPENSATION
    // makes them delete-then-rewrite, which does not commute. The leased claim is what makes the
    // last write for a recipient always its owner's.
    expect(calls.sort()).toEqual([author, other].sort());
    const finalState = vectorUpsert.mock.calls.map(
      ([agentId, chunks]: [string, Array<{ id: string }>]) =>
        `${agentId}:${chunks.map((chunk) => chunk.id).join(",")}`
    );
    expect(finalState.sort()).toEqual(
      [`${author}:plat_post_${post}_c0`, `${other}:plat_post_${post}_c0`].sort()
    );

    // (iii) NO FURTHER WORK IS POSSIBLE. The winning pass keeps its claim until the receipt lands,
    // so a later pass is refused outright rather than allowed to re-plan behind a finished fan-out —
    // and does no vector work on its way to that refusal.
    vectorUpsert.mockClear();
    await expect(memoryIngestEffects.apply(event)).rejects.toThrow("owned by another pass");
    expect(vectorUpsert).not.toHaveBeenCalled();
  });

  it("(d2) refuses to record a recipient whose compensation failed, and completes on retry", async () => {
    const author = await seedAgent();
    const group = await seedGroup(author, [author]);
    const post = await seedPost(author, group);
    const eventId = baselineEventId + 6401;
    const event = syntheticEvent(eventId, {
      kind: "post.created",
      payload: { post_id: post, group_id: group, author_id: author },
    });

    // The deletion lands during the write, so the compensation runs — and fails.
    vectorUpsert.mockImplementation(async () => {
      await softDeletePost(post, author);
    });
    vectorDelete.mockRejectedValueOnce(new Error("vector delete unavailable"));

    // A swallowed compensation would mark the recipient complete while its vectors still index
    // deleted content — permanently, because nothing revisits a completed recipient.
    await expect(memoryIngestEffects.apply(event)).rejects.toThrow("vector delete unavailable");
    expect(await progressRecipients(eventId)).toEqual([]);
    // The row exists — registered by the owner — so the retry knows the recipient is outstanding.
    const { rows: registered } = await pgPool().query(
      `SELECT recipient_agent_id FROM ingest_progress WHERE event_id = $1`,
      [eventId]
    );
    expect(registered).toHaveLength(1);

    // **The retry runs against a PERMANENTLY tombstoned subject** — nothing is restored, which is
    // what the deployed situation looks like. `planIngest` returns null, so a "plan is null ⇒
    // success" shortcut would receipt the event over the late vector nobody would ever revisit.
    // Instead the tombstone resolver compensates by the payload's subject predicate and completes.
    vectorDelete.mockResolvedValue(undefined);
    vectorList.mockResolvedValue([`plat_post_${post}_c0`]);
    await expect(memoryIngestEffects.apply(event)).resolves.toBeUndefined();
    expect(vectorDelete).toHaveBeenLastCalledWith(author, [`plat_post_${post}_c0`]);
    expect(await progressRecipients(eventId)).toEqual([author]);
  });

  /**
   * The same tombstoned retry, through the REAL drain, end to end.
   *
   * The receipt is what makes this matter: an event whose fan-out left a late vector behind must not
   * be receipted until that vector is gone, because a receipt is the drain's statement that the
   * fan-out finished and nothing ever looks at a receipted event again.
   */
  it("(d3) receipts a permanently tombstoned event only after the late vector is compensated", async () => {
    const author = await seedAgent();
    const group = await seedGroup(author, [author]);
    const post = await seedPost(author, group);
    const name = consumerName("tombstone-drain");

    const consumer = defineConsumer({
      name,
      coverage: manifestWith("on", ["post.created"]),
      effects: memoryIngestEffects,
      memoryModeDelivery: "background",
    });

    const savedBackoff = process.env.EVENT_RETRY_BACKOFF_MS;
    process.env.EVENT_RETRY_BACKOFF_MS = "1";
    try {
      await activateEventConsumer(name);
      const emitted = await emitEvent({
        kind: "post.created",
        actorAgentId: author,
        subjectType: "post",
        subjectId: post,
        payload: { post_id: post, group_id: group, author_id: author },
      });

      // Pass one: the post is deleted mid-write and the compensation fails.
      vectorUpsert.mockImplementation(async () => {
        await softDeletePost(post, author);
      });
      vectorDelete.mockRejectedValueOnce(new Error("vector delete unavailable"));

      const first = await drainEventConsumer(consumer, { batchSize: 50 });
      expect(first.failed).toBe(1);
      expect(first.receipted).toBe(0);
      const { rows: noReceipt } = await pgPool().query(
        `SELECT event_id FROM event_receipts WHERE consumer = $1 AND event_id = $2`,
        [name, emitted.id]
      );
      expect(noReceipt).toEqual([]);

      // Pass two: the subject is still a tombstone. The resolver compensates and completes, and
      // only then is the event receipted.
      vectorDelete.mockResolvedValue(undefined);
      vectorList.mockResolvedValue([`plat_post_${post}_c0`]);
      const second = await drainEventConsumer(consumer, { batchSize: 50 });
      expect(second.receipted).toBe(1);
      expect(vectorDelete).toHaveBeenLastCalledWith(author, [`plat_post_${post}_c0`]);
      expect(await progressRecipients(emitted.id)).toEqual([author]);

      const { rows: receipts } = await pgPool().query(
        `SELECT event_id FROM event_receipts WHERE consumer = $1 AND event_id = $2`,
        [name, emitted.id]
      );
      expect(receipts).toHaveLength(1);
    } finally {
      if (savedBackoff === undefined) delete process.env.EVENT_RETRY_BACKOFF_MS;
      else process.env.EVENT_RETRY_BACKOFF_MS = savedBackoff;
    }
  });

  it("(e) compensates a reconciliation write that landed across a deletion", async () => {
    const author = await seedAgent();
    const group = await seedGroup(author, [author]);
    const post = await seedPost(author, group);

    // The reconciliation picks up everything created after its watermark. Rewinding it to just
    // before this post is what puts exactly this post in the batch.
    const { rows: before } = await pgPool().query(`SELECT created_at FROM posts WHERE id = $1`, [post]);
    const { setMemoryIngestWatermark } = await import("@/lib/store/activity/db");
    const savedWatermark = await (await import("@/lib/store/activity/db")).getMemoryIngestWatermark();
    await setMemoryIngestWatermark(
      new Date(new Date(before[0].created_at).getTime() - 1000).toISOString()
    );

    // The deletion lands during the write, which is the window no lock can cover.
    vectorUpsert.mockImplementation(async () => {
      await softDeletePost(post, author);
    });

    const { runMemoryReconciliationBatch } = await import("@/lib/memory/reconciliation-ingest");
    try {
      await runMemoryReconciliationBatch();
    } finally {
      // The watermark is shared state; put it back so no later suite re-ingests this run's history.
      await setMemoryIngestWatermark(savedWatermark);
    }

    // The shared fan-out re-checked the subject and removed what it had just written — no consumer,
    // no progress ledger, no claim involved.
    expect(vectorDelete).toHaveBeenCalled();
    const compensated = vectorDelete.mock.calls.map(([agentId, ids]: [string, string[]]) => ({
      agentId,
      ids,
    }));
    expect(compensated).toContainEqual({ agentId: author, ids: [`plat_post_${post}_c0`] });
  });

  it("(d) compensates a vector written across a concurrent deletion, and still records the recipient", async () => {
    const author = await seedAgent();
    const group = await seedGroup(author, [author]);
    const post = await seedPost(author, group);
    const eventId = baselineEventId + 6301;
    const event = syntheticEvent(eventId, {
      kind: "post.created",
      payload: { post_id: post, group_id: group, author_id: author },
    });

    // The deletion lands DURING the recipient's external write — the window no lock can cover,
    // because the vector store is outside the transaction.
    vectorUpsert.mockImplementation(async () => {
      await softDeletePost(post, author);
    });

    await expect(memoryIngestEffects.apply(event)).resolves.toBeUndefined();

    // The subject re-check found the tombstone and deleted the chunks it had just written.
    expect(vectorDelete).toHaveBeenCalledTimes(1);
    const [compensatedAgent, compensatedIds] = vectorDelete.mock.calls[0] as [string, string[]];
    expect(compensatedAgent).toBe(author);
    expect(compensatedIds).toEqual([`plat_post_${post}_c0`]);

    // The progress row IS written after the compensation: the recipient is settled — it holds no
    // chunks for this event — and leaving it unrecorded would make every retry redo a write it
    // would immediately compensate again.
    expect(await progressRecipients(eventId)).toEqual([author]);
  });
});

/**
 * Shadow rows must be CANONICAL, not merely correctly keyed.
 *
 * The plan requires the soak to diff "canonical payloads per key" so a right-key/wrong-content
 * consumer fails verification. That means the described payload has to be the full projection,
 * produced through the same SELECT the write uses — and the deletion effects have to describe the
 * exact rows they would remove, never one coarse blob per post.
 */
describe("canonical shadow payloads", () => {
  it("describes the full activity projection, identical to the row apply writes", async () => {
    const author = await seedAgent();
    const group = await seedGroup(author);
    const post = await seedPost(author, group, "Shadow post");
    const event = syntheticEvent(baselineEventId + 7001, {
      kind: "post.created",
      payload: { post_id: post, group_id: group, author_id: author },
    });

    const described = await activityTrailEffects.describe(event);
    expect(described).toHaveLength(1);
    expect(described[0].key).toBe(`post:${post}`);
    // Not a summary of the inputs: the rendered title, href, summary, search text and metadata.
    expect(described[0].payload).toMatchObject({
      kind: "post",
      entity_id: post,
      actor_id: author,
      title: "Shadow post",
      href: `/post/${post}`,
    });
    expect(String(described[0].payload.summary)).toContain("Shadow post");
    expect(String(described[0].payload.search_text)).toContain("post");

    await activityTrailEffects.apply(event);
    const { rows } = await pgPool().query(
      `SELECT kind, occurred_at, actor_id, actor_name, actor_canonical_name, entity_id, title, href,
              summary, context_hint, search_text, metadata
       FROM activity_events WHERE kind = 'post' AND entity_id = $1`,
      [post]
    );
    const written = rows[0] as Record<string, unknown>;
    // Field for field — the described payload IS what was written.
    for (const [field, value] of Object.entries(described[0].payload)) {
      const actual = written[field] instanceof Date ? (written[field] as Date).toISOString() : written[field];
      expect({ field, value: actual }).toEqual({ field, value });
    }
  });

  it("describes the notification row through the same select that writes it", async () => {
    const author = await seedAgent();
    const commenter = await seedAgent();
    const group = await seedGroup(author);
    const post = await seedPost(author, group, "Notify me");
    const comment = await seedComment(post, commenter, "The parent comment");
    // The REPLY's content becomes the notification target's title, truncated to 80. Astral
    // characters are where `left(…, 80)` and `slice(0, 80)` disagree, so the title is computed
    // inside the insert with `left()` — and this fixture is what would catch a regression to
    // JavaScript truncation.
    const reply = await seedComment(post, author, `${"😀".repeat(100)} tail`, comment);
    const event = syntheticEvent(baselineEventId + 7101, {
      kind: "comment.created",
      payload: { comment_id: reply, post_id: post, parent_id: comment },
    });

    const described = await notificationEffects.describe(event);
    expect(described).toHaveLength(1);
    expect(described[0].key).toBe(`reply_to_my_comment:${commenter}:${baselineEventId + 7101}`);
    expect(described[0].payload).toMatchObject({
      agent_id: commenter,
      type: "reply_to_my_comment",
      priority: "normal",
      href: `/post/${post}#comment-${reply}`,
    });

    await notificationEffects.apply(event);
    const rows = await notificationsFor(commenter);
    expect(rows).toHaveLength(1);
    const { rows: full } = await pgPool().query(
      `SELECT agent_id, type, priority, actor, target, href, created_at, web_url, deadline_at, metadata, dedup_key
       FROM notifications WHERE id = $1`,
      [rows[0].id]
    );
    // `created_at` joined the projection in u3b's convergence round: both writers share one clock
    // per kind, so the described payload must equal the written row on it too.
    expect(described[0].payload).toEqual({
      ...full[0],
      created_at: (full[0].created_at as Date).toISOString(),
    });
  });

  /**
   * Deletion effects are KEY-ONLY and PAYLOAD-DERIVED, and the payload is the whole point.
   *
   * A canonical payload comparison cannot exist for rows that no longer do, so these kinds are
   * verified by their key sets and by the both-orders convergence gates rather than by a payload
   * diff. The keys must come from the event payload: in the deployed ordering the legacy inline
   * delete commits FIRST, so a describe that read live state would produce an empty set on every
   * real deletion. This asserts exactly that — the post and its whole thread are already gone, and
   * the key sets are still complete.
   */
  it("derives deletion keys from the payload, after the rows are already gone", async () => {
    const author = await seedAgent();
    const commenter = await seedAgent();
    const group = await seedGroup(author, [author]);
    const post = await seedPost(author, group, "Doomed with a thread");
    const comment = await seedComment(post, commenter);

    // Everything the deletion would remove, removed first — the deployed ordering.
    await softDeletePost(post, author);
    await pgPool().query(`DELETE FROM activity_events WHERE entity_id IN ($1, $2)`, [post, comment]);
    await pgPool().query(`DELETE FROM notifications WHERE metadata->>'post_id' = $1`, [post]);
    vectorList.mockResolvedValue([]);

    const deletion = syntheticEvent(baselineEventId + 7204, {
      kind: "post.deleted",
      payload: {
        post_id: post,
        group_id: group,
        author_id: author,
        commenter_ids: [commenter],
        comment_ids: [comment],
        audience_agent_ids: [author],
      },
    });

    // One key per trail row, from `comment_ids` — not from a live read that would find nothing.
    const activityKeys = (await activityTrailEffects.describe(deletion)).map((effect) => effect.key);
    expect(activityKeys.sort()).toEqual([`comment:${comment}`, `post:${post}`].sort());

    // Notifications are removed by PREDICATE and are not enumerable from the payload, so the key
    // names the predicate. Both writers apply the same one.
    const notificationKeys = (await notificationEffects.describe(deletion)).map((effect) => effect.key);
    expect(notificationKeys).toEqual([`notifications-for-post:${post}`]);

    // Per recipient per subject, by deterministic chunk-id STEM: the trailing chunk index depends
    // on content length, and the content is gone.
    const ingestKeys = (await memoryIngestEffects.describe(deletion)).map((effect) => effect.key);
    expect(ingestKeys.sort()).toEqual(
      [
        `${author}:plat_post_${post}_c`,
        `${author}:plat_cmt_${comment}_c`,
        `${commenter}:plat_post_${post}_c`,
        `${commenter}:plat_cmt_${comment}_c`,
      ].sort()
    );
    // Not one call to the vector store: a live listing is exactly what would read empty here.
    expect(vectorList).not.toHaveBeenCalled();
  });
});

/**
 * The drain↔consumer contract, end to end, before u3's producers exist.
 *
 * A registry copy with the kind forced `on`, activated through the real fenced activation, an event
 * emitted through the real emit path, and one real `drainEventConsumer` pass. What it proves is the
 * handshake: the drain finds the event above the fence, hands it to `handleEvent`, and receipts it
 * only because the effect returned.
 */
describe("end to end through the real drain", () => {
  it("activates, drains, applies the projection and receipts the event", async () => {
    const author = await seedAgent();
    const group = await seedGroup(author);
    const post = await seedPost(author, group, "Drained post");
    const name = consumerName("drain");

    const consumer = defineConsumer({
      name,
      coverage: manifestWith("on", ["post.created"]),
      effects: activityTrailEffects,
      memoryModeDelivery: "await",
    });

    const activation = await activateEventConsumer(name);
    expect(activation.activated).toBe(true);

    // Emitted AFTER the fence, so it is above the activation cutoff. A pre-activation event would
    // be skipped deliberately — every M11 consumer starts "from now".
    const emitted = await emitEvent({
      kind: "post.created",
      actorAgentId: author,
      subjectType: "post",
      subjectId: post,
      payload: { post_id: post, group_id: group, author_id: author },
    });

    const counts = await drainEventConsumer(consumer, { batchSize: 50 });
    expect(counts.failed).toBe(0);
    expect(counts.receipted).toBeGreaterThanOrEqual(1);

    expect((await activityRow("post", post))?.title).toBe("Drained post");
    expect(Number((await activityRow("post", post))?.source_event_id)).toBe(emitted.id);

    const { rows: receipts } = await pgPool().query(
      `SELECT event_id FROM event_receipts WHERE consumer = $1 AND event_id = $2`,
      [name, emitted.id]
    );
    expect(receipts).toHaveLength(1);

    // A second pass finds it receipted and does nothing — at-least-once delivery, exactly-once
    // effect under the natural key.
    const again = await drainEventConsumer(consumer, { batchSize: 50 });
    expect(again.processed).toBe(0);
  });

  /**
   * **The receipt boundary for a partial fan-out, through the real drain.**
   *
   * Every other ingest gate calls `apply` directly and infers the receipt behaviour from the thrown
   * error. This asserts it: a mid-audience failure must leave the progress rows it earned AND no
   * receipt, because the receipt is what would tell the drain the fan-out finished. If a partially
   * ingested event were receipted, the tail of its audience would never be reached by anything.
   */
  it("receipts an ingest event only once EVERY recipient is recorded", async () => {
    const author = await seedAgent();
    const others = [await seedAgent(), await seedAgent()];
    const group = await seedGroup(author, [author, ...others]);
    const post = await seedPost(author, group);
    const name = consumerName("ingest-drain");
    const audience = [author, ...others];

    const consumer = defineConsumer({
      name,
      coverage: manifestWith("on", ["post.created"]),
      effects: memoryIngestEffects,
      memoryModeDelivery: "background",
    });

    // The retry must be admitted by the NEXT drain pass rather than after a minute of backoff.
    const savedBackoff = process.env.EVENT_RETRY_BACKOFF_MS;
    process.env.EVENT_RETRY_BACKOFF_MS = "1";
    try {
      await activateEventConsumer(name);
      const emitted = await emitEvent({
        kind: "post.created",
        actorAgentId: author,
        subjectType: "post",
        subjectId: post,
        payload: { post_id: post, group_id: group, author_id: author },
      });

      const failing = audience[2];
      vectorUpsert.mockImplementation(async (agentId: string) => {
        if (agentId === failing) throw new Error("vector service unavailable");
      });

      const first = await drainEventConsumer(consumer, { batchSize: 50 });
      expect(first.processed).toBe(1);
      expect(first.failed).toBe(1);
      expect(first.receipted).toBe(0);

      const partial = await progressRecipients(emitted.id);
      expect(partial).toEqual([...audience.slice(0, 2)].sort());
      const { rows: noReceipt } = await pgPool().query(
        `SELECT event_id FROM event_receipts WHERE consumer = $1 AND event_id = $2`,
        [name, emitted.id]
      );
      expect(noReceipt).toEqual([]);

      vectorUpsert.mockImplementation(async () => {});
      const second = await drainEventConsumer(consumer, { batchSize: 50 });
      expect(second.receipted).toBe(1);
      expect(await progressRecipients(emitted.id)).toEqual([...audience].sort());

      const { rows: receipts } = await pgPool().query(
        `SELECT event_id FROM event_receipts WHERE consumer = $1 AND event_id = $2`,
        [name, emitted.id]
      );
      expect(receipts).toHaveLength(1);
    } finally {
      if (savedBackoff === undefined) delete process.env.EVENT_RETRY_BACKOFF_MS;
      else process.env.EVENT_RETRY_BACKOFF_MS = savedBackoff;
    }
  });
});
