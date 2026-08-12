/**
 * M11-2 u3 `[integration]` — the posts producers against the real database.
 *
 * What only a database can show, and what this file is for:
 *  - **the rebuilt `createPost`**: cooldown claim, post insert and event are now ONE statement, so a
 *    concurrent burst admits exactly one and the losers charge nothing, write nothing and emit
 *    nothing — a property no single-threaded test can observe;
 *  - **causal coupling in the losing direction**: a decisive mutation raced to zero rows must emit
 *    no ghost event, checked through the u1 harness that renders the production fragment;
 *  - **the `post.deleted` payload built in SQL**: its comment ids, commenter ids and audience have to
 *    equal what the batch actually cleaned and what `collectAgentIdsForPostAudience` computes,
 *    because a deletion that names a different audience cleans different vectors than the ingest
 *    wrote;
 *  - **the transitional stamp**: the legacy activity row carries the event id its own statement
 *    emitted, and the same `occurred_at` the consumer projects;
 *  - **the shadow soak now that the post kinds are `shadow`** — driven through the REAL drain over
 *    the REAL shipped descriptors, not by calling `handleEvent` directly: the fence, the receipts,
 *    the coverage selection and the ingest claim are all part of what "shadow" means in production,
 *    and a direct invocation exercises none of them.
 *
 * The vector service is stubbed: nothing here is about embeddings.
 */
jest.mock("@/lib/memory/memory-service", () => ({
  upsertVectorChunkBatchForAgent: jest.fn(async () => {}),
  pruneIngestedVectorsForAgent: jest.fn(async () => {}),
  listVectorIdsForAgentByMetadata: jest.fn(async () => [] as string[]),
  deleteVectorsForAgent: jest.fn(async () => {}),
}));

import { createHash } from "crypto";
import { readFileSync } from "fs";
import { join } from "path";

import { POST as CREATE_POST_ROUTE } from "@/app/api/v1/posts/route";
import { createPost, deletePost, pinPost, unpinPost } from "@/lib/actions/posts";
import { executors } from "@/lib/agent-tools/definitions/posts";
import { activityTrailEffects } from "@/lib/events/consumers/activity-trail";
import { memoryIngestEffects } from "@/lib/events/consumers/memory-ingest";
import { notificationEffects } from "@/lib/events/consumers/notifications";
import { eventConsumers } from "@/lib/events/consumers/registry";
import { STORE_ASSIGNED_PAYLOAD_ID, type PreparedEvent } from "@/lib/events/kinds";
import * as memoryService from "@/lib/memory/memory-service";
import { collectAgentIdsForPostAudience, ingestPostForAudience } from "@/lib/memory/platform-ingest";
import { createPost as storeCreatePost, deletePost as storeDeletePost } from "@/lib/store/posts/db";
import { POST_COOLDOWN_MS } from "@/lib/store/rate-limit-windows";
import { getEventById } from "@/lib/store/events/db";
import { drainEventConsumer } from "@/lib/store/events/drain-db";
import { emitEventCtes, sqlColumn, sqlParam } from "@/lib/store/events/statement";
import type { StoredAgent, StoredEvent } from "@/lib/store-types";

import { withMiddlewareHeaders } from "../helpers/middleware-headers";
import { expectNoGhostEvent, runCoupledMutation } from "./helpers/causal-coupling";
import { runConcurrently, rejections } from "./helpers/concurrency";
import { closeIntegrationConnections, neonSql, pgPool } from "./helpers/db";
import { activateRealConsumers } from "./helpers/activate-consumers";

const vectorUpsert = memoryService.upsertVectorChunkBatchForAgent as jest.Mock;
const vectorList = memoryService.listVectorIdsForAgentByMetadata as jest.Mock;
const vectorDelete = memoryService.deleteVectorsForAgent as jest.Mock;
const REPO_ROOT = join(__dirname, "..", "..", "..");

const RUN = `${Date.now().toString(36)}_${Math.floor(Math.random() * 1e6).toString(36)}`;
let seq = 0;
const nextId = (kind: string) => `u3_${kind}_${RUN}_${(seq += 1)}`;
let baselineEventId = 0;

/** Long enough to survive `chunkTextForMemory`'s fifty-character minimum. */
const LONG_BODY =
  "A body long enough to survive the memory chunker's minimum chunk length, which is fifty characters.";

async function seedAgent(): Promise<StoredAgent> {
  const id = nextId("agent");
  // The key is carried on the fixture because the route race authenticates for real, through
  // `Authorization: Bearer` and the db lookup, rather than being handed an agent object.
  const apiKey = `u3_key_${id}`;
  await pgPool().query(
    `INSERT INTO agents (id, name, description, api_key, points, vote_points, evaluation_points,
                         legacy_unattributed_points, follower_count, is_claimed, created_at, is_vetted)
     VALUES ($1, $2, '', $3, 0, 0, 0, 0, 0, false, NOW(), true)`,
    [id, `${id}_named`, apiKey]
  );
  // The action only reads `id`, `isVetted` and `isAdmitted` off the agent; the rest is presentation.
  return { id, name: `${id}_named`, apiKey, isVetted: true } as StoredAgent;
}

/**
 * A request shaped the way production delivers one: bearer credentials plus the headers
 * `src/middleware.ts` stamps. Without `x-school-id` the access rule fails closed and the handler
 * never reaches the action.
 */
function postRequest(caller: StoredAgent, body: unknown): Request {
  return new Request(
    "https://safemolt.com/api/v1/posts",
    withMiddlewareHeaders({
      method: "POST",
      headers: { Authorization: `Bearer ${caller.apiKey}`, "content-type": "application/json" },
      body: JSON.stringify(body),
    })
  );
}

/**
 * A group whose membership is written to **both** places it lives.
 *
 * `groups.member_ids` is what the ingest audience reads (and what `post.deleted`'s SQL audience has
 * to match); `group_members` is what `isGroupMember` reads. A fixture that wrote only one of them
 * would make the action refuse every post, or make the audience assertion vacuous.
 */
async function seedGroup(ownerId: string, memberIds: string[] = []): Promise<string> {
  const id = nextId("group");
  const members = [ownerId, ...memberIds];
  await pgPool().query(
    `INSERT INTO groups (id, name, display_name, description, owner_id, member_ids, moderator_ids,
                         pinned_post_ids, created_at)
     VALUES ($1, $1, $1, '', $2, $3::jsonb, '[]'::jsonb, '[]'::jsonb, NOW())`,
    [id, ownerId, JSON.stringify(members)]
  );
  for (const agentId of members) {
    await pgPool().query(
      `INSERT INTO group_members (agent_id, group_id, joined_at) VALUES ($1, $2, NOW())
       ON CONFLICT DO NOTHING`,
      [agentId, id]
    );
  }
  return id;
}

/** Create a post straight through the db store, with the events the caller supplies. */
async function createPostRow(
  authorId: string,
  groupId: string,
  events: readonly PreparedEvent[]
): Promise<string | null> {
  const post = await storeCreatePost(authorId, groupId, "positional primary", LONG_BODY, undefined, events);
  return post?.id ?? null;
}

async function clearRateWindow(agentId: string): Promise<void> {
  await pgPool().query(`DELETE FROM agent_rate_limits WHERE agent_id = $1`, [agentId]);
}

/** Every event this run has written since the marker, oldest first. */
async function eventsSince(marker: number): Promise<StoredEvent[]> {
  const { rows } = await pgPool().query<{ id: string }>(
    `SELECT id FROM events WHERE id > $1 ORDER BY id`,
    [marker]
  );
  return Promise.all(rows.map(async (row) => (await getEventById(Number(row.id)))!));
}

async function maxEventId(): Promise<number> {
  const { rows } = await pgPool().query<{ id: string }>(`SELECT COALESCE(max(id), 0) AS id FROM events`);
  return Number(rows[0].id);
}

async function countPostsBy(agentId: string): Promise<number> {
  const { rows } = await pgPool().query<{ c: string }>(
    `SELECT count(*) AS c FROM posts WHERE author_id = $1`,
    [agentId]
  );
  return Number(rows[0].c);
}

/** The real consumer names, activated by the soak block and cleaned up after it. */
const REAL_CONSUMERS = eventConsumers.map((consumer) => consumer.name);

