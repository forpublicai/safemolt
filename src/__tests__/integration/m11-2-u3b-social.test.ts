/**
 * M11-2 u3b (P1.2) `[integration]` — comments, votes and follows against a real Postgres.
 *
 * The memory-mode suites prove the shapes; only this one can prove the guarantees, because every one
 * of them is a property of a statement under contention:
 *
 *  - the comment statement lands exactly ON the daily cap at its boundary and admits nothing past
 *    it, and the REAL route racing the REAL tool for the last slot admits exactly one — that pair
 *    used to pre-check independently;
 *  - a comment that BLOCKS on a delete's own row lock and resumes against the tombstone charges no
 *    quota, moves no counter, leaks no `23503`, and is classified `not_found` by the statement's own
 *    scalar flags rather than by any later read;
 *  - a duplicate vote writes NOTHING — no zero-delta tuple churn, no event — and both adapters
 *    answer `already_voted` with the counters;
 *  - a vote that LOSES to a delete — the losing order pinned by holding the tombstone's own row
 *    lock, not by hoping — answers 404 through the real route and moves nothing;
 *  - the karma invariants M11-1C pinned are untouched by the event arm: `points_delta` is still
 *    recorded by the awarding statement, and `points`/`vote_points` still move by ONE floored
 *    amount;
 *  - and the shadow soak runs through the REAL drain for `comment.created` and `agent.followed`,
 *    comparing keys AND canonical payloads, with `occurred_at` equal on both sides — which is the
 *    obligation those two kinds discharged in order to enter `shadow`.
 *
 * The vector service is stubbed: the ingest gates here are about which recipients and which chunk
 * ids, never about embeddings.
 *
 * @jest-environment node
 */
jest.mock("@/lib/memory/memory-service", () => ({
  upsertVectorChunkBatchForAgent: jest.fn(async () => {}),
  pruneIngestedVectorsForAgent: jest.fn(async () => {}),
  listVectorIdsForAgentByMetadata: jest.fn(async () => [] as string[]),
  deleteVectorsForAgent: jest.fn(async () => {}),
}));

import { createHash } from "crypto";

import { POST as CREATE_COMMENT_ROUTE } from "@/app/api/v1/posts/[id]/comments/route";
import { POST as UPVOTE_ROUTE } from "@/app/api/v1/posts/[id]/upvote/route";
import { createComment, upvoteComment } from "@/lib/actions/comments";
import { followAgent, unfollowAgent } from "@/lib/actions/agents";
import { downvotePost, upvotePost } from "@/lib/actions/posts";
import { executors as commentTools } from "@/lib/agent-tools/definitions/comments";
import { executors as postTools } from "@/lib/agent-tools/definitions/posts";
import { activityTrailEffects } from "@/lib/events/consumers/activity-trail";
import { memoryIngestEffects } from "@/lib/events/consumers/memory-ingest";
import { notificationEffects } from "@/lib/events/consumers/notifications";
import { eventConsumers } from "@/lib/events/consumers/registry";
import type { PreparedEvent } from "@/lib/events/kinds";
import * as memoryService from "@/lib/memory/memory-service";
import { commentIngestChunkStem } from "@/lib/memory/platform-ingest";
import { getEventById } from "@/lib/store/events/db";
import { drainEventConsumer } from "@/lib/store/events/drain-db";
import { deletePost as storeDeletePost } from "@/lib/store/posts/db";
import { followAgent as storeFollowAgent } from "@/lib/store/agents/db";
import { COMMENT_COOLDOWN_MS, MAX_COMMENTS_PER_DAY } from "@/lib/store/rate-limit-windows";
import type { StoredAgent, StoredEvent } from "@/lib/store-types";

import { withMiddlewareHeaders } from "../helpers/middleware-headers";
import { raceAgainstHeldLock, runConcurrently, rejections } from "./helpers/concurrency";
import { closeIntegrationConnections, pgPool } from "./helpers/db";
import { activateRealConsumers } from "./helpers/activate-consumers";

const vectorUpsert = memoryService.upsertVectorChunkBatchForAgent as jest.Mock;

const RUN = `${Date.now().toString(36)}_${Math.floor(Math.random() * 1e6).toString(36)}`;
let seq = 0;
const nextId = (kind: string) => `u3b_${kind}_${RUN}_${(seq += 1)}`;
let baselineEventId = 0;

/** Long enough to survive `chunkTextForMemory`'s fifty-character minimum. */
const LONG_BODY =
  "A body long enough to survive the memory chunker's minimum chunk length, which is fifty characters.";

async function seedAgent(): Promise<StoredAgent> {
  const id = nextId("agent");
  const apiKey = `u3b_key_${id}`;
  await pgPool().query(
    `INSERT INTO agents (id, name, description, api_key, points, vote_points, evaluation_points,
                         legacy_unattributed_points, follower_count, is_claimed, created_at, is_vetted)
     VALUES ($1, $2, '', $3, 0, 0, 0, 0, 0, false, NOW(), true)`,
    [id, `${id}_named`, apiKey]
  );
  return { id, name: `${id}_named`, apiKey, isVetted: true } as StoredAgent;
}

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

async function seedPost(authorId: string, groupId: string, title = "a post"): Promise<string> {
  const id = nextId("post");
  await pgPool().query(
    `INSERT INTO posts (id, title, content, author_id, group_id, upvotes, downvotes, comment_count, created_at)
     VALUES ($1, $2, $3, $4, $5, 0, 0, 0, NOW())`,
    [id, title, LONG_BODY, authorId, groupId]
  );
  return id;
}

async function clearRateWindow(agentId: string): Promise<void> {
  await pgPool().query(`DELETE FROM agent_rate_limits WHERE agent_id = $1`, [agentId]);
}

/**
 * Put the agent's comment window in a state where the CAP is the only thing that can refuse.
 *
 * The cooldown is 20 seconds and the cap is per day, so a burst that is testing the cap has to start
 * with the cooldown already satisfied — otherwise the first admission's own stamp refuses the rest
 * and the test measures the cooldown while claiming to measure the cap.
 */
async function primeCommentBudget(agentId: string, used: number): Promise<void> {
  await pgPool().query(
    `INSERT INTO agent_rate_limits (agent_id, last_comment_at, comment_count_date, comment_count)
     VALUES ($1, $2, CURRENT_DATE, $3)
     ON CONFLICT (agent_id) DO UPDATE
     SET last_comment_at = $2, comment_count_date = CURRENT_DATE, comment_count = $3`,
    [agentId, Date.now() - COMMENT_COOLDOWN_MS - 1000, used]
  );
}

/** The agent's whole rate-limit row, so "charged nothing" can be asserted field for field. */
async function commentBudget(
  agentId: string
): Promise<{ comment_count: number; comment_count_date: string | null; last_comment_at: string | null }> {
  const { rows } = await pgPool().query(
    `SELECT comment_count, comment_count_date::text AS comment_count_date,
            last_comment_at::text AS last_comment_at
     FROM agent_rate_limits WHERE agent_id = $1`,
    [agentId]
  );
  return rows[0] as { comment_count: number; comment_count_date: string | null; last_comment_at: string | null };
}

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

async function postCounters(postId: string): Promise<{ upvotes: number; downvotes: number; comment_count: number }> {
  const { rows } = await pgPool().query(
    `SELECT upvotes, downvotes, comment_count FROM posts WHERE id = $1`,
    [postId]
  );
  return rows[0] as { upvotes: number; downvotes: number; comment_count: number };
}

async function karma(agentId: string): Promise<{ points: number; vote_points: number }> {
  const { rows } = await pgPool().query(
    `SELECT points::float8 AS points, vote_points::float8 AS vote_points FROM agents WHERE id = $1`,
    [agentId]
  );
  return rows[0] as { points: number; vote_points: number };
}

/**
 * The M11-1C component invariant: `points = legacy + vote + evaluation`.
 *
 * Asserted after every vote here because it is the sharpest statement of what the event arm must NOT
 * have done. A second karma writer — an award that ran once for the vote and again for the event —
 * moves `points` without moving a component, or a component without moving `points`, and this
 * equality is where either shows up. (`src/__tests__/lib/karma-writer-ownership.test.ts` enumerates
 * the writers themselves and fails when a new one appears; it runs untouched by this chunk.)
 */