beforeAll(async () => {
  baselineEventId = await maxEventId();
});

beforeEach(() => {
  vectorUpsert.mockClear();
  // Nothing indexed by default; the delete soak installs an index so the cleanup has real ids to
  // remove, which is the only way its "what the inline delete removed" side is not vacuous.
  vectorList.mockReset();
  vectorList.mockImplementation(async () => [] as string[]);
  vectorDelete.mockClear();
});

afterAll(async () => {
  const like = `u3_%_${RUN}%`;
  // The soak block activates the SHIPPED consumer names, so their cursors and receipts are this
  // suite's to remove — a leftover cursor would change what the retention suite sees as prunable.
  await pgPool().query(`DELETE FROM event_receipts WHERE consumer = ANY($1::text[])`, [REAL_CONSUMERS]);
  await pgPool().query(`DELETE FROM event_consumer_failures WHERE consumer = ANY($1::text[])`, [REAL_CONSUMERS]);
  await pgPool().query(`DELETE FROM event_dead_letters WHERE consumer = ANY($1::text[])`, [REAL_CONSUMERS]);
  await pgPool().query(`DELETE FROM event_consumers WHERE consumer = ANY($1::text[])`, [REAL_CONSUMERS]);
  await pgPool().query(`DELETE FROM event_consumer_shadow WHERE event_id > $1`, [baselineEventId]);
  await pgPool().query(`DELETE FROM ingest_progress WHERE event_id > $1`, [baselineEventId]);
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
  await pgPool().query(`DELETE FROM comment_votes WHERE agent_id LIKE $1`, [like]);
  await pgPool().query(`DELETE FROM post_votes WHERE agent_id LIKE $1`, [like]);
  await pgPool().query(
    `DELETE FROM comments WHERE author_id LIKE $1
        OR post_id IN (SELECT id FROM posts WHERE author_id LIKE $1)`,
    [like]
  );
  await pgPool().query(`DELETE FROM posts WHERE author_id LIKE $1 OR group_id LIKE $1`, [like]);
  await pgPool().query(`DELETE FROM groups WHERE id LIKE $1`, [like]);
  await pgPool().query(`DELETE FROM schools WHERE id LIKE $1`, [like]);
  await pgPool().query(`DELETE FROM agents WHERE id LIKE $1`, [like]);
  await closeIntegrationConnections();
});

describe("createPost — one statement for the cooldown, the post and the event", () => {
  it("admits exactly one of a concurrent burst, and emits exactly one event", async () => {
    const author = await seedAgent();
    const group = await seedGroup(author.id);
    await clearRateWindow(author.id);
    const marker = await maxEventId();

    // A burst through the ONE path both surfaces now share, which is the point of the chunk: before
    // P1.1 the route and the tool each pre-checked the window and then wrote independently.
    const outcomes = await runConcurrently(
      [1, 2, 3, 4].map((n) => () => createPost({ agent: author, groupName: group, title: `race ${n}` }))
    );

    // Refused, never errored: the loser's claim matches zero rows so its gated insert selects from
    // an empty CTE. A 23505 here would mean the statement shape was wrong.
    expect(rejections(outcomes)).toEqual([]);
    expect(outcomes.filter((outcome) => outcome.ok && outcome.value.ok)).toHaveLength(1);
    expect(await countPostsBy(author.id)).toBe(1);

    const emitted = await eventsSince(marker);
    expect(emitted.map((event) => event.kind)).toEqual(["post.created"]);
    const { rows } = await pgPool().query<{ id: string }>(`SELECT id FROM posts WHERE author_id = $1`, [
      author.id,
    ]);
    expect(emitted[0].subjectId).toBe(rows[0].id);
    expect(emitted[0].payload).toMatchObject({ post_id: rows[0].id, group_id: group, author_id: author.id });
  });

  /**
   * **The two REAL surfaces, racing each other.**
   *
   * The burst above calls the action directly and the adapter tests mock it, so neither one exercises
   * what P1.1 actually claims: that `POST /api/v1/posts` and the `create_post` tool no longer have
   * independent cooldown checks. This drives the shipped route handler — authenticating for real off
   * the `Authorization` header, through the access gate — against the shipped tool executor, for one
   * agent, at the boundary. Exactly one may be admitted, and the loser has to be a rate-limit refusal
   * in its own vocabulary rather than an error: the two surfaces publish different envelopes over the
   * same `ActionResult`.
   */
  it("admits exactly one when the real route and the real tool executor race", async () => {
    const author = await seedAgent();
    const group = await seedGroup(author.id);
    await clearRateWindow(author.id);
    const marker = await maxEventId();
    const startedAt = Date.now();

    const outcomes = await runConcurrently<boolean>([
      async () => {
        const response = await CREATE_POST_ROUTE(postRequest(author, { group, title: "route" }) as never);
        const parsed = (await response.json()) as {
          error?: string;
          error_detail?: { code?: string };
          retry_after_minutes?: number;
        };
        if (response.status === 200) return true;
        // The route's own 429 envelope, unchanged by the adapter refactor.
        expect(response.status).toBe(429);
        expect(parsed.error).toBe("Post cooldown");
        expect(parsed.error_detail?.code).toBe("rate_limited");
        return false;
      },
      async () => {
        const result = await executors.create_post({ group_name: group, title: "tool" }, { agent: author });
        if (result.success) return true;
        // The tool's own refusal envelope for the same refusal.
        expect(result.error).toBe("Post cooldown");
        expect((result.data as { code?: string } | undefined)?.code).toBe("rate_limited");
        return false;
      },
    ]);

    expect(rejections(outcomes)).toEqual([]);
    expect(outcomes.filter((outcome) => outcome.ok && outcome.value)).toHaveLength(1);
    expect(await countPostsBy(author.id)).toBe(1);

    // One stamp, charged by this race: the loser's claim matched zero rows, so it wrote nothing.
    const { rows: window } = await pgPool().query<{ last_post_at: string }>(
      `SELECT last_post_at FROM agent_rate_limits WHERE agent_id = $1`,
      [author.id]
    );
    expect(window).toHaveLength(1);
    expect(Number(window[0].last_post_at)).toBeGreaterThanOrEqual(startedAt);

    expect((await eventsSince(marker)).map((event) => event.kind)).toEqual(["post.created"]);
  });

  it("charges nothing, writes nothing and emits nothing when the cooldown refuses", async () => {
    const author = await seedAgent();
    const group = await seedGroup(author.id);
    await clearRateWindow(author.id);
    expect((await createPost({ agent: author, groupName: group, title: "first" })).ok).toBe(true);

    const { rows: before } = await pgPool().query<{ last_post_at: string }>(
      `SELECT last_post_at FROM agent_rate_limits WHERE agent_id = $1`,
      [author.id]
    );
    const marker = await maxEventId();

    const refused = await createPost({ agent: author, groupName: group, title: "second" });

    expect(refused).toMatchObject({ ok: false, code: "rate_limited" });
    // A refusal that re-stamped the window would extend the caller's own cooldown on every retry.
    const { rows: after } = await pgPool().query<{ last_post_at: string }>(
      `SELECT last_post_at FROM agent_rate_limits WHERE agent_id = $1`,
      [author.id]
    );
    expect(after[0].last_post_at).toBe(before[0].last_post_at);
    expect(await countPostsBy(author.id)).toBe(1);
    expect(await eventsSince(marker)).toEqual([]);
  });

  /**
   * The no-ghost-events check, in the shape `createPost` actually renders.
   *
   * The u1 harness runs the production `emitEventStatement` fragment against a decisive CTE that
   * matches zero rows. Here the decisive CTE is the post insert gated on a cooldown claim that
   * refused — the exact arrangement the rebuilt statement uses — so a fragment that emitted beside
   * the mutation rather than from it would be visible.
   */
  it("emits nothing when the post insert is raced to zero rows", async () => {
    const author = await seedAgent();
    const group = await seedGroup(author.id);

    await expectNoGhostEvent({
      decisiveSql: `
        INSERT INTO posts (id, title, content, url, author_id, group_id, upvotes, downvotes, comment_count, created_at)
        SELECT $1::text, 'ghost', NULL, NULL, $2::text, $3::text, 0, 0, 0, NOW()
        WHERE EXISTS (SELECT 1 FROM agent_rate_limits WHERE agent_id = $2 AND last_post_at = -1)
        RETURNING id
      `,
      decisiveParams: [nextId("post"), author.id, group],
      event: {
        kind: "post.created",
        actorAgentId: author.id,
        subjectType: "post",
        payload: { post_id: "never", group_id: group, author_id: author.id },
      },
    });
  });

  /**
   * `last_active_at` has exactly one writer after P1.1: the per-request authentication touch.
   *
   * The store used to bump it here as a second statement, which made P6.4's discipline test
   * unenforceable and P1.4's "never authenticated" predicate ambiguous.
   */
  it("does not bump last_active_at", async () => {
    const author = await seedAgent();
    const group = await seedGroup(author.id);
    await clearRateWindow(author.id);

    expect((await createPost({ agent: author, groupName: group, title: "quiet" })).ok).toBe(true);

    const { rows } = await pgPool().query<{ last_active_at: Date | null }>(
      `SELECT last_active_at FROM agents WHERE id = $1`,
      [author.id]
    );
    expect(rows[0].last_active_at).toBeNull();
  });

  /**
   * The transitional stamp, from the statement that wrote both the post and the event.
   *
   * The consumer refuses to overwrite a projection whose recorded source event is newer; a legacy
   * row left at NULL yields to any event at all, so during the dual-write phase the order between
   * the two writers would be decided by whichever landed last.
   */
  it("stamps the legacy activity row with the event id, and shares the consumer's occurred_at", async () => {
    const author = await seedAgent();
    const group = await seedGroup(author.id);
    await clearRateWindow(author.id);
    const marker = await maxEventId();

    const created = await createPost({ agent: author, groupName: group, title: "stamped", content: LONG_BODY });
    expect(created.ok).toBe(true);
    const post = created.ok ? created.data.post : null;
    const emitted = await eventsSince(marker);

    const { rows } = await pgPool().query<{ source_event_id: string | null; occurred_at: Date }>(
      `SELECT source_event_id, occurred_at FROM activity_events WHERE kind = 'post' AND entity_id = $1`,
      [post!.id]
    );
    expect(Number(rows[0].source_event_id)).toBe(emitted[0].id);
    // EXACT equality with the post's own timestamp — which is what the consumer projects too, and
    // why `post.created` could leave `OCCURRED_AT_STAMP_PENDING_KINDS` without stamping a clock.
    expect(rows[0].occurred_at.toISOString()).toBe(post!.createdAt);
  });
});

describe("deletePost — the payload the batch builds under its own locks", () => {
  it("emits one post.deleted whose ids are what the batch cleaned and what ingest would fan out to", async () => {
    const author = await seedAgent();
    const member = await seedAgent();
    const commenter = await seedAgent();
    const follower = await seedAgent();
    const group = await seedGroup(author.id, [member.id]);
    await pgPool().query(`INSERT INTO following (follower_id, followee_id) VALUES ($1, $2)`, [
      follower.id,
      author.id,
    ]);
    await clearRateWindow(author.id);
    const created = await createPost({ agent: author, groupName: group, title: "doomed", content: LONG_BODY });
    const post = created.ok ? created.data.post : null;

    // Commenters who are NOT members: commenting requires no membership, so no recomputed post
    // audience reproduces them — which is exactly why they ride the payload.
    //
    // **Three comments by TWO commenters**, deliberately. A single-commenter fixture agrees with any
    // aggregate at all, because a one-element list is sorted however it is produced — so it would
    // pass just as happily against `jsonb_agg(DISTINCT …)`, whose output order Postgres does not
    // specify while the memory store's `sort()` does.
    const secondCommenter = await seedAgent();
    const authored: Array<[string, string]> = [
      [nextId("comment"), commenter.id],
      [nextId("comment"), secondCommenter.id],
      [nextId("comment"), commenter.id],
    ];
    for (const [id, authorOfComment] of authored) {
      await pgPool().query(
        `INSERT INTO comments (id, post_id, author_id, content, upvotes, created_at)
         VALUES ($1, $2, $3, 'a comment', 0, NOW())`,
        [id, post!.id, authorOfComment]
      );
    }
    const commentIds = authored.map(([id]) => id).sort();
    const commenterIds = [...new Set(authored.map(([, who]) => who))].sort();
    expect(commenterIds).toHaveLength(2);
    await pgPool().query(
      `INSERT INTO post_votes (agent_id, post_id, vote_type, voted_at, points_delta) VALUES ($1, $2, 1, NOW(), 1)`,
      [member.id, post!.id]
    );
    await pgPool().query(`UPDATE groups SET pinned_post_ids = $2::jsonb WHERE id = $1`, [
      group,
      JSON.stringify([post!.id]),
    ]);

    const expectedAudience = await collectAgentIdsForPostAudience(post!);
    const marker = await maxEventId();

    const deleted = await deletePost({ agent: author, postId: post!.id });
    expect(deleted.ok).toBe(true);

    const emitted = await eventsSince(marker);
    expect(emitted.map((event) => event.kind)).toEqual(["post.deleted"]);
    expect(emitted[0].payload).toEqual({
      post_id: post!.id,
      group_id: group,
      author_id: author.id,
      comment_ids: commentIds,
      // Sorted and deduplicated, matching `Array.prototype.sort` on the memory side exactly.
      commenter_ids: commenterIds,
      // Identical to what the ingest fan-out computes, derivation for derivation. The SQL cannot
      // call `orderAndCapPostAudience`, so the equality is asserted rather than shared.
      audience_agent_ids: expectedAudience,
    });
    expect(expectedAudience).toEqual([author.id, member.id, follower.id].sort((a, b) => {
      // author first, then members by id, then followers by id — the priority order the cap depends on.
      if (a === author.id) return -1;
      if (b === author.id) return 1;
      return a.localeCompare(b);
    }));
    // The batch also removed the pin, which is what the payload's audience is about to be spent on.
    const { rows } = await pgPool().query(`SELECT pinned_post_ids FROM groups WHERE id = $1`, [group]);
    expect(rows[0].pinned_post_ids).toEqual([]);
  });

  it("changes nothing and emits nothing for a non-author, or for a second delete", async () => {
    const author = await seedAgent();
    const stranger = await seedAgent();
    const group = await seedGroup(author.id);
    await clearRateWindow(author.id);
    const created = await createPost({ agent: author, groupName: group, title: "mine", content: LONG_BODY });
    const post = created.ok ? created.data.post : null;

    let marker = await maxEventId();
    expect(await deletePost({ agent: stranger, postId: post!.id })).toMatchObject({ ok: false, code: "not_found" });
    expect(await eventsSince(marker)).toEqual([]);
    const { rows: alive } = await pgPool().query(`SELECT deleted_at FROM posts WHERE id = $1`, [post!.id]);
    expect(alive[0].deleted_at).toBeNull();

    expect((await deletePost({ agent: author, postId: post!.id })).ok).toBe(true);
    marker = await maxEventId();
    expect(await deletePost({ agent: author, postId: post!.id })).toMatchObject({ ok: false, code: "not_found" });
    expect(await eventsSince(marker)).toEqual([]);
  });
});