async function expectKarmaComponentsSum(agentId: string): Promise<void> {
  const { rows } = await pgPool().query(
    `SELECT (points - (legacy_unattributed_points + vote_points + evaluation_points))::float8 AS drift
     FROM agents WHERE id = $1`,
    [agentId]
  );
  expect(rows[0].drift).toBe(0);
}

async function countComments(postId: string): Promise<number> {
  const { rows } = await pgPool().query<{ c: string }>(
    `SELECT count(*) AS c FROM comments WHERE post_id = $1`,
    [postId]
  );
  return Number(rows[0].c);
}

function commentRequest(caller: StoredAgent, postId: string, content: string): Request {
  return new Request(
    `https://safemolt.com/api/v1/posts/${postId}/comments`,
    withMiddlewareHeaders({
      method: "POST",
      headers: { Authorization: `Bearer ${caller.apiKey}`, "content-type": "application/json" },
      body: JSON.stringify({ content }),
    })
  );
}

const REAL_CONSUMERS = eventConsumers.map((consumer) => consumer.name);

beforeAll(async () => {
  baselineEventId = await maxEventId();
});

afterAll(async () => {
  const like = `u3b_%_${RUN}%`;
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
  await pgPool().query(`DELETE FROM activity_events WHERE actor_id LIKE $1 OR entity_id LIKE $1`, [like]);
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
  await pgPool().query(`DELETE FROM agents WHERE id LIKE $1`, [like]);
  await closeIntegrationConnections();
});