describe("pin and delete under contention", () => {
  it("leaves no deleted id pinned, and no event without its write", async () => {
    const author = await seedAgent();
    const group = await seedGroup(author.id);
    await clearRateWindow(author.id);
    const created = await createPost({ agent: author, groupName: group, title: "pin or delete", content: LONG_BODY });
    const post = created.ok ? created.data.post : null;
    const marker = await maxEventId();

    // The pin takes `FOR SHARE` on the live post and the delete takes `FOR UPDATE`, so these
    // serialize: either the pin lands first and the delete's cleanup removes it, or the pin blocks
    // and then resolves against a tombstone and writes nothing.
    const outcomes = await runConcurrently<{ ok: boolean }>([
      () => pinPost({ agent: author, postId: post!.id }),
      () => deletePost({ agent: author, postId: post!.id }),
    ]);
    expect(rejections(outcomes)).toEqual([]);

    const { rows } = await pgPool().query(`SELECT pinned_post_ids FROM groups WHERE id = $1`, [group]);
    expect(rows[0].pinned_post_ids).toEqual([]);

    // Every event that survived has a write behind it: a `post.pinned` only exists if the pin landed
    // (and the delete then cleaned it away), and there is exactly one `post.deleted`.
    const emitted = await eventsSince(marker);
    expect(emitted.filter((event) => event.kind === "post.deleted")).toHaveLength(1);
    const pinnedEvents = emitted.filter((event) => event.kind === "post.pinned");
    const pinSucceeded = outcomes[0].ok && outcomes[0].value.ok;
    expect(pinnedEvents).toHaveLength(pinSucceeded ? 1 : 0);
  });

  it("persists two concurrent distinct pins, with two events", async () => {
    const author = await seedAgent();
    const group = await seedGroup(author.id);
    await clearRateWindow(author.id);
    const first = await createPost({ agent: author, groupName: group, title: "one", content: LONG_BODY });
    await pgPool().query(`UPDATE agent_rate_limits SET last_post_at = $2 WHERE agent_id = $1`, [
      author.id,
      Date.now() - POST_COOLDOWN_MS - 1,
    ]);
    const second = await createPost({ agent: author, groupName: group, title: "two", content: LONG_BODY });
    const ids = [first.ok ? first.data.post.id : "", second.ok ? second.data.post.id : ""];
    const marker = await maxEventId();

    const outcomes = await runConcurrently(ids.map((id) => () => pinPost({ agent: author, postId: id })));
    expect(rejections(outcomes)).toEqual([]);
    expect(outcomes.filter((outcome) => outcome.ok && outcome.value.ok)).toHaveLength(2);

    const { rows } = await pgPool().query<{ pinned_post_ids: string[] }>(
      `SELECT pinned_post_ids FROM groups WHERE id = $1`,
      [group]
    );
    expect([...rows[0].pinned_post_ids].sort()).toEqual([...ids].sort());
    expect((await eventsSince(marker)).filter((event) => event.kind === "post.pinned")).toHaveLength(2);
  });

  it("emits post.unpinned for an authorized unpin and nothing for an unauthorized one", async () => {
    const owner = await seedAgent();
    const stranger = await seedAgent();
    const group = await seedGroup(owner.id);
    await clearRateWindow(owner.id);
    const created = await createPost({ agent: owner, groupName: group, title: "unpin me", content: LONG_BODY });
    const post = created.ok ? created.data.post : null;
    expect((await pinPost({ agent: owner, postId: post!.id })).ok).toBe(true);

    let marker = await maxEventId();
    expect(await unpinPost({ agent: stranger, postId: post!.id })).toMatchObject({ ok: false, code: "forbidden" });
    expect(await eventsSince(marker)).toEqual([]);

    marker = await maxEventId();
    expect((await unpinPost({ agent: owner, postId: post!.id })).ok).toBe(true);
    expect((await eventsSince(marker)).map((event) => event.kind)).toEqual(["post.unpinned"]);
  });
});


/**
 * The legacy ingest, now scheduled by the ACTION and therefore by both surfaces.
 *
 * It used to be scheduled by `posts/route.ts` alone. That was survivable while `post.created` was
 * `legacy` — nothing compared anything — but it stops being survivable the moment the kind enters
 * `shadow`: a `create_post` tool call emits the same event with the same shadow keys, and there
 * would have been no legacy vectors on the other side of the diff for that half of the population.
 * The soak would have reported a mismatch on every tool-created post, which is nobody's defect.
 */
describe("legacy ingest is scheduled by every producer, not by one surface", () => {
  /** The chunks the legacy fan-out handed the vector store, flattened per (recipient, chunk). */
  function writtenChunks(): Array<{ key: string; text_sha256: string }> {
    return vectorUpsert.mock.calls.flatMap(
      ([agentId, chunks]: [string, Array<{ id: string; text: string }>]) =>
        chunks.map((chunk) => ({
          key: `${agentId}:${chunk.id}`,
          text_sha256: createHash("sha256").update(chunk.text).digest("hex"),
        }))
    );
  }

  /** Wait for the producer's OWN fire-and-forget fan-out to reach the vector store. */
  async function awaitScheduledChunks(timeoutMs = 15_000): Promise<Array<{ key: string; text_sha256: string }>> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const written = writtenChunks();
      if (written.length > 0) {
        // One more tick, so a fan-out still mid-audience is not sampled half-written.
        await new Promise((resolve) => setTimeout(resolve, 100));
        return writtenChunks();
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    return writtenChunks();
  }

  it.each([
    [
      "the REST action",
      async (agent: StoredAgent, group: string) => {
        const created = await createPost({ agent, groupName: group, title: "ingested", content: LONG_BODY });
        return created.ok ? created.data.post.id : null;
      },
    ],
    [
      "the create_post tool",
      async (agent: StoredAgent, group: string) => {
        const result = await executors.create_post(
          { group_name: group, title: "ingested", content: LONG_BODY },
          { agent }
        );
        return result.success ? (result.data as { post_id: string }).post_id : null;
      },
    ],
  ])("%s schedules the fan-out ITSELF, and its keys are the ones the shadow row describes", async (_name, produce) => {
    const author = await seedAgent();
    const group = await seedGroup(author.id);
    await clearRateWindow(author.id);
    const marker = await maxEventId();

    const postId = await produce(author, group);
    expect(postId).not.toBeNull();
    const [event] = await eventsSince(marker);
    expect(event.kind).toBe("post.created");

    // **Observed, not re-derived.** Calling `ingestPostForAudience` here would prove the helper works
    // and say nothing about whether the producer reached it — which is the whole claim, and exactly
    // what was false for the tool before the scheduler moved into the action. The scheduler is
    // fire-and-forget, so this waits for the writes it started rather than starting its own.
    const scheduled = await awaitScheduledChunks();
    expect(scheduled.length).toBeGreaterThan(0);

    // Compared as KEY SETS, not as call counts: a second write under the same deterministic chunk id
    // is the idempotence the natural key is for, not a second effect.
    const described = await memoryIngestEffects.describe(event);
    expect([...new Set(described.map((effect) => effect.key))].sort()).toEqual(
      [...new Set(scheduled.map((row) => row.key))].sort()
    );
  });

  /**
   * The manual derivation, kept as its own gate.
   *
   * The test above proves the producers *reach* the fan-out; this one proves the fan-out the shadow
   * row describes is the same one the shared helper computes, with no scheduling in the picture.
   */
  it("matches the shared fan-out helper's own keys, derived directly", async () => {
    const author = await seedAgent();
    const group = await seedGroup(author.id);
    await clearRateWindow(author.id);
    const marker = await maxEventId();
    const created = await createPost({ agent: author, groupName: group, title: "derived", content: LONG_BODY });
    const [event] = await eventsSince(marker);

    vectorUpsert.mockClear();
    await ingestPostForAudience(created.ok ? created.data.post : ({} as never));
    const derived = writtenChunks();
    expect(derived.length).toBeGreaterThan(0);

    const described = await memoryIngestEffects.describe(event);
    expect([...new Set(described.map((effect) => effect.key))].sort()).toEqual(
      [...new Set(derived.map((row) => row.key))].sort()
    );
  });

  it("leaves no schedulePostMemoryIngest call on the route, so the two surfaces cannot diverge again", () => {
    const route = readFileSync(join(REPO_ROOT, "src/app/api/v1/posts/route.ts"), "utf8");
    expect(route).not.toContain("schedulePostMemoryIngest");
  });
});

/**
 * The store-assigned placeholder, and what happens when a store forgets to replace it.
 *
 * The three `post.deleted` id lists are filled by the store, not by the action, and the failure mode
 * of a missed merge is invisible: an empty array is a perfectly valid audience, so an unfilled field
 * would be a cleanup that quietly reaches nobody, receipted and never revisited. The action therefore
 * seeds each list with `STORE_ASSIGNED_PAYLOAD_ID`, and a survivor has to dead-letter.
 */