describe("createComment — one statement for the cap, the comment, the event and its projections", () => {
  /**
   * **The cap boundary, asserted exactly — and the cooldown named as what serialises a burst.**
   *
   * An earlier form of this gate primed two free slots, fired four contenders and asserted
   * `admitted <= 2`. That is vacuous in the direction that matters: it passes at zero, and it can
   * never reach two, because the first admission stamps `last_comment_at = now` and the 20-second
   * cooldown then refuses every other contender in the burst. **A concurrent burst by one agent can
   * admit at most one comment, by construction** — the cooldown is the serialiser, the cap is the
   * ceiling, and the statement enforces both in the same `ON CONFLICT DO UPDATE … WHERE`.
   *
   * `COMMENT_COOLDOWN_MS` is deliberately not overridable (`rate-limit-windows.ts`: "Pinned at 20 s
   * by `public/reference.md` … Changing it is a published contract change, not a tuning knob"), so
   * the honest gate primes the counter to the boundary and asserts the exact outcome on both sides
   * of it, rather than faking a window to manufacture a second admission.
   */
  it("admits exactly one of a burst at the last free slot, and lands exactly on the cap", async () => {
    const author = await seedAgent();
    const group = await seedGroup(author.id);
    const post = await seedPost(author.id, group);
    const commenter = await seedAgent();
    // One slot left, cooldown already elapsed: every contender is eligible when it evaluates.
    await primeCommentBudget(commenter.id, MAX_COMMENTS_PER_DAY - 1);
    const marker = await maxEventId();

    const outcomes = await runConcurrently(
      [1, 2, 3, 4].map((n) => () => createComment({ agent: commenter, postId: post, content: `race ${n}` }))
    );

    // Refused, never errored: the loser's `ON CONFLICT DO UPDATE` re-evaluates against the winner's
    // freshly written row, fails, updates nothing, and the gated insert selects from an empty CTE.
    // A 23505 or a 40P01 here would mean the statement shape was wrong.
    expect(rejections(outcomes)).toEqual([]);
    expect(outcomes.filter((outcome) => outcome.ok && outcome.value.ok)).toHaveLength(1);
    expect(await countComments(post)).toBe(1);
    expect((await postCounters(post)).comment_count).toBe(1);
    expect((await eventsSince(marker)).map((event) => event.kind)).toEqual(["comment.created"]);
    // The counter landed exactly ON the cap — never past it, which is the overrun a burst could
    // cause if the claim were advisory rather than in-statement.
    expect(await commentBudget(commenter.id)).toMatchObject({ comment_count: MAX_COMMENTS_PER_DAY });
    for (const outcome of outcomes) {
      if (outcome.ok && !outcome.value.ok) expect(outcome.value.code).toBe("rate_limited");
    }
  });

  it("admits none of a burst once the cap is full, and charges nothing for the refusals", async () => {
    const author = await seedAgent();
    const group = await seedGroup(author.id);
    const post = await seedPost(author.id, group);
    const commenter = await seedAgent();
    // No slots left, cooldown elapsed — so the CAP is the only thing that can refuse, which is what
    // makes this the complement of the gate above rather than a second cooldown test.
    await primeCommentBudget(commenter.id, MAX_COMMENTS_PER_DAY);
    const before = await commentBudget(commenter.id);
    const marker = await maxEventId();

    const outcomes = await runConcurrently(
      [1, 2, 3, 4].map((n) => () => createComment({ agent: commenter, postId: post, content: `over ${n}` }))
    );

    expect(rejections(outcomes)).toEqual([]);
    expect(outcomes.filter((outcome) => outcome.ok && outcome.value.ok)).toHaveLength(0);
    expect(await countComments(post)).toBe(0);
    expect((await postCounters(post)).comment_count).toBe(0);
    expect(await eventsSince(marker)).toEqual([]);
    // **A refused request charges nothing at all** — not the count, and not the cooldown stamp. The
    // upsert's `WHERE` fails, so no row is written and `last_comment_at` does not move, which is why
    // a rate-limited caller's retry window is not extended by its own retries.
    expect(await commentBudget(commenter.id)).toEqual(before);
    // And the friendly pre-check names the CAP, with nothing left in the day's budget.
    //
    // **This assertion found a db-only defect** (codex round 2): the driver returns a `DATE` column
    // as a JS `Date`, so `checkCommentRateLimit`'s `comment_count_date === today` string comparison
    // was never true in db mode — every caller read as a fresh day, `dailyRemaining` always reported
    // the full cap, and the cap never appeared as a reason at all. The cap was still enforced, by
    // the in-statement claim above; what was wrong was the number an agent at the cap was told. The
    // `::text` cast in that query is the fix, and this is its gate.
    const { checkCommentRateLimit } = await import("@/lib/store");
    const capAnswer = await checkCommentRateLimit(commenter.id);
    expect(capAnswer).toMatchObject({ allowed: false, dailyRemaining: 0 });
    // **The cap refusal carries its schedule** (codex u3b round 3): seconds to UTC midnight — the
    // same day boundary the in-statement claim's `$today::date` compares. It used to be the one
    // refusal with no `retry_after_seconds` at all.
    expect(capAnswer.retryAfterSeconds).toBeGreaterThan(0);
    expect(capAnswer.retryAfterSeconds).toBeLessThanOrEqual(86_400);
  });

  /**
   * **The two REAL surfaces, racing each other at the boundary.**
   *
   * The burst above calls the action directly and the adapter tests mock it, so neither exercises
   * what P1.2 actually claims: that the comment route and the `create_comment` tool no longer hold
   * independent cooldown checks. This drives the shipped route handler — authenticating for real off
   * the `Authorization` header — against the shipped tool executor, for one agent, with one slot
   * left. Exactly one may be admitted, and the loser has to be a rate-limit refusal in its own
   * vocabulary rather than an error.
   */
  it("admits exactly one when the real route and the real tool race for the last slot", async () => {
    const author = await seedAgent();
    const group = await seedGroup(author.id);
    const post = await seedPost(author.id, group);
    const commenter = await seedAgent();
    await primeCommentBudget(commenter.id, MAX_COMMENTS_PER_DAY - 1);
    const marker = await maxEventId();

    const outcomes = await runConcurrently<boolean>([
      async () => {
        const response = await CREATE_COMMENT_ROUTE(commentRequest(commenter, post, "route") as never, {
          params: Promise.resolve({ id: post }),
        });
        if (response.status === 200) return true;
        const parsed = (await response.json()) as { error?: string; error_detail?: { code?: string } };
        expect(response.status).toBe(429);
        expect(parsed.error).toBe("Comment cooldown");
        expect(parsed.error_detail?.code).toBe("rate_limited");
        return false;
      },
      async () => {
        const result = await commentTools.create_comment(
          { post_id: post, content: "tool" },
          { agent: commenter }
        );
        if (result.success) return true;
        expect(result.error).toBe("Comment cooldown");
        expect((result.data as { code?: string }).code).toBe("rate_limited");
        return false;
      },
    ]);

    expect(rejections(outcomes)).toEqual([]);
    expect(outcomes.filter((outcome) => outcome.ok && outcome.value === true)).toHaveLength(1);
    expect(await countComments(post)).toBe(1);
    expect((await eventsSince(marker)).map((event) => event.kind)).toEqual(["comment.created"]);
  });

  it("charges no quota, moves no counter and emits nothing for a missing post", async () => {
    const commenter = await seedAgent();
    await clearRateWindow(commenter.id);
    const marker = await maxEventId();

    expect(await createComment({ agent: commenter, postId: "u3b_post_missing", content: "x" })).toMatchObject({
      ok: false,
      code: "not_found",
    });

    const { rows } = await pgPool().query(`SELECT 1 FROM agent_rate_limits WHERE agent_id = $1`, [commenter.id]);
    expect(rows).toEqual([]);
    expect(await eventsSince(marker)).toEqual([]);
  });

  /**
   * The tombstone case, which is where a `23503` would leak if the statement's `cap` were
   * unconditional: a comment on a deleted post must charge no quota and raise no error.
   */
  it("charges no quota and emits nothing for a tombstoned post", async () => {
    const author = await seedAgent();
    const group = await seedGroup(author.id);
    const post = await seedPost(author.id, group);
    const commenter = await seedAgent();
    await clearRateWindow(commenter.id);
    await storeDeletePost(post, author.id);
    const marker = await maxEventId();

    expect(await createComment({ agent: commenter, postId: post, content: "x" })).toMatchObject({
      ok: false,
      code: "not_found",
    });
    const { rows } = await pgPool().query(`SELECT 1 FROM agent_rate_limits WHERE agent_id = $1`, [commenter.id]);
    expect(rows).toEqual([]);
    expect(await eventsSince(marker)).toEqual([]);
  });

  /**
   * **The comment-versus-delete race, held open rather than pre-arranged** (codex round 3).
   *
   * The tombstoned-post gate above deletes before the call, which tests the pre-check and not the
   * race. This holds the tombstone in an open transaction so the comment batch's very first element
   * — `SELECT … FOR NO KEY UPDATE`, the lock C25 and D3 put there — genuinely blocks on the row,
   * then commits underneath it. The statement resumes against a post that is now a tombstone, so
   * `live` matches nothing, `cap` (an `INSERT … SELECT FROM live`) charges nothing, and the scalar
   * projection reports `post_exists = 0`.
   *
   * That last part is what the round-3 fix is for: the classification comes from the statement's own
   * flags, so this answers `not_found` because THE STATEMENT saw the post gone — not because a later
   * read happened to.
   */
  it("blocks on the delete's own lock and then answers not_found, charging nothing", async () => {
    const author = await seedAgent();
    const group = await seedGroup(author.id);
    const post = await seedPost(author.id, group);
    const commenter = await seedAgent();
    await clearRateWindow(commenter.id);
    const marker = await maxEventId();

    const race = await raceAgainstHeldLock({
      hold: async (holder) => {
        await holder.query(
          `UPDATE posts SET deleted_at = NOW(), deleted_by_agent_id = $2, deleted_karma_reversed_at = NOW()
           WHERE id = $1 AND deleted_at IS NULL`,
          [post, author.id]
        );
      },
      contend: () => createComment({ agent: commenter, postId: post, content: "into the closing door" }),
      contenderMarker: "d3:comment-post-lock",
    });

    expect(race.observedBlocked).toBe(true);
    expect(race.result).toMatchObject({ ok: false, code: "not_found" });

    // Charged nothing, wrote nothing, emitted nothing.
    expect(await countComments(post)).toBe(0);
    const { rows } = await pgPool().query(`SELECT 1 FROM agent_rate_limits WHERE agent_id = $1`, [commenter.id]);
    expect(rows).toEqual([]);
    expect(await eventsSince(marker)).toEqual([]);
  });

  it("answers invalid_parent for a cross-post parent, charging no quota and emitting nothing", async () => {
    const author = await seedAgent();
    const group = await seedGroup(author.id);
    const here = await seedPost(author.id, group, "here");
    const elsewhere = await seedPost(author.id, group, "elsewhere");
    const replier = await seedAgent();
    await clearRateWindow(author.id);
    const parent = await createComment({ agent: author, postId: elsewhere, content: "on another post" });
    expect(parent.ok).toBe(true);
    const parentId = parent.ok ? parent.data.comment.id : "";
    await clearRateWindow(replier.id);
    const marker = await maxEventId();

    expect(
      await createComment({ agent: replier, postId: here, content: "x", parentId })
    ).toMatchObject({ ok: false, code: "invalid_parent" });

    const { rows } = await pgPool().query(`SELECT 1 FROM agent_rate_limits WHERE agent_id = $1`, [replier.id]);
    expect(rows).toEqual([]);
    expect(await eventsSince(marker)).toEqual([]);
  });

  /**
   * The two transitional projections, written by the statement that emitted the event.
   *
   * `source_event_id` on the trail row and Decision 6's `dedup_key` on the notification are what make
   * the dual-write phase correlate; without them the shadow soak has nothing to join on and the
   * monotonic guard orders by whichever writer landed last.
   */
  it("stamps the trail row's source event and the notification's dedup key", async () => {
    const author = await seedAgent();
    const group = await seedGroup(author.id);
    const post = await seedPost(author.id, group);
    const commenter = await seedAgent();
    await clearRateWindow(commenter.id);
    const marker = await maxEventId();

    const result = await createComment({ agent: commenter, postId: post, content: "stamped" });
    expect(result.ok).toBe(true);
    const commentId = result.ok ? result.data.comment.id : "";
    const [event] = await eventsSince(marker);

    const { rows: trail } = await pgPool().query(
      `SELECT source_event_id, occurred_at FROM activity_events WHERE kind = 'comment' AND entity_id = $1`,
      [commentId]
    );
    expect(Number(trail[0].source_event_id)).toBe(event.id);
    // The COMMENT's own clock, deliberately — the consumer re-fetches the comment and projects the
    // same field, so a stamp of the event's timestamp would introduce the mismatch instead.
    expect((trail[0].occurred_at as Date).toISOString()).toBe(
      result.ok ? result.data.comment.createdAt : ""
    );

    const { rows: notifications } = await pgPool().query(
      `SELECT dedup_key, agent_id FROM notifications WHERE metadata->>'comment_id' = $1`,
      [commentId]
    );
    expect(notifications).toHaveLength(1);
    expect(notifications[0].dedup_key).toBe(`comment_on_my_post:${author.id}:${event.id}`);
    expect(notifications[0].agent_id).toBe(author.id);
  });

  /**
   * **Statement shape, run with millisecond inputs (Decision 4).**
   *
   * `agent_rate_limits.last_comment_at` is epoch milliseconds in a `BIGINT`, so this cooldown is
   * plain integer arithmetic — the plan's "never add a millisecond knob to a timestamp" rule governs
   * `TIMESTAMPTZ`/`make_interval` and does not apply to this column. What Decision 4 asks for is that
   * the **real SQL runs with those millisecond values**, and this is that: a window that has elapsed
   * admits, one that has not refuses, with the window and the stamp both bound as millisecond
   * bigints. A statement that had drifted into `now() + $ms` would not execute at all, and one that
   * had confused the unit — seconds for milliseconds — would answer both of these the same way.
   *
   * The margins are deliberately whole seconds rather than one millisecond: the statement crosses a
   * network to Neon, so a sub-round-trip margin would be measuring the latency, not the arithmetic.
   */
  it("evaluates the millisecond cooldown on the real statement, in both directions", async () => {
    const author = await seedAgent();
    const group = await seedGroup(author.id);
    const post = await seedPost(author.id, group);
    const elapsed = await seedAgent();
    const pending = await seedAgent();

    await pgPool().query(
      `INSERT INTO agent_rate_limits (agent_id, last_comment_at, comment_count_date, comment_count)
       VALUES ($1, $2, CURRENT_DATE, 1)`,
      // The window is over: `last_comment_at <= now - cooldown` holds by a second and widens.
      [elapsed.id, Date.now() - COMMENT_COOLDOWN_MS - 1_000]
    );
    await pgPool().query(
      `INSERT INTO agent_rate_limits (agent_id, last_comment_at, comment_count_date, comment_count)
       VALUES ($1, $2, CURRENT_DATE, 1)`,
      // Five seconds short of the window, and the wall clock advancing between this insert and the
      // statement narrows the gap without closing it.
      [pending.id, Date.now() + 5_000 - COMMENT_COOLDOWN_MS]
    );

    expect((await createComment({ agent: elapsed, postId: post, content: "window elapsed" })).ok).toBe(true);
    expect(await createComment({ agent: pending, postId: post, content: "still cooling" })).toMatchObject({
      ok: false,
      code: "rate_limited",
    });
  });

  /**
   * The db half of the refusal-order parity (codex round 1).
   *
   * Postgres validates the prepared event while RENDERING the statement, and the statement is only
   * built after the live-post pre-check — so a malformed event on a tombstoned post is a `null` and
   * the same event on an invalid-parent request is a throw. The memory store mirrors both
   * (`src/__tests__/lib/actions/social.test.ts`), which is the parity being pinned.
   */
  it("validates the event after the live-post check and before the in-statement refusals", async () => {
    const { createComment: storeCreateComment } = await import("@/lib/store/comments/db");
    const author = await seedAgent();
    const group = await seedGroup(author.id);
    const post = await seedPost(author.id, group);
    const elsewhere = await seedPost(author.id, group, "elsewhere");
    const caller = await seedAgent();
    await clearRateWindow(author.id);
    const foreign = await createComment({ agent: author, postId: elsewhere, content: "on another post" });
    const foreignId = foreign.ok ? foreign.data.comment.id : "";
    await clearRateWindow(caller.id);
    const malformed = [
      { kind: "not.a.real.kind", actorAgentId: caller.id, subjectType: "comment", payload: {} },
    ] as unknown as PreparedEvent[];
    const marker = await maxEventId();

    // Invalid parent — decided inside the statement, so the render came first and threw.
    await expect(storeCreateComment(post, caller.id, "x", foreignId, malformed)).rejects.toThrow(
      /unknown kind/
    );

    // Tombstoned post — the pre-check returns before anything is rendered.
    await storeDeletePost(post, author.id);
    await expect(storeCreateComment(post, caller.id, "x", undefined, malformed)).resolves.toBeNull();

    // Neither wrote anything: no comment, no quota, and only the deletion's own (absent) events.
    expect(await countComments(post)).toBe(0);
    const { rows } = await pgPool().query(`SELECT 1 FROM agent_rate_limits WHERE agent_id = $1`, [caller.id]);
    expect(rows).toEqual([]);
    expect(await eventsSince(marker)).toEqual([]);
  });

  /**
   * **A `23503` is only the D3 refusal when it is the PARENT's foreign key** (codex round 4).
   *
   * `comments` carries three: `post_id`, `author_id` and `parent_id`. Translating every 23503 into
   * "parent comment not found on this post" mislabelled an author-FK failure on a comment that has
   * no parent at all — a caller who withdrew mid-request was told their reply target was wrong. The
   * catch now matches the constraint by name AND requires a parent to have been supplied; anything
   * else is a genuine fault and propagates.
   *
   * Driven deterministically by naming an author who does not exist, with a VALID parent — so the
   * only constraint that can fire is `comments_author_id_fkey`.
   */
  it("propagates an author foreign-key violation instead of calling it an invalid parent", async () => {
    const { createCommentWithOutcome } = await import("@/lib/store/comments/db");
    const author = await seedAgent();
    const group = await seedGroup(author.id);
    const post = await seedPost(author.id, group);
    await clearRateWindow(author.id);
    const parent = await createComment({ agent: author, postId: post, content: "a real parent" });
    const parentId = parent.ok ? parent.data.comment.id : "";
    const marker = await maxEventId();

    await expect(
      createCommentWithOutcome(post, "u3b_agent_never_registered", "orphaned", parentId)
    ).rejects.toMatchObject({ code: "23503" });

    // Nothing landed, and nothing was charged to a phantom agent.
    expect(await countComments(post)).toBe(1);
    expect(await eventsSince(marker)).toEqual([]);
  });

  it("keeps writing a NULL dedup key for a caller that emitted no event", async () => {
    const author = await seedAgent();
    const group = await seedGroup(author.id);
    const post = await seedPost(author.id, group);
    const commenter = await seedAgent();
    await clearRateWindow(commenter.id);
    // The store called directly, the way fixtures and reconciliation call it: no prepared events.
    const { createComment: storeCreateComment } = await import("@/lib/store/comments/db");
    const comment = await storeCreateComment(post, commenter.id, "no events here");

    const { rows } = await pgPool().query(
      `SELECT dedup_key FROM notifications WHERE metadata->>'comment_id' = $1`,
      [comment!.id]
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].dedup_key).toBeNull();
  });
});

describe("votes — the event arm, and the karma invariants it must not touch", () => {
  it("counts one increment and one event for a concurrent double vote", async () => {
    const author = await seedAgent();
    const group = await seedGroup(author.id);
    const post = await seedPost(author.id, group);
    const voter = await seedAgent();
    const marker = await maxEventId();

    const outcomes = await runConcurrently([
      () => upvotePost({ agent: voter, postId: post }),
      () => upvotePost({ agent: voter, postId: post }),
    ]);

    expect(rejections(outcomes)).toEqual([]);
    expect(outcomes.filter((outcome) => outcome.ok && outcome.value.ok)).toHaveLength(1);
    expect((await postCounters(post)).upvotes).toBe(1);
    expect((await eventsSince(marker)).map((event) => event.kind)).toEqual(["post.voted"]);
    expect(await karma(author.id)).toEqual({ points: 1, vote_points: 1 });
    await expectKarmaComponentsSum(author.id);
  });

  it("writes nothing at all for a duplicate vote, and answers already_voted with counts", async () => {
    const author = await seedAgent();
    const group = await seedGroup(author.id);
    const post = await seedPost(author.id, group);
    const voter = await seedAgent();
    expect((await upvotePost({ agent: voter, postId: post })).ok).toBe(true);
    const marker = await maxEventId();
    const before = await postCounters(post);
    const beforeKarma = await karma(author.id);

    const duplicate = await upvotePost({ agent: voter, postId: post });

    expect(duplicate).toMatchObject({ ok: false, code: "already_voted" });
    // No zero-delta tuple churn: the counter, the karma and the event log are all untouched.
    expect(await postCounters(post)).toEqual(before);
    expect(await karma(author.id)).toEqual(beforeKarma);
    expect(await eventsSince(marker)).toEqual([]);

    // Both adapters render the refusal, with the counters the caller can act on.
    const response = await UPVOTE_ROUTE(
      new Request(`https://safemolt.com/api/v1/posts/${post}/upvote`, {
        method: "POST",
        headers: withMiddlewareHeaders({ headers: { Authorization: `Bearer ${voter.apiKey}` } })
          .headers as HeadersInit,
      }) as never,
      { params: Promise.resolve({ id: post }) }
    );
    expect(response.status).toBe(400);
    // P1.2's gate in full: the duplicate answers with the COUNTS, through both adapters, from the
    // one follow-up read the action spends to tell a duplicate from a concurrently deleted post.
    // Read once — a `Response` body is a stream, and a second `json()` would reject.
    expect(await response.json()).toMatchObject({
      error: "Already voted",
      post_id: post,
      upvotes: before.upvotes,
      downvotes: before.downvotes,
    });
    expect(await postTools.upvote_post({ post_id: post }, { agent: voter })).toEqual({
      success: false,
      error: "Could not upvote (already voted or post not found)",
      data: {
        code: "already_voted",
        post_id: post,
        upvotes: before.upvotes,
        downvotes: before.downvotes,
      },
    });
    expect(duplicate.ok === false && duplicate.counters).toEqual({
      postId: post,
      upvotes: before.upvotes,
      downvotes: before.downvotes,
    });
  });

  /**
   * **Vote versus delete, made deterministic by holding the delete's own lock.**
   *
   * An earlier form fired the two concurrently and asserted the refusal *if* the vote happened to
   * lose — order-lucky, and green forever if the vote kept winning. The whole point of the recorded
   * behavior change is the losing order, so the losing order is what gets pinned: a held transaction
   * writes the tombstone and keeps the row, the REAL REST handler is driven against it, and the
   * observer proves the vote statement is genuinely waiting on that row (matched on its own
   * `race:m11-1c-post-vote` marker, so an unrelated backend cannot satisfy the assertion) before the
   * tombstone commits.
   *
   * On release the vote's decisive counter re-evaluates, finds `deleted_at` set, matches nothing —
   * and the route answers **404**, where before P1.2 both vote routes published "Already voted" for
   * every falsy answer from the store. That is the end-to-end proof of the fourth recorded change.
   */
  it("answers 404 through the REST adapter when a vote loses to a delete, moving nothing", async () => {
    const author = await seedAgent();
    const group = await seedGroup(author.id);
    const post = await seedPost(author.id, group);
    const voter = await seedAgent();
    const marker = await maxEventId();

    const race = await raceAgainstHeldLock<Response>({
      // The tombstone itself, held open. This is the write `deletePost`'s batch makes, taking
      // `FOR NO KEY UPDATE` on the row — the mode the vote's counter update has to wait for.
      hold: async (holder) => {
        await holder.query(
          `UPDATE posts SET deleted_at = NOW(), deleted_by_agent_id = $2, deleted_karma_reversed_at = NOW()
           WHERE id = $1 AND deleted_at IS NULL`,
          [post, author.id]
        );
      },
      contend: () =>
        UPVOTE_ROUTE(
          new Request(`https://safemolt.com/api/v1/posts/${post}/upvote`, {
            method: "POST",
            headers: withMiddlewareHeaders({ headers: { Authorization: `Bearer ${voter.apiKey}` } })
              .headers as HeadersInit,
          }) as never,
          { params: Promise.resolve({ id: post }) }
        ),
      contenderMarker: "race:m11-1c-post-vote",
    });

    // It really blocked, and on the vote statement rather than on something incidental.
    expect(race.observedBlocked).toBe(true);
    expect(race.waiterQueries.join("\n")).toContain("post_votes");

    // The recorded change, end to end: 404, not the pre-P1.2 "Already voted" 400.
    expect(race.result.status).toBe(404);
    expect(await race.result.json()).toMatchObject({
      success: false,
      error: "Post not found",
      error_detail: { code: "not_found" },
    });

    // And the loser moved nothing: no vote row, no counter, no karma, no event.
    const { rows: votes } = await pgPool().query(`SELECT 1 FROM post_votes WHERE post_id = $1`, [post]);
    expect(votes).toEqual([]);
    expect((await postCounters(post)).upvotes).toBe(0);
    expect(await karma(author.id)).toEqual({ points: 0, vote_points: 0 });
    expect(await eventsSince(marker)).toEqual([]);
  });

  /**
   * **The karma invariants, asserted against the event arm.**
   *
   * The one thing P1.2 must not have done is add a second karma writer or change what the vote
   * records. So: the delta is still on the vote row, `points` and `vote_points` still moved by ONE
   * floored amount, and a downvote against an agent at zero still records and awards exactly 0.
   */
  it("records points_delta on the vote row, and moves points and vote_points by one floored amount", async () => {
    const author = await seedAgent();
    const group = await seedGroup(author.id);
    const post = await seedPost(author.id, group);
    const up = await seedAgent();
    const down = await seedAgent();

    expect((await upvotePost({ agent: up, postId: post })).ok).toBe(true);
    expect(await karma(author.id)).toEqual({ points: 1, vote_points: 1 });
    const { rows: upRow } = await pgPool().query(
      `SELECT points_delta::float8 AS d FROM post_votes WHERE post_id = $1 AND agent_id = $2`,
      [post, up.id]
    );
    expect(upRow[0].d).toBe(1);

    expect((await downvotePost({ agent: down, postId: post })).ok).toBe(true);
    expect(await karma(author.id)).toEqual({ points: 0, vote_points: 0 });

    // At the floor: a further downvote awards nothing, records nothing, and still emits its event.
    const floored = await seedAgent();
    const marker = await maxEventId();
    expect((await downvotePost({ agent: floored, postId: post })).ok).toBe(true);
    expect(await karma(author.id)).toEqual({ points: 0, vote_points: 0 });
    const { rows: flooredRow } = await pgPool().query(
      `SELECT points_delta::float8 AS d FROM post_votes WHERE post_id = $1 AND agent_id = $2`,
      [post, floored.id]
    );
    expect(flooredRow[0].d).toBe(0);
    expect((await eventsSince(marker)).map((event) => event.kind)).toEqual(["post.voted"]);
    await expectKarmaComponentsSum(author.id);
  });

  it("emits comment.voted beside the comment karma award, with the same one-amount rule", async () => {
    const author = await seedAgent();
    const group = await seedGroup(author.id);
    const post = await seedPost(author.id, group);
    await clearRateWindow(author.id);
    const created = await createComment({ agent: author, postId: post, content: "vote me" });
    const commentId = created.ok ? created.data.comment.id : "";
    const voter = await seedAgent();
    const marker = await maxEventId();

    expect((await upvoteComment({ agent: voter, commentId })).ok).toBe(true);

    expect(await karma(author.id)).toEqual({ points: 1, vote_points: 1 });
    const { rows } = await pgPool().query(
      `SELECT points_delta::float8 AS d FROM comment_votes WHERE comment_id = $1 AND agent_id = $2`,
      [commentId, voter.id]
    );
    expect(rows[0].d).toBe(1);
    expect((await eventsSince(marker)).map((event) => event.kind)).toEqual(["comment.voted"]);
    await expectKarmaComponentsSum(author.id);
  });
});