describe("an unfilled store-assigned field dead-letters instead of skipping", () => {
  const withPayload = (payload: Record<string, unknown>): StoredEvent => ({
    id: baselineEventId + 1,
    kind: "post.deleted",
    actorAgentId: "u3_ghost",
    subjectType: "post",
    subjectId: "u3_ghost_post",
    secondarySubjectId: null,
    schoolId: null,
    idemKey: null,
    payload,
    createdAt: new Date().toISOString(),
  });

  const filled = {
    post_id: "u3_ghost_post",
    group_id: "u3_ghost_group",
    author_id: "u3_ghost",
    comment_ids: ["u3_ghost_comment"],
    commenter_ids: ["u3_ghost_commenter"],
    audience_agent_ids: ["u3_ghost"],
  };

  it.each(["post_id", "comment_ids", "commenter_ids", "audience_agent_ids"])(
    "refuses a %s the store did not replace",
    async (field) => {
      const unfilled = withPayload({
        ...filled,
        [field]: field.endsWith("_ids") ? [STORE_ASSIGNED_PAYLOAD_ID] : STORE_ASSIGNED_PAYLOAD_ID,
      });
      // Both halves of the consumer contract refuse it — the soak's `describe` and the real `apply`.
      for (const effects of [activityTrailEffects, memoryIngestEffects, notificationEffects]) {
        const refusals = await Promise.allSettled([effects.describe(unfilled), effects.apply(unfilled)]);
        // Only the consumers that actually read the field refuse; every one of them refuses on
        // `post_id`, which all three key on.
        if (field === "post_id") {
          expect(refusals.every((outcome) => outcome.status === "rejected")).toBe(true);
        }
      }
      // The activity consumer reads `comment_ids`; the ingest consumer reads all three lists.
      const reader = field === "comment_ids" ? activityTrailEffects : memoryIngestEffects;
      await expect(reader.describe(unfilled)).rejects.toThrow(/store-assigned placeholder|not a non-empty/);
    }
  );

  it("accepts the same payload once every field is filled", async () => {
    await expect(activityTrailEffects.describe(withPayload(filled))).resolves.toHaveLength(2);
  });
});

/**
 * The soak, driven through the REAL drain over the REAL shipped descriptors.
 *
 * A direct `handleEvent` call proves only that the effects module does what it says. What production
 * runs is the drain: it activates a consumer behind a fence event, scans by receipt anti-join,
 * selects behavior from the checked-in coverage manifest, takes the ingest fan-out claim and writes a
 * receipt. Every one of those can break a cutover on its own, so the soak is exercised end to end:
 * activate first (the fence classifies everything before it as pre-activation), then run the real
 * create and delete actions, then drain.
 */
describe("shadow parity through the real drain", () => {
  async function shadowRows(
    eventId: number
  ): Promise<Array<{ consumer: string; effect_key: string; payload: Record<string, unknown> }>> {
    const { rows } = await pgPool().query(
      `SELECT consumer, effect_key, payload FROM event_consumer_shadow WHERE event_id = $1
       ORDER BY consumer, effect_key`,
      [eventId]
    );
    return rows as Array<{ consumer: string; effect_key: string; payload: Record<string, unknown> }>;
  }

  async function receipted(eventId: number): Promise<string[]> {
    const { rows } = await pgPool().query<{ consumer: string }>(
      `SELECT consumer FROM event_receipts WHERE event_id = $1 ORDER BY consumer`,
      [eventId]
    );
    return rows.map((row) => row.consumer);
  }

  /** Activate every shipped consumer, then drain them all. Returns nothing; assertions read rows. */
  async function drainAll(): Promise<void> {
    for (const consumer of eventConsumers) await drainEventConsumer(consumer, { batchSize: 200 });
  }

  beforeAll(async () => {
    await activateRealConsumers();
  });

  it("records post.created shadow rows that match the legacy projections, occurred_at included", async () => {
    const author = await seedAgent();
    const group = await seedGroup(author.id);
    await clearRateWindow(author.id);
    const marker = await maxEventId();
    const created = await createPost({ agent: author, groupName: group, title: "soaked", content: LONG_BODY });
    const post = created.ok ? created.data.post : null;
    const [event] = await eventsSince(marker);

    await drainAll();

    // Every consumer receipted it — `shadow` and `none` both receipt, which is what keeps the scan
    // floor moving. A missing receipt here would wedge the floor at this id forever.
    expect(await receipted(event.id)).toEqual([...REAL_CONSUMERS].sort());

    const shadow = await shadowRows(event.id);
    // Notifications produce nothing for a fresh post — `none`, not `legacy`: no inline writer
    // notifies on post creation and the 3-type union has no member for it.
    expect(shadow.filter((row) => row.consumer === "notifications")).toEqual([]);

    const activity = shadow.filter((row) => row.consumer === "activity-trail");
    expect(activity.map((row) => row.effect_key)).toEqual([`post:${post!.id}`]);
    const { rows: legacy } = await pgPool().query(
      `SELECT kind, occurred_at, actor_id, entity_id, title, href, summary, context_hint, metadata
       FROM activity_events WHERE kind = 'post' AND entity_id = $1`,
      [post!.id]
    );
    const volatile = new Set(activityTrailEffects.volatileShadowFields?.["post.created"] ?? []);
    for (const [field, value] of Object.entries(legacy[0] as Record<string, unknown>)) {
      if (volatile.has(field)) continue;
      const expected = value instanceof Date ? value.toISOString() : value;
      expect({ [field]: activity[0].payload[field] }).toEqual({ [field]: expected });
    }

    // Ingest describes one row per recipient per chunk; the audience is the author alone here.
    const ingest = shadow.filter((row) => row.consumer === "memory-ingest");
    expect(ingest.length).toBeGreaterThan(0);
    expect(ingest.every((row) => row.effect_key.startsWith(`${author.id}:plat_post_${post!.id}_c`))).toBe(true);

    // Shadow writes NO real projection: that is the whole difference between `shadow` and `on`, and
    // the receipt above would look identical either way.
    const { rows: notifications } = await pgPool().query(
      `SELECT 1 FROM notifications WHERE metadata->>'post_id' = $1`,
      [post!.id]
    );
    expect(notifications).toEqual([]);
  });

  /**
   * **Every consumer's keys are compared against rows that really existed and really went away.**
   *
   * The comparison is only worth anything if the reference set is what the INLINE delete removed,
   * so all three projections are seeded before the delete and captured while they are still
   * readable: trail rows for the post and its comment, notifications anchored on the post's id, and
   * a vector index for both recipients. Without the seeds the delete removes nothing and the
   * assertions hold against any key set at all — the vector mock in particular answered with an
   * empty list, so the ingest keys were being checked against a hand-written expectation rather
   * than against an observed effect.
   */
  it("records post.deleted key-only shadow rows matching what the inline delete removed", async () => {
    const author = await seedAgent();
    const commenter = await seedAgent();
    const group = await seedGroup(author.id);
    await clearRateWindow(author.id);
    const created = await createPost({ agent: author, groupName: group, title: "soaked delete", content: LONG_BODY });
    const post = created.ok ? created.data.post : null;
    const commentId = nextId("comment");
    await pgPool().query(
      `INSERT INTO comments (id, post_id, author_id, content, upvotes, created_at)
       VALUES ($1, $2, $3, 'to be removed', 0, NOW())`,
      [commentId, post!.id, commenter.id]
    );
    await pgPool().query(
      `INSERT INTO activity_events (kind, occurred_at, actor_id, actor_name, actor_canonical_name,
                                    entity_id, title, href, summary, context_hint, search_text, metadata)
       VALUES ('comment', NOW(), $1, '', '', $2, 't', '/x', 's', 'c', 'st', '{}'::jsonb)
       ON CONFLICT DO NOTHING`,
      [commenter.id, commentId]
    );
    // Post-anchored notifications, the rows batch element 5 removes by predicate. They have no FK to
    // `posts`, so nothing else would ever take them — and with none seeded the delete removed
    // nothing and the notifications key was compared against itself.
    for (const [recipient, type] of [
      [author.id, "comment_on_my_post"],
      [commenter.id, "reply_to_my_comment"],
    ]) {
      await pgPool().query(
        `INSERT INTO notifications (id, agent_id, type, created_at, href, metadata)
         VALUES ($1, $2, $3, NOW(), '/x', jsonb_build_object('post_id', $4::text))`,
        [nextId("notif"), recipient, type, post!.id]
      );
    }
    // The vectors the ingest fan-out would have written: the post's chunk and its comment's, held by
    // both recipients — the author through the group audience, the commenter through comment ingest.
    const indexedChunks = new Map<string, string[]>([
      [author.id, [`plat_post_${post!.id}_c0`, `plat_cmt_${commentId}_c0`]],
      [commenter.id, [`plat_post_${post!.id}_c0`, `plat_cmt_${commentId}_c0`]],
    ]);
    vectorList.mockImplementation(async (agentId: string) => [...(indexedChunks.get(agentId) ?? [])]);

    // What the inline delete is about to remove, captured while it still exists — the only moment
    // the reference set is readable, which is why the shadow keys come from the payload instead.
    const { rows: before } = await pgPool().query<{ kind: string; entity_id: string }>(
      `SELECT kind, entity_id FROM activity_events
       WHERE (kind = 'post' AND entity_id = $1) OR (kind = 'comment' AND entity_id = $2)
       ORDER BY kind, entity_id`,
      [post!.id, commentId]
    );
    const capturedActivityKeys = before.map((row) => `${row.kind}:${row.entity_id}`).sort();
    expect(capturedActivityKeys).toEqual([`comment:${commentId}`, `post:${post!.id}`]);
    const { rows: notificationsBefore } = await pgPool().query<{ id: string; post_id: string }>(
      `SELECT id, metadata->>'post_id' AS post_id FROM notifications WHERE metadata->>'post_id' = $1`,
      [post!.id]
    );
    expect(notificationsBefore).toHaveLength(2);
    const capturedVectorKeys = [...indexedChunks].flatMap(([agentId, chunkIds]) =>
      chunkIds.map((chunkId) => `${agentId}:${chunkId}`)
    );

    const marker = await maxEventId();
    expect((await deletePost({ agent: author, postId: post!.id })).ok).toBe(true);
    const [event] = await eventsSince(marker);

    // The inline delete really removed the captured rows — the other half of every comparison below.
    const { rows: notificationsAfter } = await pgPool().query(
      `SELECT id FROM notifications WHERE metadata->>'post_id' = $1`,
      [post!.id]
    );
    expect(notificationsAfter).toEqual([]);
    const deletedVectorKeys = vectorDelete.mock.calls
      .flatMap(([agentId, chunkIds]: [string, string[]]) => chunkIds.map((id) => `${agentId}:${id}`))
      .sort();
    expect(deletedVectorKeys).toEqual([...capturedVectorKeys].sort());

    await drainAll();

    expect(await receipted(event.id)).toEqual([...REAL_CONSUMERS].sort());
    const shadow = await shadowRows(event.id);
    expect(
      shadow.filter((row) => row.consumer === "activity-trail").map((row) => row.effect_key).sort()
    ).toEqual(capturedActivityKeys);
    // Notifications are removed by PREDICATE and were never enumerable, so the consumer's key names
    // the predicate — derived here from the rows the delete actually took, not written out.
    expect(shadow.filter((row) => row.consumer === "notifications").map((row) => row.effect_key)).toEqual(
      [...new Set(notificationsBefore.map((row) => `notifications-for-post:${row.post_id}`))]
    );
    // Key-only: a deletion has no canonical payload to diff, because its rows are gone.
    for (const row of shadow) expect(row.payload.operation).toBe("delete");
    // The ingest keys are stems — the chunk INDEX depends on content length and the content is gone —
    // so the captured ids are reduced to their stems and compared against the drained keys.
    expect(
      shadow.filter((row) => row.consumer === "memory-ingest").map((row) => row.effect_key).sort()
    ).toEqual([...new Set(deletedVectorKeys.map((key) => key.replace(/\d+$/, "")))].sort());
  });

  /**
   * The legacy cross-post reply fixture (P1.1's gate), against the tree rather than the plan's prose.
   *
   * **Amendment, `ai/validation/m11-inventory.md` §8 "Runbook — P1.1".** P1.1's gate describes the
   * external child surviving "with `parent_id` nulled". That prose predates M11-1b D1's shipped
   * design: the delete is a tombstone and removes nothing, and the detach is
   * `scripts/repair-cross-post-replies.sql` — a runbook step that has already run, whose clean output
   * is P1.1's deploy gate. The tree behavior stands; what P1.1 owes is that adding the event changes
   * none of it.
   */
  it("succeeds over a legacy cross-post reply, leaving the external child intact", async () => {
    const author = await seedAgent();
    const other = await seedAgent();
    const group = await seedGroup(author.id, [other.id]);
    await clearRateWindow(author.id);
    const doomed = await createPost({ agent: author, groupName: group, title: "doomed", content: LONG_BODY });
    await clearRateWindow(other.id);
    const host = await createPost({ agent: other, groupName: group, title: "host", content: LONG_BODY });

    const parentId = nextId("comment");
    await pgPool().query(
      `INSERT INTO comments (id, post_id, author_id, content, upvotes, created_at)
       VALUES ($1, $2, $3, 'parent', 0, NOW())`,
      [parentId, doomed.ok ? doomed.data.post.id : "", author.id]
    );
    // The legacy row D3 froze the producer of: a reply on ANOTHER post naming this parent.
    const childId = nextId("comment");
    await pgPool().query(
      `INSERT INTO comments (id, post_id, author_id, content, parent_id, upvotes, created_at)
       VALUES ($1, $2, $3, 'external child', $4, 0, NOW())`,
      [childId, host.ok ? host.data.post.id : "", other.id, parentId]
    );

    const marker = await maxEventId();
    expect((await deletePost({ agent: author, postId: doomed.ok ? doomed.data.post.id : "" })).ok).toBe(true);

    expect((await eventsSince(marker)).map((event) => event.kind)).toEqual(["post.deleted"]);
    const { rows } = await pgPool().query<{ post_id: string; parent_id: string | null }>(
      `SELECT post_id, parent_id FROM comments WHERE id = $1`,
      [childId]
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].post_id).toBe(host.ok ? host.data.post.id : "");
    expect(rows[0].parent_id).toBe(parentId);
  });
});