/**
 * Comment votes get the post votes' coverage, not a lighter version of it (codex round 4).
 *
 * The two statements are deliberately the same shape (M11-1C), so the properties that matter for one
 * matter for the other: a duplicate must write nothing at all, and a vote that loses to the parent
 * post's deletion must find `live_parent` empty rather than award on a tombstone.
 */
describe("comment votes — the post votes' coverage, applied", () => {
  it("writes nothing at all for a duplicate comment vote", async () => {
    const author = await seedAgent();
    const group = await seedGroup(author.id);
    const post = await seedPost(author.id, group);
    await clearRateWindow(author.id);
    const created = await createComment({ agent: author, postId: post, content: "vote me twice" });
    const commentId = created.ok ? created.data.comment.id : "";
    const voter = await seedAgent();
    expect((await upvoteComment({ agent: voter, commentId })).ok).toBe(true);

    const marker = await maxEventId();
    const beforeKarma = await karma(author.id);
    const { rows: beforeCount } = await pgPool().query(`SELECT upvotes FROM comments WHERE id = $1`, [commentId]);
    const { rows: beforeVotes } = await pgPool().query(
      `SELECT count(*)::int AS c FROM comment_votes WHERE comment_id = $1`,
      [commentId]
    );

    expect(await upvoteComment({ agent: voter, commentId })).toMatchObject({
      ok: false,
      code: "already_voted",
    });

    const { rows: afterCount } = await pgPool().query(`SELECT upvotes FROM comments WHERE id = $1`, [commentId]);
    const { rows: afterVotes } = await pgPool().query(
      `SELECT count(*)::int AS c FROM comment_votes WHERE comment_id = $1`,
      [commentId]
    );
    expect(afterCount[0].upvotes).toBe(beforeCount[0].upvotes);
    expect(afterVotes[0].c).toBe(beforeVotes[0].c);
    expect(await karma(author.id)).toEqual(beforeKarma);
    expect(await eventsSince(marker)).toEqual([]);
  });

  it("blocks on the post delete's own lock and then refuses the comment vote, moving nothing", async () => {
    const author = await seedAgent();
    const group = await seedGroup(author.id);
    const post = await seedPost(author.id, group);
    await clearRateWindow(author.id);
    const created = await createComment({ agent: author, postId: post, content: "about to be orphaned" });
    const commentId = created.ok ? created.data.comment.id : "";
    const voter = await seedAgent();
    const marker = await maxEventId();
    const beforeKarma = await karma(author.id);

    const race = await raceAgainstHeldLock({
      hold: async (holder) => {
        await holder.query(
          `UPDATE posts SET deleted_at = NOW(), deleted_by_agent_id = $2, deleted_karma_reversed_at = NOW()
           WHERE id = $1 AND deleted_at IS NULL`,
          [post, author.id]
        );
      },
      contend: () => upvoteComment({ agent: voter, commentId }),
      // `live_parent` takes `FOR SHARE OF p` on the POST, which is what waits on the tombstone.
      contenderMarker: "race:m11-1c-comment-vote",
    });

    expect(race.observedBlocked).toBe(true);
    expect(race.result.ok).toBe(false);

    const { rows: votes } = await pgPool().query(
      `SELECT count(*)::int AS c FROM comment_votes WHERE comment_id = $1`,
      [commentId]
    );
    expect(votes[0].c).toBe(0);
    const { rows: counts } = await pgPool().query(`SELECT upvotes FROM comments WHERE id = $1`, [commentId]);
    expect(counts[0].upvotes).toBe(0);
    expect(await karma(author.id)).toEqual(beforeKarma);
    expect(await eventsSince(marker)).toEqual([]);
  });
});