/**
 * The db side of the two properties the memory store has to mirror.
 *
 * Memory mode has no transaction, so it reaches the same end states by refusing a batch before it
 * writes anything (`prepareEventBatch`). These are what it is mirroring: Postgres rolls the mutation
 * back with the event insert, and one statement carries per-event substitutions without them
 * bleeding into each other.
 */
describe("db parity for the prepared-events machinery", () => {
  /**
   * **The rollback the memory preflight exists to reproduce.**
   *
   * The event insert rides the mutation's own statement, so a duplicate `idem_key` raises 23505 and
   * takes the post with it. Memory mode used to leave the post behind, because its idempotency check
   * ran inside the append rather than before the mutation; the gate for that is
   * `src/__tests__/lib/store/events/memory-preflight.test.ts`, and this is the behavior it matches.
   */
  it("rolls the mutation back when the event insert violates the idempotency index", async () => {
    const author = await seedAgent();
    const group = await seedGroup(author.id);
    const idemKey = nextId("idem");
    const postId = nextId("post");

    const decisive = `
      INSERT INTO posts (id, title, content, url, author_id, group_id, upvotes, downvotes, comment_count, created_at)
      SELECT $1::text, 'doomed by its event', NULL, NULL, $2::text, $3::text, 0, 0, 0, NOW()
      RETURNING id
    `;
    const event: PreparedEvent = {
      kind: "post.created",
      actorAgentId: author.id,
      subjectType: "post",
      subjectId: postId,
      idemKey,
      payload: { post_id: postId, group_id: group, author_id: author.id },
    };

    // First write: post and event both land.
    await runCoupledMutation({ decisiveSql: decisive, decisiveParams: [postId, author.id, group], event });
    expect((await pgPool().query(`SELECT 1 FROM posts WHERE id = $1`, [postId])).rows).toHaveLength(1);

    // Second write, same idem key, a DIFFERENT post. The event insert raises 23505 and the post
    // never exists — which is exactly what the memory preflight has to reproduce without a
    // transaction, by refusing before the mutation.
    const secondPostId = nextId("post");
    await expect(
      runCoupledMutation({
        decisiveSql: decisive,
        decisiveParams: [secondPostId, author.id, group],
        event: { ...event, subjectId: secondPostId, payload: { ...event.payload, post_id: secondPostId } },
      })
    ).rejects.toMatchObject({ code: "23505" });

    expect((await pgPool().query(`SELECT 1 FROM posts WHERE id = $1`, [secondPostId])).rows).toEqual([]);
  });

  /**
   * **The refusal the memory store had to be re-ordered to match.**
   *
   * The event insert is gated on the cooldown claim's CTE, so a retry inside the window inserts no
   * post and no event — the duplicate `idem_key` never reaches `idx_events_idem`, and the caller
   * gets the `null` that produces its 429. Memory mode preflighted uniqueness *before* the cooldown
   * and therefore threw 23505 on the ordinary shape of a client retry; the twin of this test is
   * `src/__tests__/lib/store/events/memory-preflight.test.ts`.
   */
  it("answers null rather than 23505 when the cooldown refuses a retry reusing an idem key", async () => {
    const author = await seedAgent();
    const group = await seedGroup(author.id);
    await clearRateWindow(author.id);
    const idemKey = nextId("idem");
    const withKey = (): PreparedEvent[] => [
      {
        kind: "post.created",
        actorAgentId: author.id,
        subjectType: "post",
        subjectId: STORE_ASSIGNED_PAYLOAD_ID,
        idemKey,
        payload: { post_id: STORE_ASSIGNED_PAYLOAD_ID, group_id: group, author_id: author.id },
      },
    ];

    expect(await createPostRow(author.id, group, withKey())).not.toBeNull();
    const marker = await maxEventId();

    await expect(createPostRow(author.id, group, withKey())).resolves.toBeNull();
    expect(await eventsSince(marker)).toEqual([]);
    expect(await countPostsBy(author.id)).toBe(1);

    // Uniqueness is not weakened by the gate: once the window admits the insert, the duplicate key
    // raises 23505 and takes the post with it — which is the state memory mode reproduces by
    // refusing before it writes.
    await clearRateWindow(author.id);
    await expect(createPostRow(author.id, group, withKey())).rejects.toMatchObject({ code: "23505" });
    expect(await countPostsBy(author.id)).toBe(1);
  });

  /**
   * A primary event and one differently-subjected derived event, through ONE statement.
   *
   * This is the shape per-event substitution exists for: a single set applied to the whole list would
   * hand the derived event the primary's `subject_id`, and P1.2's mention fan-out would point every
   * derived event at the comment instead of at its own mention target. The memory twin of this
   * assertion is in `memory-preflight.test.ts`; both stores must keep each event's own subject.
   */
  it("keeps each event's own subject when a primary and a derived event share one statement", async () => {
    const author = await seedAgent();
    const group = await seedGroup(author.id);
    const postId = nextId("post");
    const derivedSubject = nextId("derived");
    const marker = await maxEventId();

    // $1 post id, $2 author, $3 group, $4 the derived event's own subject.
    const params: unknown[] = [postId, author.id, group, derivedSubject];
    const blank = (subjectId: string): PreparedEvent => ({
      kind: "post.created",
      actorAgentId: author.id,
      subjectType: "post",
      // Store-assigned on both, so only the per-event substitution can tell them apart.
      subjectId: STORE_ASSIGNED_PAYLOAD_ID,
      payload: { post_id: subjectId, group_id: group, author_id: author.id },
    });
    const emitted = emitEventCtes([blank(postId), blank(derivedSubject)], "p", {
      firstParamIndex: params.length + 1,
      overrides: [
        { columnSql: { subject_id: sqlParam(1, "text") } },
        { columnSql: { subject_id: sqlParam(4, "text") } },
      ],
    });

    await neonSql()(
      `
      WITH p AS (
        INSERT INTO posts (id, title, content, url, author_id, group_id, upvotes, downvotes, comment_count, created_at)
        SELECT $1::text, 'primary and derived', NULL, NULL, $2::text, $3::text, 0, 0, 0, NOW()
        RETURNING id
      ), ${emitted.ctes.join(", ")}
      SELECT id FROM p
    `,
      [...params, ...emitted.params]
    );

    const appended = await eventsSince(marker);
    expect(appended).toHaveLength(2);
    // **Asserted as a set, deliberately.** Postgres does not specify the order in which sibling
    // data-modifying CTEs execute, so `ev_0` and `ev_1` may take their sequence ids either way
    // round — a caller must not read `ev_0` as "the lower id". What IS guaranteed is that each event
    // kept its own subject: a single substitution over the whole list would print the post id twice
    // and the derived event would name a row it is not about.
    const pairs = appended
      .map((event) => `${event.subjectId}|${(event.payload as { post_id: string }).post_id}`)
      .sort();
    expect(pairs).toEqual([`${postId}|${postId}`, `${derivedSubject}|${derivedSubject}`].sort());
  });
});

/**
 * The per-row derived-event shape, EXECUTED.
 *
 * `sqlColumn` used to render a qualified reference into a `SELECT` with no `FROM` at all — SQL that
 * type-checks, reads plausibly, and raises `42P01` the first time P1.2 ran it. `rowSource` is the
 * minimal fix, and the only proof that counts is a statement Postgres actually accepts: text
 * assertions would have passed against the broken shape too.
 *
 * `post.pinned` stands in for `agent.mentioned`, which enters the kind union at b2 — the machinery is
 * what is under test, not the kind.
 */
describe("a per-row fan-out through one statement, executed", () => {
  it("emits one event per row source row, each carrying its own subject", async () => {
    const author = await seedAgent();
    const group = await seedGroup(author.id);
    const postId = nextId("post");
    const targets = [nextId("target"), nextId("target"), nextId("target")].sort();
    const marker = await maxEventId();

    // $1 post id, $2 author, $3 group, $4..$6 the fan-out's own rows.
    const params: unknown[] = [postId, author.id, group, ...targets];
    const derived: PreparedEvent = {
      kind: "post.pinned",
      actorAgentId: author.id,
      subjectType: "post",
      // Store-assigned on the event: only the per-row column substitution can fill it.
      subjectId: STORE_ASSIGNED_PAYLOAD_ID,
      payload: { post_id: postId, group_id: group },
    };
    const emitted = emitEventCtes([derived], "p", {
      firstParamIndex: params.length + 1,
      overrides: [
        {
          rowSource: "fanout",
          columnSql: {
            subject_id: sqlColumn("fanout.target_id"),
            secondary_subject_id: sqlColumn("target_id"),
          },
        },
      ],
    });

    await neonSql()(
      `
      WITH p AS (
        INSERT INTO posts (id, title, content, url, author_id, group_id, upvotes, downvotes, comment_count, created_at)
        SELECT $1::text, 'per-row fan-out', NULL, NULL, $2::text, $3::text, 0, 0, 0, NOW()
        RETURNING id
      ), fanout AS (
        SELECT * FROM (VALUES ($4::text), ($5::text), ($6::text)) AS t(target_id)
      ), ${emitted.ctes.join(", ")}
      SELECT id FROM p
    `,
      [...params, ...emitted.params]
    );

    const appended = await eventsSince(marker);
    expect(appended).toHaveLength(3);
    // One event per row, each with ITS OWN subject — the property a constant could not express, and
    // the shape `sqlColumn` exists for.
    expect(appended.map((event) => event.subjectId).sort()).toEqual(targets);
    // A bare reference resolves against the same row source as a qualified one.
    expect(appended.map((event) => event.secondarySubjectId).sort()).toEqual(targets);
    // Every row still carries the constants the action decided.
    for (const event of appended) {
      expect(event.kind).toBe("post.pinned");
      expect(event.payload).toEqual({ post_id: postId, group_id: group });
    }
  });

  /** The gate survives the fan-out: a decisive mutation raced to zero rows emits none of the rows. */
  it("emits nothing at all when the decisive mutation matches no rows", async () => {
    const author = await seedAgent();
    const group = await seedGroup(author.id);
    const marker = await maxEventId();
    const params: unknown[] = [nextId("post"), author.id, group, nextId("target"), nextId("target")];
    const derived: PreparedEvent = {
      kind: "post.pinned",
      actorAgentId: author.id,
      subjectType: "post",
      subjectId: STORE_ASSIGNED_PAYLOAD_ID,
      payload: { post_id: "never", group_id: group },
    };
    const emitted = emitEventCtes([derived], "p", {
      firstParamIndex: params.length + 1,
      overrides: [{ rowSource: "fanout", columnSql: { subject_id: sqlColumn("fanout.target_id") } }],
    });

    await neonSql()(
      `
      WITH p AS (
        INSERT INTO posts (id, title, content, url, author_id, group_id, upvotes, downvotes, comment_count, created_at)
        SELECT $1::text, 'never lands', NULL, NULL, $2::text, $3::text, 0, 0, 0, NOW()
        WHERE false
        RETURNING id
      ), fanout AS (
        SELECT * FROM (VALUES ($4::text), ($5::text)) AS t(target_id)
      ), ${emitted.ctes.join(", ")}
      SELECT id FROM p
    `,
      [...params, ...emitted.params]
    );

    expect(await eventsSince(marker)).toEqual([]);
  });
});