describe("follows — the gated insert, the alignment, and the clock", () => {
  it("emits one agent.followed for a first follow and nothing for a re-follow", async () => {
    const followee = await seedAgent();
    const follower = await seedAgent();
    const marker = await maxEventId();

    expect((await followAgent({ agent: follower, targetName: followee.name })).ok).toBe(true);
    const [event] = await eventsSince(marker);
    expect(event.kind).toBe("agent.followed");
    expect(event.actorAgentId).toBe(follower.id);
    expect(event.subjectId).toBe(followee.id);

    const after = await maxEventId();
    const entityId = `${follower.id}:${followee.id}`;
    const { rows: firstTrail } = await pgPool().query(
      `SELECT occurred_at, source_event_id FROM activity_events WHERE kind = 'follow' AND entity_id = $1`,
      [entityId]
    );
    // The EVENT's clock, which is what the consumer projects — the discharge of this kind's
    // `OCCURRED_AT_STAMP_PENDING_KINDS` obligation.
    expect((firstTrail[0].occurred_at as Date).toISOString()).toBe(event.createdAt);
    expect(Number(firstTrail[0].source_event_id)).toBe(event.id);

    // The recorded behavior change: a re-follow writes nothing, emits nothing, and no longer
    // refreshes the trail timestamp.
    expect((await followAgent({ agent: follower, targetName: followee.name })).ok).toBe(true);
    expect(await eventsSince(after)).toEqual([]);
    const { rows: secondTrail } = await pgPool().query(
      `SELECT occurred_at, source_event_id FROM activity_events WHERE kind = 'follow' AND entity_id = $1`,
      [entityId]
    );
    expect(secondTrail[0]).toEqual(firstTrail[0]);

    const { rows: counted } = await pgPool().query(`SELECT follower_count FROM agents WHERE id = $1`, [
      followee.id,
    ]);
    expect(Number(counted[0].follower_count)).toBe(1);

    const { rows: notified } = await pgPool().query(
      `SELECT dedup_key FROM notifications WHERE agent_id = $1 AND type = 'new_follower'`,
      [followee.id]
    );
    expect(notified).toHaveLength(1);
    expect(notified[0].dedup_key).toBe(`new_follower:${followee.id}:${event.id}`);
  });

  /**
   * **The transitional activity writer cannot resurrect a withdrawn followee's projection**
   * (codex round 1).
   *
   * It runs POST-COMMIT, and `deleteAgent` deletes the withdrawn agent's follow projections (u2,
   * round 5). A writer that only trusted `followAgent`'s earlier read would land after that cleanup
   * and re-create the row — carrying a withdrawn agent's name, `/u/{name}` href and
   * `metadata.followee_name` forever, because nothing sweeps it again. The locked target makes the
   * write conditional on the followee still existing, so the delayed call writes nothing at all.
   *
   * **The unfollow before the withdrawal is not scene-setting, it is a precondition of the domain:**
   * `following.followee_id REFERENCES agents(id)` carries no cascade, so an agent with a live
   * follower cannot be deleted at all (the withdrawal surfaces 23503 as a refusal). The trail row
   * outlives the unfollow — nothing removes it there — so the resurrection window is exactly this
   * shape: follow, unfollow, withdraw, and a slow projection from the original follow lands last.
   */
  it("writes nothing when the followee withdrew before the delayed projection lands", async () => {
    const { recordFollowActivityEvent } = await import("@/lib/store/activity/events");
    const { deleteAgent } = await import("@/lib/store/agents/db");
    const followee = await seedAgent();
    const follower = await seedAgent();
    expect((await followAgent({ agent: follower, targetName: followee.name })).ok).toBe(true);
    const entityId = `${follower.id}:${followee.id}`;
    const trailRows = async () => {
      const { rows } = await pgPool().query(
        `SELECT 1 FROM activity_events WHERE kind = 'follow' AND entity_id = $1`,
        [entityId]
      );
      return rows;
    };
    expect(await trailRows()).toHaveLength(1);

    // The relationship goes first — the FK requires it — and the trail row deliberately survives it.
    expect((await unfollowAgent({ agent: follower, targetName: followee.name })).ok).toBe(true);
    expect(await trailRows()).toHaveLength(1);

    // The withdrawal, and the projection cleanup that rides it.
    expect(await deleteAgent(followee.id)).toEqual({ ok: true });
    expect(await trailRows()).toEqual([]);

    // The delayed write, with everything it had in hand at follow time.
    await recordFollowActivityEvent({
      followerId: follower.id,
      followeeId: followee.id,
      followeeName: followee.name,
      createdAt: new Date().toISOString(),
    });

    expect(await trailRows()).toEqual([]);
  });

  it("keeps one increment and one event when two follows race", async () => {
    const followee = await seedAgent();
    const follower = await seedAgent();
    const marker = await maxEventId();

    const outcomes = await runConcurrently([
      () => followAgent({ agent: follower, targetName: followee.name }),
      () => followAgent({ agent: follower, targetName: followee.name }),
    ]);

    expect(rejections(outcomes)).toEqual([]);
    expect((await eventsSince(marker)).map((event) => event.kind)).toEqual(["agent.followed"]);
    const { rows } = await pgPool().query(`SELECT follower_count FROM agents WHERE id = $1`, [followee.id]);
    expect(Number(rows[0].follower_count)).toBe(1);
  });

  it("emits agent.unfollowed only for a removal, and decrements once", async () => {
    const followee = await seedAgent();
    const follower = await seedAgent();
    await followAgent({ agent: follower, targetName: followee.name });
    const marker = await maxEventId();

    expect((await unfollowAgent({ agent: follower, targetName: followee.name })).ok).toBe(true);
    expect((await eventsSince(marker)).map((event) => event.kind)).toEqual(["agent.unfollowed"]);

    const after = await maxEventId();
    expect(await unfollowAgent({ agent: follower, targetName: followee.name })).toMatchObject({
      ok: false,
      code: "not_following",
    });
    expect(await eventsSince(after)).toEqual([]);
    const { rows } = await pgPool().query(`SELECT follower_count FROM agents WHERE id = $1`, [followee.id]);
    expect(Number(rows[0].follower_count)).toBe(0);
  });
});

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

  async function drainAll(): Promise<void> {
    for (const consumer of eventConsumers) await drainEventConsumer(consumer, { batchSize: 200 });
  }

  /** Drop the paths a shadow row legitimately may not match — the consumer's own declaration. */
  function strip(row: Record<string, unknown>, paths: readonly string[]): Record<string, unknown> {
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

  /**
   * The CANONICAL ingest payload, on both sides of the soak: recipient + chunk key, the source
   * text's hash, and the metadata the chunk carries.
   *
   * **Never the embedding.** The vector service is stubbed here and `describe` never calls one, so
   * the only comparable content is the text's hash — which is also what P2.1 prescribes, because a
   * shadow table must not become a second, undeletable copy of platform content.
   */
  interface CanonicalIngestChunk {
    key: string;
    text_sha256: string;
    metadata: unknown;
  }

  const byKey = (a: CanonicalIngestChunk, b: CanonicalIngestChunk) => a.key.localeCompare(b.key);

  /** Deduplicated by natural key: a second write under one deterministic chunk id is idempotence. */
  function canonicalize(rows: readonly CanonicalIngestChunk[]): CanonicalIngestChunk[] {
    return Array.from(new Map(rows.map((row) => [row.key, row])).values()).sort(byKey);
  }

  /**
   * What the LEGACY fan-out handed the vector store, for one subject's chunk-id stem.
   *
   * Scoped by stem rather than by clearing the mock, because the scheduler is fire-and-forget: a
   * neighbouring case's fan-out can still be landing, and a `mockClear` would race it either way.
   */
  function legacyChunks(stem: string): CanonicalIngestChunk[] {
    const rows = vectorUpsert.mock.calls.flatMap(
      ([agentId, chunks]: [string, Array<{ id: string; text: string; metadata: unknown }>]) =>
        chunks
          .filter((chunk) => chunk.id.startsWith(stem))
          .map((chunk) => ({
            key: `${agentId}:${chunk.id}`,
            text_sha256: createHash("sha256").update(chunk.text).digest("hex"),
            // Through JSON, so the comparison is against the same shape JSONB gives back.
            metadata: JSON.parse(JSON.stringify(chunk.metadata)),
          }))
    );
    return canonicalize(rows);
  }

  /**
   * Wait for the ACTION's own fire-and-forget fan-out to reach the vector store.
   *
   * Observed, not re-derived: calling `ingestCommentForAudience` here would prove the helper works
   * and say nothing about what the producer actually wrote.
   */
  async function awaitLegacyChunks(stem: string, timeoutMs = 15_000): Promise<CanonicalIngestChunk[]> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (legacyChunks(stem).length > 0) {
        // One more tick, so a fan-out still mid-audience is not sampled half-written.
        await new Promise((resolve) => setTimeout(resolve, 100));
        return legacyChunks(stem);
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    return legacyChunks(stem);
  }

  /** The same canonical form, read off the shadow rows the drain wrote. */
  function shadowIngestChunks(
    rows: ReadonlyArray<{ effect_key: string; payload: Record<string, unknown> }>
  ): CanonicalIngestChunk[] {
    return canonicalize(
      rows.map((row) => ({
        key: row.effect_key,
        text_sha256: row.payload.text_sha256 as string,
        metadata: row.payload.metadata,
      }))
    );
  }

  /**
   * The whole ingest half of the soak for one comment: the keys compose from the payload, and the
   * canonical payloads match the legacy writes exactly.
   *
   * A key-set check alone cannot see a chunk whose text or metadata drifted, and drift is precisely
   * what the dual-write phase has to rule out before the kind can flip.
   */
  async function expectIngestParity(
    ingest: ReadonlyArray<{ effect_key: string; payload: Record<string, unknown> }>,
    commentId: string
  ): Promise<void> {
    const stem = commentIngestChunkStem(commentId);
    expect(ingest.length).toBeGreaterThan(0);
    // The key IS recipient + chunk id — asserted rather than assumed, since it is the join column.
    for (const row of ingest) {
      expect(row.effect_key).toBe(`${row.payload.recipient_agent_id}:${row.payload.chunk_id}`);
      expect(String(row.payload.chunk_id).startsWith(stem)).toBe(true);
    }
    const legacy = await awaitLegacyChunks(stem);
    expect(legacy.length).toBeGreaterThan(0);
    expect(shadowIngestChunks(ingest)).toEqual(legacy);
  }

  beforeAll(async () => {
    await activateRealConsumers();
  });

  it("records comment.created shadow rows matching the legacy projections, occurred_at included", async () => {
    const author = await seedAgent();
    const group = await seedGroup(author.id);
    const post = await seedPost(author.id, group);
    const commenter = await seedAgent();
    await clearRateWindow(commenter.id);
    const marker = await maxEventId();

    const created = await createComment({ agent: commenter, postId: post, content: LONG_BODY });
    const commentId = created.ok ? created.data.comment.id : "";
    const [event] = await eventsSince(marker);

    await drainAll();

    // Every consumer receipted it — `shadow` and `none` both receipt, which is what keeps the scan
    // floor moving.
    expect(await receipted(event.id)).toEqual([...REAL_CONSUMERS].sort());
    const shadow = await shadowRows(event.id);

    // ---- activity-trail: the canonical projection, diffed against the row the inline writer wrote.
    const activity = shadow.filter((row) => row.consumer === "activity-trail");
    expect(activity.map((row) => row.effect_key)).toEqual([`comment:${commentId}`]);
    const { rows: legacyTrail } = await pgPool().query(
      `SELECT kind, occurred_at, actor_id, entity_id, title, href, summary, context_hint, metadata
       FROM activity_events WHERE kind = 'comment' AND entity_id = $1`,
      [commentId]
    );
    const volatileTrail = new Set(activityTrailEffects.volatileShadowFields?.["comment.created"] ?? []);
    for (const [field, value] of Object.entries(legacyTrail[0] as Record<string, unknown>)) {
      if (volatileTrail.has(field)) continue;
      const expected = value instanceof Date ? value.toISOString() : value;
      expect({ [field]: activity[0].payload[field] }).toEqual({ [field]: expected });
    }
    // Named out loud: the trail's ORDERING key matches, which is the obligation this kind discharged.
    expect(activity[0].payload.occurred_at).toEqual(
      (legacyTrail[0].occurred_at as Date).toISOString()
    );

    // ---- notifications: same key as the legacy row, same structural payload.
    const notification = shadow.filter((row) => row.consumer === "notifications");
    const { rows: legacyNotification } = await pgPool().query(
      `SELECT agent_id, type, priority, actor, target, href, created_at, web_url, deadline_at, metadata, dedup_key
       FROM notifications WHERE metadata->>'comment_id' = $1`,
      [commentId]
    );
    expect(notification).toHaveLength(1);
    expect(notification[0].effect_key).toBe(legacyNotification[0].dedup_key);
    const volatileNotification = new Set(notificationEffects.volatileShadowFields?.["comment.created"] ?? []);
    // `created_at` is compared since the codex round-2 fix: both writers stamp the COMMENT's clock,
    // so a consumer regressing to drain time must fail the soak, not pass it.
    expect(strip(notification[0].payload, [...volatileNotification])).toEqual(
      strip(
        {
          ...(legacyNotification[0] as Record<string, unknown>),
          created_at: (legacyNotification[0].created_at as Date).toISOString(),
        },
        [...volatileNotification]
      )
    );

    // ---- memory-ingest: one row per recipient per chunk, keyed on the comment's own stem, and
    // canonically EQUAL to what the action's own fan-out handed the vector store.
    const ingest = shadow.filter((row) => row.consumer === "memory-ingest");
    await expectIngestParity(ingest, commentId);

    // Shadow writes NO real projection: the legacy rows above are the only ones that exist.
    const { rows: trailRows } = await pgPool().query(
      `SELECT count(*)::int AS c FROM activity_events WHERE kind = 'comment' AND entity_id = $1`,
      [commentId]
    );
    expect(trailRows[0].c).toBe(1);
  });

  /**
   * **The REPLY branch of the comment statement, soaked** (codex round 1).
   *
   * `createComment` renders two different notification inserts — a top-level comment notifies the
   * post's author, a reply notifies the parent comment's author, and a reply never notifies the post
   * author. Only the first branch was covered above, so the branch that carries a different
   * recipient, a different type, a different target object and a different dedup key was shipping to
   * `shadow` unverified. The two are mutually exclusive by the legacy contract, and "exactly one, of
   * the right type" is the half a key-set check alone would miss.
   */
  it("records a reply's shadow rows on the parent's author, and none on the post's", async () => {
    const author = await seedAgent();
    const parentAuthor = await seedAgent();
    const replier = await seedAgent();
    const group = await seedGroup(author.id);
    const post = await seedPost(author.id, group);
    await clearRateWindow(parentAuthor.id);
    const parent = await createComment({ agent: parentAuthor, postId: post, content: LONG_BODY });
    const parentId = parent.ok ? parent.data.comment.id : "";
    await clearRateWindow(replier.id);
    const marker = await maxEventId();

    const replied = await createComment({
      agent: replier,
      postId: post,
      content: `${LONG_BODY} — as a reply`,
      parentId,
    });
    expect(replied.ok).toBe(true);
    const replyId = replied.ok ? replied.data.comment.id : "";
    const [event] = await eventsSince(marker);
    expect(event.payload).toMatchObject({ comment_id: replyId, post_id: post, parent_id: parentId });

    await drainAll();
    expect(await receipted(event.id)).toEqual([...REAL_CONSUMERS].sort());
    const shadow = await shadowRows(event.id);

    // Exactly one notification effect, on the PARENT's author, under Decision 6's key.
    const notification = shadow.filter((row) => row.consumer === "notifications");
    expect(notification).toHaveLength(1);
    expect(notification[0].effect_key).toBe(`reply_to_my_comment:${parentAuthor.id}:${event.id}`);
    expect(notification[0].payload).toMatchObject({
      agent_id: parentAuthor.id,
      type: "reply_to_my_comment",
    });
    // And none for the post's author — a reply never notifies them, which is the legacy contract.
    expect(notification.some((row) => row.effect_key.startsWith("comment_on_my_post:"))).toBe(false);

    // Canonical payload equality against the row the inline REPLY branch actually wrote.
    const { rows: legacy } = await pgPool().query(
      `SELECT agent_id, type, priority, actor, target, href, created_at, web_url, deadline_at, metadata, dedup_key
       FROM notifications WHERE metadata->>'comment_id' = $1`,
      [replyId]
    );
    expect(legacy).toHaveLength(1);
    expect(legacy[0].dedup_key).toBe(notification[0].effect_key);
    expect((legacy[0].metadata as Record<string, unknown>).parent_comment_id).toBe(parentId);
    const volatileNotification = new Set(notificationEffects.volatileShadowFields?.["comment.created"] ?? []);
    expect(strip(notification[0].payload, [...volatileNotification])).toEqual(
      strip(
        {
          ...(legacy[0] as Record<string, unknown>),
          created_at: (legacy[0].created_at as Date).toISOString(),
        },
        [...volatileNotification]
      )
    );

    // The trail row too: a reply's summary and metadata differ from a top-level comment's.
    const activity = shadow.filter((row) => row.consumer === "activity-trail");
    expect(activity.map((row) => row.effect_key)).toEqual([`comment:${replyId}`]);
    const { rows: legacyTrail } = await pgPool().query(
      `SELECT kind, occurred_at, actor_id, entity_id, title, href, summary, context_hint, metadata
       FROM activity_events WHERE kind = 'comment' AND entity_id = $1`,
      [replyId]
    );
    const volatileTrail = new Set(activityTrailEffects.volatileShadowFields?.["comment.created"] ?? []);
    for (const [field, value] of Object.entries(legacyTrail[0] as Record<string, unknown>)) {
      if (volatileTrail.has(field)) continue;
      const expected = value instanceof Date ? value.toISOString() : value;
      expect({ [field]: activity[0].payload[field] }).toEqual({ [field]: expected });
    }
    expect((legacyTrail[0].metadata as Record<string, unknown>).parent_comment_id).toBe(parentId);

    // And the ingest, which the reply case did not inspect at all. A reply's ingest text carries the
    // POST's title beside the reply's own body and its metadata names a different subject, so both
    // the hash and the metadata are branch-specific — a key-set check would have seen neither.
    const ingest = shadow.filter((row) => row.consumer === "memory-ingest");
    await expectIngestParity(ingest, replyId);
  });

  it("records agent.followed shadow rows matching the legacy projections, occurred_at included", async () => {
    const followee = await seedAgent();
    const follower = await seedAgent();
    const marker = await maxEventId();

    expect((await followAgent({ agent: follower, targetName: followee.name })).ok).toBe(true);
    const [event] = await eventsSince(marker);

    await drainAll();
    expect(await receipted(event.id)).toEqual([...REAL_CONSUMERS].sort());
    const shadow = await shadowRows(event.id);
    const entityId = `${follower.id}:${followee.id}`;

    const activity = shadow.filter((row) => row.consumer === "activity-trail");
    expect(activity.map((row) => row.effect_key)).toEqual([`follow:${entityId}`]);
    const { rows: legacyTrail } = await pgPool().query(
      `SELECT kind, occurred_at, actor_id, entity_id, title, href, summary, context_hint, metadata
       FROM activity_events WHERE kind = 'follow' AND entity_id = $1`,
      [entityId]
    );
    const volatileTrail = [...(activityTrailEffects.volatileShadowFields?.["agent.followed"] ?? [])];
    const legacyRow = {
      ...(legacyTrail[0] as Record<string, unknown>),
      occurred_at: (legacyTrail[0].occurred_at as Date).toISOString(),
    };
    expect(strip(activity[0].payload, volatileTrail)).toEqual(strip(legacyRow, volatileTrail));
    // **The whole reason this kind could not enter `shadow` before u3b**: both sides now project the
    // EVENT's `created_at`, so the trail's ordering key is equal rather than two clocks apart.
    expect(activity[0].payload.occurred_at).toBe(event.createdAt);
    expect(legacyRow.occurred_at).toBe(event.createdAt);

    const notification = shadow.filter((row) => row.consumer === "notifications");
    const { rows: legacyNotification } = await pgPool().query(
      `SELECT agent_id, type, priority, actor, target, href, created_at, web_url, deadline_at, metadata, dedup_key
       FROM notifications WHERE agent_id = $1 AND type = 'new_follower'`,
      [followee.id]
    );
    expect(notification).toHaveLength(1);
    expect(notification[0].effect_key).toBe(legacyNotification[0].dedup_key);
    const volatileNotification = [...(notificationEffects.volatileShadowFields?.["agent.followed"] ?? [])];
    expect(strip(notification[0].payload, volatileNotification)).toEqual(
      strip(
        {
          ...(legacyNotification[0] as Record<string, unknown>),
          created_at: (legacyNotification[0].created_at as Date).toISOString(),
        },
        volatileNotification
      )
    );
    // The follow row's ONLY clock is the event's: both writers stamp the statement's returned
    // `created_at`, and the soak now proves it outright.
    expect(notification[0].payload.created_at).toBe(event.createdAt);
    expect((legacyNotification[0].created_at as Date).toISOString()).toBe(event.createdAt);

    // Follows have no ingest effect at all — `none`, not `legacy`.
    expect(shadow.filter((row) => row.consumer === "memory-ingest")).toEqual([]);
    expect(memoryIngestEffects.volatileShadowFields?.["agent.followed"]).toBeUndefined();
  });

  it("receipts the history-only kinds without describing anything", async () => {
    const author = await seedAgent();
    const group = await seedGroup(author.id);
    const post = await seedPost(author.id, group);
    const voter = await seedAgent();
    const marker = await maxEventId();

    expect((await upvotePost({ agent: voter, postId: post })).ok).toBe(true);
    const [event] = await eventsSince(marker);
    await drainAll();

    // A kind nobody has an effect for still has to be receipted, or its id wedges the scan floor.
    expect(await receipted(event.id)).toEqual([...REAL_CONSUMERS].sort());
    expect(await shadowRows(event.id)).toEqual([]);
  });

  it("keeps follow event and projections atomic under trigger injection", async () => {
    const follower = await seedAgent();
    const followee = await seedAgent();
    const event = { kind: "agent.followed", actorAgentId: follower.id, subjectType: "agent", subjectId: followee.id, payload: {} } as const;
    const suffix = nextId("atomic");
    const fn = `u3b_fail_${suffix}`;
    const trigger = `${fn}_trigger`;
    const run = async (table: "events" | "activity_events", kind: string) => {
      await pgPool().query(`CREATE OR REPLACE FUNCTION ${fn}() RETURNS trigger LANGUAGE plpgsql AS $f$ BEGIN IF NEW.kind = '${kind}' THEN RAISE EXCEPTION 'u3b injected'; END IF; RETURN NEW; END; $f$;`);
      await pgPool().query(`CREATE TRIGGER ${trigger} BEFORE INSERT ON ${table} FOR EACH ROW EXECUTE FUNCTION ${fn}()`);
      try { await expect(storeFollowAgent(follower.id, followee.name, [event])).rejects.toThrow("u3b injected"); }
      finally { await pgPool().query(`DROP TRIGGER IF EXISTS ${trigger} ON ${table}`); await pgPool().query(`DROP FUNCTION IF EXISTS ${fn}()`); }
      const { rows } = await pgPool().query(`SELECT 1 FROM following WHERE follower_id = $1 AND followee_id = $2`, [follower.id, followee.id]);
      expect(rows).toEqual([]);
    };
    await run("activity_events", "follow");
    await run("events", "agent.followed");
  });
});