/**
 * `events.school_id`, through the repo's canonical derivation.
 *
 * `groups.school_id` is NULL on every group created before per-school scoping existed, and Foundation
 * owns those — `groupSchoolId` centralises that so the NULL case cannot be read as "no school". An
 * event stamped straight from the column would record the platform's oldest groups as belonging to no
 * school at all, permanently, in the log that is supposed to be authoritative history.
 */
describe("school_id is the canonical school, not the raw column", () => {
  /** A group whose `school_id` is NULL — the legacy Foundation shape. */
  async function seedLegacyGroup(ownerId: string): Promise<string> {
    const id = nextId("group");
    await pgPool().query(
      `INSERT INTO groups (id, name, display_name, description, owner_id, member_ids, moderator_ids,
                           pinned_post_ids, school_id, created_at)
       VALUES ($1, $1, $1, '', $2, $3::jsonb, '[]'::jsonb, '[]'::jsonb, NULL, NOW())`,
      [id, ownerId, JSON.stringify([ownerId])]
    );
    await pgPool().query(
      `INSERT INTO group_members (agent_id, group_id, joined_at) VALUES ($1, $2, NOW())
       ON CONFLICT DO NOTHING`,
      [ownerId, id]
    );
    return id;
  }

  it("stamps foundation on all four post kinds for a legacy null-school group", async () => {
    const author = await seedAgent();
    const group = await seedLegacyGroup(author.id);
    const { rows: legacy } = await pgPool().query<{ school_id: string | null }>(
      `SELECT school_id FROM groups WHERE id = $1`,
      [group]
    );
    // The fixture is only meaningful while the column really is NULL.
    expect(legacy[0].school_id).toBeNull();

    await clearRateWindow(author.id);
    const marker = await maxEventId();
    const created = await createPost({ agent: author, groupName: group, title: "legacy", content: LONG_BODY });
    const postId = created.ok ? created.data.post.id : "";
    expect((await pinPost({ agent: author, postId })).ok).toBe(true);
    expect((await unpinPost({ agent: author, postId })).ok).toBe(true);
    expect((await deletePost({ agent: author, postId })).ok).toBe(true);

    const appended = await eventsSince(marker);
    expect(appended.map((event) => event.kind)).toEqual([
      "post.created",
      "post.pinned",
      "post.unpinned",
      "post.deleted",
    ]);
    for (const event of appended) expect(event.schoolId).toBe("foundation");
  });

  it("stamps the group's own school when it has one", async () => {
    const author = await seedAgent();
    const group = await seedGroup(author.id);
    // `groups.school_id` is an FK, so the school has to exist before a group can claim it.
    const schoolId = nextId("school");
    await pgPool().query(
      `INSERT INTO schools (id, name, description, subdomain, status, access)
       VALUES ($1, $1, '', $1, 'active', 'admitted')`,
      [schoolId]
    );
    await pgPool().query(`UPDATE groups SET school_id = $2 WHERE id = $1`, [group, schoolId]);
    // Admission is what the non-Foundation rule requires; the school stamp is what is under test.
    const admitted = { ...author, isAdmitted: true } as StoredAgent;

    await clearRateWindow(author.id);
    const marker = await maxEventId();
    const created = await createPost({ agent: admitted, groupName: group, title: "ao", content: LONG_BODY });
    expect(created.ok).toBe(true);

    const [event] = await eventsSince(marker);
    expect(event.schoolId).toBe(schoolId);
  });
});

/**
 * Store-assigned substitution is POSITIONAL in the db store, and this is the half the memory twin
 * has to match.
 *
 * `emitEventCtes` applies `overrides[0]` to `events[0]` and leaves every later event alone, whatever
 * kind it is. Two events of the SAME kind is the only fixture that can tell that apart from a
 * kind-keyed rule — with two different kinds both implementations agree by accident. The memory half
 * is `src/__tests__/lib/store/events/memory-preflight.test.ts`.
 */
describe("db store-assigned fields land on the positional primary only", () => {
  it("createPost fills the first post.created and leaves a second one untouched", async () => {
    const author = await seedAgent();
    const group = await seedGroup(author.id);
    await clearRateWindow(author.id);
    const marker = await maxEventId();

    const derivedSubject = nextId("derived");
    const secondary: PreparedEvent = {
      kind: "post.created",
      actorAgentId: author.id,
      subjectType: "post",
      subjectId: derivedSubject,
      payload: { post_id: derivedSubject, group_id: group, author_id: author.id },
    };
    const created = await createPostRow(author.id, group, [
      {
        kind: "post.created",
        actorAgentId: author.id,
        subjectType: "post",
        subjectId: STORE_ASSIGNED_PAYLOAD_ID,
        payload: { post_id: STORE_ASSIGNED_PAYLOAD_ID, group_id: group, author_id: author.id },
      },
      secondary,
    ]);
    expect(created).not.toBeNull();

    // Identified by SUBJECT, never by id order: sibling data-modifying CTEs execute in an order
    // Postgres does not specify, so `ev_0` is not reliably the lower id.
    const appended = await eventsSince(marker);
    expect(appended).toHaveLength(2);
    const primary = appended.find((event) => event.subjectId === created)!;
    const derived = appended.find((event) => event.subjectId === derivedSubject)!;

    // The primary took the minted id, in the column and in the payload.
    expect(primary).toBeDefined();
    expect((primary.payload as { post_id: string }).post_id).toBe(created);
    // The second event kept ITS OWN subject — a kind-keyed substitution would have overwritten both.
    expect(derived).toBeDefined();
    expect((derived.payload as { post_id: string }).post_id).toBe(derivedSubject);
  });

  it("deletePost fills the first post.deleted and leaves a second one untouched", async () => {
    const author = await seedAgent();
    const group = await seedGroup(author.id);
    await clearRateWindow(author.id);
    const created = await createPost({ agent: author, groupName: group, title: "two deletes", content: LONG_BODY });
    const post = created.ok ? created.data.post : null;
    const marker = await maxEventId();

    const deletedEvent = (subject: string, lists: string[]): PreparedEvent => ({
      kind: "post.deleted",
      actorAgentId: author.id,
      subjectType: "post",
      subjectId: subject,
      payload: {
        post_id: post!.id,
        group_id: group,
        author_id: author.id,
        comment_ids: lists,
        commenter_ids: lists,
        audience_agent_ids: lists,
      },
    });
    const kept = nextId("kept");
    const result = await storeDeletePost(post!.id, author.id, [
      deletedEvent("primary", [STORE_ASSIGNED_PAYLOAD_ID]),
      deletedEvent("derived", [kept]),
    ]);
    expect(result.deleted).toBe(true);

    // By SUBJECT again — the delete override touches only the payload, so both subjects survive and
    // are what tells the two events apart whatever order their ids landed in.
    const appended = await eventsSince(marker);
    expect(appended).toHaveLength(2);
    const primary = appended.find((event) => event.subjectId === "primary")!;
    const derived = appended.find((event) => event.subjectId === "derived")!;

    // The primary's three lists were replaced by what the deleting batch actually saw.
    expect((primary.payload as { audience_agent_ids: string[] }).audience_agent_ids).toEqual([author.id]);
    expect((primary.payload as { commenter_ids: string[] }).commenter_ids).toEqual([]);
    expect((primary.payload as { comment_ids: string[] }).comment_ids).toEqual([]);
    // The second event kept its own lists, untouched.
    expect((derived.payload as { audience_agent_ids: string[] }).audience_agent_ids).toEqual([kept]);
    expect((derived.payload as { commenter_ids: string[] }).commenter_ids).toEqual([kept]);
  });
});
