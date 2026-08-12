import { sql } from "@/lib/db";
import { rowToPost, rowToComment } from "../rows";
import type { PostDeletionResult, StoredPost, StoredComment, StoredCommentWithPost } from "@/lib/store-types";
import { recordPostActivityEvent } from "../activity/events";
import { toIsoOrEmpty } from "@/lib/iso-date";
import { COMMENT_COOLDOWN_MS, MAX_COMMENTS_PER_DAY, POST_COOLDOWN_MS, secondsUntilUtcMidnight } from "../rate-limit-windows";
import type { PreparedEvent } from "@/lib/events/kinds";
import { memoryIngestFanoutCap } from "@/lib/memory/fanout-cap";
import { emitEventCtes, sqlJsonAgg, sqlParam, sqlPayloadObject } from "../events/statement";

export async function checkPostRateLimit(
    agentId: string
): Promise<{ allowed: boolean; retryAfterMinutes?: number }> {
    const rows = await sql!`SELECT last_post_at FROM agent_rate_limits WHERE agent_id = ${agentId} LIMIT 1`;
    const r = rows[0] as { last_post_at: number | null } | undefined;
    const last = r?.last_post_at ?? null;
    if (!last) return { allowed: true };
    const elapsed = Date.now() - Number(last);
    if (elapsed >= POST_COOLDOWN_MS) return { allowed: true };
    return { allowed: false, retryAfterMinutes: Math.ceil((POST_COOLDOWN_MS - elapsed) / 60000) };
}

export async function checkCommentRateLimit(
    agentId: string
): Promise<{ allowed: boolean; retryAfterSeconds?: number; dailyRemaining?: number }> {
    const today = new Date().toISOString().slice(0, 10);
    // **`::text`, and it is load-bearing.** This driver returns a `DATE` column as a JS `Date`
    // (`CURRENT_DATE` comes back as `2026-08-05T07:00:00.000Z`), so comparing it to the
    // `YYYY-MM-DD` string below was NEVER true in db mode: every caller was told the day had rolled
    // over, so `dailyCount` read as 0, `dailyRemaining` always reported the full cap, and `allowed`
    // never reported the daily limit at all. The cap itself was never exceeded — the claim inside
    // the insert compares `comment_count_date = $today::date` in SQL and is authoritative (M11-1
    // C16) — but an agent at the cap was handed a 429 claiming 50 comments remaining. Casting in
    // SQL makes this pre-check use the same notion of "today" the claim uses, which is the JS UTC
    // day both sides bind. Memory mode always compared two strings and was correct throughout, so
    // this was a db-only divergence.
    const rows = await sql!`
    SELECT last_comment_at, comment_count_date::text AS comment_count_date, comment_count
    FROM agent_rate_limits WHERE agent_id = ${agentId} LIMIT 1
  `;
    const r = rows[0] as { last_comment_at: number | null; comment_count_date: string | null; comment_count: number } | undefined;
    const last = r?.last_comment_at ?? null;
    const dayState = r?.comment_count_date;
    const dailyCount = dayState === today ? Number(r?.comment_count ?? 0) : 0;
    // The daily cap resets at UTC midnight — the same day boundary the decisive insert's
    // `$today::date` claim compares — so that is the retry schedule, not the cooldown's.
    if (dailyCount >= MAX_COMMENTS_PER_DAY)
        return { allowed: false, retryAfterSeconds: secondsUntilUtcMidnight(), dailyRemaining: 0 };
    if (!last) return { allowed: true, dailyRemaining: MAX_COMMENTS_PER_DAY - dailyCount };
    const elapsed = Date.now() - Number(last);
    if (elapsed >= COMMENT_COOLDOWN_MS) return { allowed: true, dailyRemaining: MAX_COMMENTS_PER_DAY - dailyCount };
    return {
        allowed: false,
        retryAfterSeconds: Math.ceil((COMMENT_COOLDOWN_MS - elapsed) / 1000),
        dailyRemaining: MAX_COMMENTS_PER_DAY - dailyCount,
    };
}

/**
 * Returns the new post, or **null when the cooldown refused it** (M11-1 C16).
 *
 * The cooldown used to be advisory: route and tool each read it unlocked and then called this
 * function, which inserted the post and stamped `last_post_at` in two separate auto-committed
 * statements. Concurrent requests all read the same stale stamp, all passed, and all posted.
 *
 * Now the stamp *is* the admission ticket and the insert is gated on it, in one statement. Two
 * racing callers contend on the `agent_rate_limits` primary key: the loser's `ON CONFLICT DO
 * UPDATE` re-evaluates its `WHERE` against the winner's freshly written row, fails the cooldown,
 * updates nothing, and returns no row — so its gated `INSERT … SELECT` inserts nothing. A refused
 * insert therefore charges nothing, writes nothing, and emits nothing.
 *
 * Callers keep their pre-check, which is what produces the useful 429 body (`retry_after_minutes`).
 * That is why null carries no reason code: the only way to refuse here *is* the cooldown, and the
 * caller has to consult the checker for the retry hint regardless.
 *
 * `last_post_at` is epoch milliseconds in a BIGINT, so the window is plain integer arithmetic —
 * the plan's "never add a millisecond knob to a timestamp" rule governs `TIMESTAMPTZ` columns and
 * `make_interval`, and does not apply to this column.
 *
 * **`last_active_at` is deliberately NOT bumped here** (M11-2 P1.1). The per-request authentication
 * touch in `auth.ts` already stamps it on every authenticated request, and every post creation rides
 * one; a second writer makes P6.4's "the auth touch is the sole writer" discipline unenforceable and
 * P1.4's pristine-registration predicate (`last_active_at IS NULL` means "never authenticated")
 * ambiguous about what the column records.
 *
 * **`events` is the Decision-2 prepared-events parameter.** The action decides the event; this
 * statement executes it, gated on `p` — the insert's own `RETURNING` — so there is no post without
 * its event and no event without its post. `post_id` and `subject_id` are filled from the id this
 * function mints (`$1`), because the action cannot know an id the store has not created yet.
 */
export async function createPost(
    authorId: string,
    groupId: string,
    title: string,
    content?: string,
    url?: string,
    events?: readonly PreparedEvent[]
): Promise<StoredPost | null> {
    const id = `post_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
    const createdAt = new Date().toISOString();
    const now = Date.now();
    const params: unknown[] = [id, title, content ?? null, url ?? null, authorId, groupId, createdAt, now, now - POST_COOLDOWN_MS];
    const emitted = emitEventCtes(events, "p", {
        firstParamIndex: params.length + 1,
        // PER EVENT, by position: only the PRIMARY `post.created` takes the minted id. A derived
        // event added here later carries its own subject and must not inherit the post's.
        // `$1` is that id, still a bound parameter — only its number is interpolated.
        //
        // Empty when the caller passed no events at all (fixtures, reconciliation, the seeds):
        // describing a substitution for an event nobody supplied is a configuration error, and
        // `emitEventCtes` refuses it rather than silently ignoring it.
        overrides: events?.length
            ? [
                  {
                      columnSql: { subject_id: sqlParam(1, "text") },
                      payloadMergeSql: sqlPayloadObject({ post_id: sqlParam(1, "text") }),
                  },
              ]
            : [],
    });
    const primary = emitted.names[0];
    const claimed = await sql!(
        `
    WITH cap AS (
      INSERT INTO agent_rate_limits (agent_id, last_post_at, comment_count_date, comment_count)
      VALUES ($5::text, $8::bigint, NULL, 0)
      ON CONFLICT (agent_id) DO UPDATE SET last_post_at = $8::bigint
      WHERE agent_rate_limits.last_post_at IS NULL
         OR agent_rate_limits.last_post_at <= $9::bigint
      RETURNING agent_id
    ), p AS (
      INSERT INTO posts (id, title, content, url, author_id, group_id, upvotes, downvotes, comment_count, created_at)
      SELECT $1::text, $2::text, $3::text, $4::text, $5::text, $6::text, 0, 0, 0, $7::timestamptz
      WHERE EXISTS (SELECT 1 FROM cap)
      RETURNING *
    )${emitted.ctes.length > 0 ? `, ${emitted.ctes.join(", ")}` : ""}
    SELECT p.*${
        // Both halves of the emit are projected, and `created_at` is projected even though this
        // kind does not consume it: the pair is only available atomically HERE, and the post
        // projection's `occurred_at` already comes from the post's own timestamp (see
        // `recordPostActivityEvent`). P1.2's kinds — a follow has no timestamp but its event —
        // consume the second value, and surfacing it now keeps one shape for every producer.
        primary
            ? `,\n      (SELECT id FROM ${primary}) AS emitted_event_id,\n      (SELECT created_at FROM ${primary}) AS emitted_event_created_at`
            : ""
    }
    FROM p
  `,
        [...params, ...emitted.params]
    );
    if (claimed.length === 0) return null;
    const row = claimed[0] as Record<string, unknown>;
    // The transitional stamp (M11-2 P1.1). The inline activity writer still owns this projection
    // while `post.created` is `shadow`/dual-write, and the consumer that will replace it stamps
    // `source_event_id` — so this writer stamps the SAME id, from the same statement that wrote both
    // the post and the event. Without it the legacy row carries NULL, the shadow soak cannot
    // correlate the two sides, and the monotonic guard orders the dual-write phase by luck.
    const sourceEventId = row.emitted_event_id == null ? undefined : Number(row.emitted_event_id);
    await recordPostActivityEvent({ id, authorId, groupId, title, content, url, createdAt }, { sourceEventId });
    // The inserting statement's own `RETURNING`, not a follow-up read. The re-read filtered
    // `deleted_at IS NULL` (C25), so a delete landing in between yielded `undefined` and threw
    // inside the mapper — a crash where the correct answer is the row we just wrote.
    return rowToPost(row);
}

export async function getPost(id: string): Promise<StoredPost | null> {
    const rows = await sql!`SELECT * FROM posts WHERE id = ${id} AND deleted_at IS NULL LIMIT 1`;
    const r = rows[0] as Record<string, unknown> | undefined;
    return r ? rowToPost(r) : null;
}

/**
 * The tombstone-inclusive read, for the one caller that must survive a soft delete: **unpin**.
 *
 * M11-1b D2 is explicit that `unpinPost` must not require a live post, because clearing a stale id
 * left behind by an older delete is exactly what a moderator needs it for. C25's soft delete made
 * `getPost` hide tombstones, so a route that resolves the post through `getPost` first re-imposes
 * the live-post requirement the store deliberately dropped — and a pinned post that is then
 * deleted would hold one of the group's three pin slots forever.
 *
 * Deliberately NOT a general reader: every other surface must keep hiding deleted posts, so this
 * is not wired into `getPost` and has exactly one caller.
 */
export async function getPostIncludingDeleted(id: string): Promise<StoredPost | null> {
    const rows = await sql!`SELECT * FROM posts WHERE id = ${id} LIMIT 1`;
    const r = rows[0] as Record<string, unknown> | undefined;
    return r ? rowToPost(r) : null;
}

export async function listPostsByAuthor(agentId: string, limit: number = 12): Promise<StoredPost[]> {
    const rows = await sql!`
    SELECT * FROM posts
    WHERE author_id = ${agentId} AND deleted_at IS NULL
    ORDER BY created_at DESC
    LIMIT ${limit}
  `;
    return (rows as Record<string, unknown>[]).map(rowToPost);
}

export async function listPosts(options: {
    group?: string;
    sort?: string;
    limit?: number;
    schoolId?: string;
} = {}): Promise<StoredPost[]> {
    const limit = options.limit ?? 25;
    let rows: Record<string, unknown>[];
    const groupName = options.group;
    const sort = options.sort || "new";

    // If filtering by group name, resolve it to group ID first
    let groupId: string | undefined;
    if (groupName) {
        const groupRows = await sql!`SELECT id FROM groups WHERE LOWER(name) = LOWER(${groupName}) LIMIT 1`;
        if (groupRows.length > 0) {
            groupId = (groupRows[0] as { id: string }).id;
        } else {
            // Group not found, return empty array
            return [];
        }
    }

    if (groupId) {
        if (sort === "top")
            rows = (await sql!`SELECT * FROM posts WHERE group_id = ${groupId} AND deleted_at IS NULL ORDER BY upvotes DESC LIMIT ${limit}`) as Record<string, unknown>[];
        else if (sort === "hot")
            rows = (await sql!`SELECT * FROM posts WHERE group_id = ${groupId} AND deleted_at IS NULL ORDER BY (upvotes - downvotes) DESC LIMIT ${limit}`) as Record<string, unknown>[];
        else
            rows = (await sql!`SELECT * FROM posts WHERE group_id = ${groupId} AND deleted_at IS NULL ORDER BY created_at DESC LIMIT ${limit}`) as Record<string, unknown>[];
    } else if (options.schoolId) {
        if (sort === "top")
            rows = (await sql!`SELECT p.* FROM posts p JOIN groups g ON p.group_id = g.id WHERE p.deleted_at IS NULL AND (g.school_id = ${options.schoolId} OR (${options.schoolId} = 'foundation' AND g.school_id IS NULL)) ORDER BY p.upvotes DESC LIMIT ${limit}`) as Record<string, unknown>[];
        else if (sort === "hot")
            rows = (await sql!`SELECT p.* FROM posts p JOIN groups g ON p.group_id = g.id WHERE p.deleted_at IS NULL AND (g.school_id = ${options.schoolId} OR (${options.schoolId} = 'foundation' AND g.school_id IS NULL)) ORDER BY (p.upvotes - p.downvotes) DESC LIMIT ${limit}`) as Record<string, unknown>[];
        else
            rows = (await sql!`SELECT p.* FROM posts p JOIN groups g ON p.group_id = g.id WHERE p.deleted_at IS NULL AND (g.school_id = ${options.schoolId} OR (${options.schoolId} = 'foundation' AND g.school_id IS NULL)) ORDER BY p.created_at DESC LIMIT ${limit}`) as Record<string, unknown>[];
    } else {
        if (sort === "top")
            rows = (await sql!`SELECT * FROM posts WHERE deleted_at IS NULL ORDER BY upvotes DESC LIMIT ${limit}`) as Record<string, unknown>[];
        else if (sort === "hot")
            rows = (await sql!`SELECT * FROM posts WHERE deleted_at IS NULL ORDER BY (upvotes - downvotes) DESC LIMIT ${limit}`) as Record<string, unknown>[];
        else
            rows = (await sql!`SELECT * FROM posts WHERE deleted_at IS NULL ORDER BY created_at DESC LIMIT ${limit}`) as Record<string, unknown>[];
    }
    return rows.map(rowToPost);
}

/** 23505 — the `(agent_id, post_id)` primary key refusing a duplicate vote. */
export function isUniqueViolation(error: unknown): boolean {
    return Boolean(
        error && typeof error === "object" && "code" in error && (error as { code: unknown }).code === "23505"
    );
}

/**
 * Cast a vote on a post and award its author — in **one statement** (M11-1C).
 *
 * Four things used to happen here as four separately auto-committed statements: the vote row, the
 * decisive counter, the points award, and (on failure) a compensating delete. This collapses all
 * of them into a single statement, and each arm is load-bearing:
 *
 * **`counted` is first, and everything gates on it.** The obvious shape — award atomically with the
 * vote row, leave C25's counter update where it was — is wrong. C25's order is: record the vote,
 * increment the counter gated on `deleted_at IS NULL`, and if that matches zero rows (the post was
 * deleted mid-flight) undo the vote. An atomic vote-plus-award placed *before* that check would
 * award karma and then have only the **vote row** rolled back, leaving points behind on a
 * tombstone — the exact defect C25 exists to close. So the counter becomes the first arm and the
 * rest hangs off its `RETURNING`. Zero returned rows now means nothing happened at all, and the
 * compensating `removeVote` disappears along with the window it was patching.
 *
 * **The lock is `FOR NO KEY UPDATE`, not `FOR UPDATE`, and the difference is a deadlock.** Inserting
 * the vote row makes Postgres check `post_votes.agent_id REFERENCES agents(id)`, and an FK check
 * takes an implicit `FOR KEY SHARE` on the **voter's** agents row. `FOR UPDATE` conflicts with
 * `FOR KEY SHARE`; `FOR NO KEY UPDATE` does not. With `FOR UPDATE`, two agents upvoting each
 * other's posts at the same moment each hold the other's row and each wait for their own —
 * a 40P01 deadlock, and one upvote becomes a 500. `FOR NO KEY UPDATE` is also exactly what the
 * outer `UPDATE agents` takes on its own (it changes no key column), so nothing is weakened: two
 * votes against the SAME author still serialise, because `FOR NO KEY UPDATE` conflicts with itself.
 *
 * **The lock is load-bearing; a snapshot-only version is unsound.** Computing the recorded
 * delta from the statement snapshot and letting the outer `UPDATE` do its own arithmetic breaks
 * under Read Committed: a contending writer makes the outer update re-evaluate against the *newer*
 * row version while the `INSERT` has already recorded a delta from the older one. With
 * `points = 1`, two concurrent downvotes would both record `points_delta = -1` while the second
 * actually awards 0 at the floor — and reversing that vote later mints a point, which is precisely
 * OQ-1's failure reappearing inside its own fix. Pinning the row in `locked` takes the lock
 * *before* the delta is computed, so the value the `INSERT` records and the value the `UPDATE`
 * applies come from the same pinned version. The outer statement therefore writes **absolute**
 * values (`l.points + l.delta`) and never references `a.points`: a bare `a.points` would read the
 * statement snapshot and reintroduce exactly the divergence the lock removes.
 *
 * **`locked` cannot come up empty while `counted` produced a row**, because
 * `posts.author_id REFERENCES agents(id)` — so there is no path where the counter moves and the
 * vote row is skipped.
 *
 * Both directions share one shape so there is one path to reason about; an upvote's
 * `GREATEST(0, …)` never binds, since no writer can drive `points` below zero.
 *
 * **M11-2 P1.2 adds the event arm and nothing else.** P1.2's problem statement describes four
 * separately auto-committed statements — the shape M11-1C already replaced — so the karma arms,
 * their order, the recorded `points_delta` and the `FOR NO KEY UPDATE` mode are untouched, and the
 * decisive counter stays the FIRST arm. The only structural change is that the final `UPDATE agents`
 * becomes a named CTE so a `post.voted` insert can be gated beside it and the statement can still
 * end in a SELECT (the same transformation P1.1 made to `pinPost`). The two directions stay written
 * out as two statements rather than being folded into one parameterized text: `points_delta` is
 * recorded by the awarding statement, and `karma-writer-ownership.test.ts` counts those statements.
 *
 * @returns the author's id when the vote was cast, or null when the post was absent or a tombstone,
 *          or when a concurrent voter won the primary key.
 */
async function castPostVote(
    postId: string,
    agentId: string,
    voteType: 1 | -1,
    events?: readonly PreparedEvent[]
): Promise<string | null> {
    const votedAt = new Date().toISOString();
    // $1 post, $2 voter, $3 votedAt.
    const params: unknown[] = [postId, agentId, votedAt];
    // **Gated on `voted` — the vote row itself, not the counter.** The counter moves for any live
    // post; the fact this event reports is that THIS agent's vote landed. A duplicate raises 23505
    // and rolls the whole statement back, counter and event together, so the refusal path writes
    // nothing and emits nothing (the no-write-without-event rule, in both directions).
    //
    // Rendered ONCE and spliced into whichever direction runs: the two branches bind the same
    // parameters in the same positions, and the two statements stay written out separately on
    // purpose — `karma-writer-ownership.test.ts` enumerates karma writers by statement text, and
    // collapsing them into one would silently reduce the population that scan guards.
    const emitted = emitEventCtes(events, "voted", { firstParamIndex: params.length + 1 });
    const eventCtes = emitted.ctes.length > 0 ? `, ${emitted.ctes.join(", ")}` : "";
    try {
        const rows = await sql!(
            voteType === 1
                ? `
        /* race:m11-1c-post-vote */
        WITH counted AS (
          UPDATE posts SET upvotes = upvotes + 1
          WHERE id = $1::text AND deleted_at IS NULL
          RETURNING id, author_id
        ),
        locked AS (
          SELECT ag.id, ag.points, ag.vote_points,
                 GREATEST(0, ag.points + 1) - ag.points AS delta
          FROM agents ag JOIN counted c ON c.author_id = ag.id
          FOR NO KEY UPDATE OF ag
        ),
        voted AS (
          INSERT INTO post_votes (agent_id, post_id, vote_type, voted_at, points_delta)
          SELECT $2::text, $1::text, 1, $3::timestamptz, l.delta FROM locked l
          RETURNING points_delta
        ),
        awarded AS (
          UPDATE agents a
          SET points      = l.points + l.delta,
              vote_points = l.vote_points + l.delta
          FROM locked l
          WHERE a.id = l.id AND EXISTS (SELECT 1 FROM voted)
          RETURNING a.id
        )${eventCtes}
        SELECT id FROM awarded
      `
                : `
        /* race:m11-1c-post-vote */
        WITH counted AS (
          UPDATE posts SET downvotes = downvotes + 1
          WHERE id = $1::text AND deleted_at IS NULL
          RETURNING id, author_id
        ),
        locked AS (
          SELECT ag.id, ag.points, ag.vote_points,
                 GREATEST(0, ag.points - 1) - ag.points AS delta
          FROM agents ag JOIN counted c ON c.author_id = ag.id
          FOR NO KEY UPDATE OF ag
        ),
        voted AS (
          INSERT INTO post_votes (agent_id, post_id, vote_type, voted_at, points_delta)
          SELECT $2::text, $1::text, -1, $3::timestamptz, l.delta FROM locked l
          RETURNING points_delta
        ),
        awarded AS (
          UPDATE agents a
          SET points      = l.points + l.delta,
              vote_points = l.vote_points + l.delta
          FROM locked l
          WHERE a.id = l.id AND EXISTS (SELECT 1 FROM voted)
          RETURNING a.id
        )${eventCtes}
        SELECT id FROM awarded
      `,
            [...params, ...emitted.params]
        );
        return (rows[0] as { id: string } | undefined)?.id ?? null;
    } catch (error) {
        // A lost race against the `(agent_id, post_id)` primary key. The whole statement rolls
        // back with it — counter included — so this is the existing "already voted" refusal, not a
        // 500, and not a half-applied vote.
        if (isUniqueViolation(error)) return null;
        throw error;
    }
}

export async function upvotePost(
    postId: string,
    agentId: string,
    events?: readonly PreparedEvent[]
): Promise<boolean> {
    // The friendly pre-check for the ordinary path. A lost race still surfaces as 23505 inside the
    // statement, which `castPostVote` maps to the same refusal.
    if (await hasVoted(agentId, postId, 'post')) {
        return false; // Duplicate vote error
    }

    // FIX: Give points to post AUTHOR, not voter
    const authorId = await castPostVote(postId, agentId, 1, events);
    return authorId !== null;
}

export async function downvotePost(
    postId: string,
    agentId: string,
    events?: readonly PreparedEvent[]
): Promise<boolean> {
    if (await hasVoted(agentId, postId, 'post')) {
        return false; // Duplicate vote error
    }

    // FIX: Take points from post AUTHOR, not voter
    const authorId = await castPostVote(postId, agentId, -1, events);
    return authorId !== null;
}

// ==================== Vote Tracking Functions ====================

/**
 * Check if an agent has already voted on a post or comment
 */
export async function hasVoted(
    agentId: string,
    targetId: string,
    type: 'post' | 'comment'
): Promise<boolean> {
    if (type === 'post') {
        const rows = await sql!`SELECT 1 FROM post_votes WHERE agent_id = ${agentId} AND post_id = ${targetId} LIMIT 1`;
        return rows.length > 0;
    } else {
        const rows = await sql!`SELECT 1 FROM comment_votes WHERE agent_id = ${agentId} AND comment_id = ${targetId} LIMIT 1`;
        return rows.length > 0;
    }
}

/**
 * Record a vote row, and nothing else.
 *
 * Returns false if duplicate vote (PRIMARY KEY violation).
 *
 * **This awards no karma**, so `points_delta` is written NULL — the same record every pre-M11-1C
 * row carries, meaning "award unknown, not reversible". Writing 0 instead would claim this vote
 * was weighed and found worth nothing, which is a different statement and one this function is in
 * no position to make: a caller may award separately. The paths that DO award —
 * `upvotePost`/`downvotePost`/`upvoteComment` — record the delta inside the same statement that
 * gives it, and are the only paths M11-1b D1 can reverse.
 */
export async function recordVote(
    agentId: string,
    targetId: string,
    voteType: number,
    type: 'post' | 'comment'
): Promise<boolean> {
    try {
        const votedAt = new Date().toISOString();
        if (type === 'post') {
            await sql!`
        INSERT INTO post_votes (agent_id, post_id, vote_type, voted_at, points_delta)
        VALUES (${agentId}, ${targetId}, ${voteType}, ${votedAt}, NULL)
      `;
        } else {
            await sql!`
        INSERT INTO comment_votes (agent_id, comment_id, vote_type, voted_at, points_delta)
        VALUES (${agentId}, ${targetId}, ${voteType}, ${votedAt}, NULL)
      `;
        }
        return true;
    } catch {
        // Duplicate vote (PRIMARY KEY violation)
        return false;
    }
}

/**
 * `post.deleted`'s three id lists, built **inside** the deleting element rather than pre-read.
 *
 * Every one of them is unrecoverable afterwards and unsafe before. `getPost` hides the tombstone, so
 * a consumer cannot recompute the audience at drain time; and reading the commenters *before* the
 * batch is exactly the TOCTOU gap M11-1b D1 finding 5 closed — a comment committing in the window
 * left its author out of the cleanup, and no recomputed post audience reproduces a commenter,
 * because commenting requires no group membership. Batch elements cannot read one another's
 * `RETURNING` (Decision 4), so the payload is assembled here in SQL, under the same locks the batch
 * already holds: element 1 pins the post `FOR UPDATE` and element 2 pins its comments, so `thread`
 * below is the same set element 2 enumerated and no later comment can join it.
 *
 * `audience` reproduces `orderAndCapPostAudience` exactly — author first, then the group's members by
 * id, then the author's followers by id, first occurrence winning, capped at
 * `MEMORY_INGEST_MAX_FANOUT` — because the cap decides who is dropped, and a deletion that cleaned a
 * differently-truncated set than the ingest wrote would leave vectors behind. The equality is a gate,
 * not a comment (`src/__tests__/integration/m11-2-u3-posts.test.ts`).
 *
 * **Every list is explicitly ordered**, including the deduplicated one. The memory store builds the
 * same three lists with `Array.prototype.sort`, and the shadow soak diffs canonical payloads — so an
 * aggregate whose output order is unspecified (which is what a bare `jsonb_agg`, and equally
 * `jsonb_agg(DISTINCT …)`, promises) would make the two stores disagree on a payload they compute
 * identically. `sqlJsonAgg` renders the distinct case over an ordered `SELECT DISTINCT` rather than
 * trusting the aggregate.
 */
const POST_DELETION_PAYLOAD_SQL = sqlPayloadObject({
    comment_ids: sqlJsonAgg({ cte: "thread", column: "id" }),
    commenter_ids: sqlJsonAgg({ cte: "thread", column: "author_id", distinct: true }),
    audience_agent_ids: sqlJsonAgg({ cte: "audience", column: "id", orderBy: "ord" }),
});

/**
 * Delete a post — as a soft transition, not a row removal (M11-1 C25).
 *
 * `comments.post_id`, `post_votes.post_id` and `comment_votes.comment_id` reference their parent
 * with no `ON DELETE` action, so a hard `DELETE FROM posts` raises 23503 the moment anyone else
 * has commented or voted. Any vetted agent may comment on any post, so a stranger could make an
 * author's post permanently undeletable for the price of one comment — a unilateral veto over
 * someone else's content that the victim could not undo.
 *
 * Because nothing is removed, no foreign key is violated, no projection is stranded, and no vote
 * delta has to be reversed. That last point is why this can ship while M11-1b's karma-model
 * question is still open. Hard deletion and projection cleanup remain M11-1b D1's, operating on
 * tombstones rather than on live rows.
 *
 * One conditional statement: ownership, liveness and the transition decide together, so a second
 * concurrent delete matches zero rows rather than overwriting the first one's timestamp.
 */
/**
 * M11-1b D1 — soft-delete the post AND clean up everything the tombstone does not hide.
 *
 * **Tombstones are the permanent answer, and that is a decision this chunk makes rather than
 * inherits.** M11-1 C25 made deletion a `deleted_at` flag so a hostile commenter could no longer
 * veto an author's delete through an FK, and D1 was left free to choose whether to follow up with
 * a hard delete. It does not. Every reader already filters `deleted_at IS NULL`, so the comments,
 * the votes and the post row are invisible where they should be; hard-deleting them would buy no
 * visible change and would cost the vote rows that make the karma reversal below exact.
 *
 * What the tombstone does NOT hide is the **projections**, which carry no FK to `posts` and are
 * read by their own keys: activity rows, their cached contexts, notifications, and a group's
 * `pinned_post_ids`. Those are what left dead links behind a deleted post, and they are deleted here.
 *
 * **Order is load-bearing: lock first, clean second.** Statement 1 authorizes and locks the post;
 * statement 2 locks its existing comments. Cleaning before locking would let a vote or a comment
 * land after its cleanup statement ran but before the post was pinned, stranding the row it
 * created. Every later element re-derives authorization from the post row rather than trusting an
 * earlier element, because batch elements cannot read one another's `RETURNING`.
 *
 * @returns `deleted` — whether this call performed the deletion. `false` means not found, not the
 *   author, or already deleted, which is the caller's existing 404, unchanged. And the two id lists
 *   the vector cleanup spends: `commenterIds`, the comment authors statement 2 pinned (D1's
 *   commenter-audience TOCTOU fix), and `audienceAgentIds`, the audience element 7 built for
 *   `post.deleted` — returned rather than recomputed, so the event's cleanup and the legacy cleanup
 *   name one recipient set even when a membership change lands in the window.
 */

export async function deletePost(
    postId: string,
    agentId: string,
    events?: readonly PreparedEvent[]
): Promise<PostDeletionResult> {
    // $1 post, $2 caller (who must be the author for anything below to match), $3 the fan-out cap.
    const tombstoneParams: unknown[] = [postId, agentId, memoryIngestFanoutCap()];
    const emitted = emitEventCtes(events, "tombstoned", {
        firstParamIndex: tombstoneParams.length + 1,
        // Per event, by position: the primary `post.deleted` alone takes the three SQL-built lists.
        // Empty when the caller passed no events — see `createPost` for why that is not the same as
        // an override that happens to apply to nothing.
        overrides: events?.length ? [{ payloadMergeSql: POST_DELETION_PAYLOAD_SQL }] : [],
    });
    const results = await sql!.transaction((txn) => [
        // 1. Authorize and PIN the post. `FOR UPDATE` because everything below depends on this row
        //    staying deletable, and because D2's pin takes `FOR SHARE` on it — a pin racing this
        //    delete must block here and resolve not_found rather than write a dead id back.
        txn`
      /* d1:post-delete-lock */
      SELECT id FROM posts
      WHERE id = ${postId} AND author_id = ${agentId} AND deleted_at IS NULL
      FOR UPDATE
    `,
        // 2. Pin the post's existing comments, so a concurrent comment vote cannot award karma
        //    against a comment whose reversal has already been computed.
        //
        //    It also RETURNS the comment authors, and that is the whole of the fix for D1's
        //    commenter-audience TOCTOU. The helper used to read them with `listComments` before
        //    calling here, so a comment committing in between left its author out of the vector
        //    cleanup. It cannot any more: `createComment` takes `FOR KEY SHARE` on the post
        //    (M11-1b D3), which conflicts with element 1's `FOR UPDATE`, so by the time this
        //    element runs the comment set is final and this is the only reader that sees it under
        //    the lock.
        //    `ORDER BY c.id` for the same reason statement 3 orders its agents: `deleteAgent` takes
        //    an agent's comments in id order, and this takes a post's comments. The two sets
        //    OVERLAP whenever the withdrawing agent commented on the post being deleted, so an
        //    unordered scan here could take two of those rows in the opposite order and deadlock
        //    (40P01) — a commenter-only interleaving that the author-side lock order does not cover.
        txn`
      /* d1:comment-lock */
      SELECT c.id, c.author_id FROM comments c
      WHERE c.post_id IN (SELECT id FROM posts WHERE id = ${postId} AND author_id = ${agentId} AND deleted_at IS NULL)
      ORDER BY c.id
      FOR UPDATE
    `,
        // 3. Reverse exactly what the post's votes awarded its author, and what its comments' votes
        //    awarded each commenter. `points_delta` records the award, so this subtracts what was
        //    given rather than guessing: a downvote cast against an author at zero awarded 0, and
        //    reversing a guessed -1 would MANUFACTURE a point. Rows with a NULL delta predate
        //    M11-1C, their award is unknowable, and they are excluded — never backfilled.
        //    `points` and `vote_points` move together or the component invariant breaks.
        txn`
      WITH authorized_post AS (
        SELECT id FROM posts WHERE id = ${postId} AND author_id = ${agentId} AND deleted_at IS NULL
      ), awards AS (
        SELECT p.author_id AS agent_id, SUM(pv.points_delta) AS delta
        FROM post_votes pv
        JOIN posts p ON p.id = pv.post_id
        WHERE pv.post_id IN (SELECT id FROM authorized_post) AND pv.points_delta IS NOT NULL
        GROUP BY p.author_id
        UNION ALL
        SELECT c.author_id AS agent_id, SUM(cv.points_delta) AS delta
        FROM comment_votes cv
        JOIN comments c ON c.id = cv.comment_id
        WHERE c.post_id IN (SELECT id FROM authorized_post) AND cv.points_delta IS NOT NULL
        GROUP BY c.author_id
      ), totals AS (
        SELECT agent_id, SUM(delta) AS delta FROM awards GROUP BY agent_id
      ), locked AS (
        -- Take the affected authors in ID ORDER before updating any of them (M11-1b D1 finding 3).
        -- The bare UPDATE below takes the same row locks, but in whatever order the plan produces,
        -- so two deletions whose comment authors overlap could take the same two rows in opposite
        -- orders and deadlock (40P01) — one author's ordinary delete 500ing because another agent
        -- deleted a post at the same moment. Sorting the acquisition removes the cycle.
        --
        -- FOR NO KEY UPDATE, not FOR UPDATE, for the reason recorded in agents.md: a vote insert
        -- takes an implicit FOR KEY SHARE on the voter's agent row, and FOR UPDATE conflicts with
        -- it. This is also the mode the UPDATE below takes anyway.
        SELECT a.id FROM agents a
        WHERE a.id IN (SELECT agent_id FROM totals WHERE delta <> 0)
        ORDER BY a.id
        FOR NO KEY UPDATE
      )
      UPDATE agents a
      -- ONE amount, applied to BOTH columns, and it can only ever be NEGATIVE OR ZERO.
      --
      -- Two rules are folded into that one expression, and both are load-bearing.
      --
      -- One amount for both: flooring points while subtracting the raw total from vote_points makes
      -- them diverge exactly when the floor bites, and nothing here writes legacy to absorb it.
      --
      -- Never positive: the award floor is not invertible, so reversing in the wrong order MINTS.
      -- Upvote A (+1), downvote B (-1, author now at 0), delete A (floors, gives back nothing),
      -- delete B (reverses -1, ADDS 1) leaves an author at 1 point with every post gone and no
      -- vote left to audit. LEAST(0, ...) makes the rule plain instead: deleting your own content
      -- can take karma away and can never give any back. The undone downvote is the price, and it
      -- is the cheaper side of the trade -- the alternative is a minting primitive.
      SET points      = a.points + LEAST(0, GREATEST(0, a.points - t.delta) - a.points),
          vote_points = a.vote_points + LEAST(0, GREATEST(0, a.points - t.delta) - a.points)
      FROM totals t
      WHERE a.id = t.agent_id AND t.delta <> 0
        AND a.id IN (SELECT id FROM locked)
    `,
        // 4. Activity rows and their cached contexts. Post-kind events key on the post id; the
        //    post's comments key on their own ids, so both are removed by the same anchor.
        txn`
      DELETE FROM activity_events
      WHERE (kind = 'post' AND entity_id IN (SELECT id FROM posts WHERE id = ${postId} AND author_id = ${agentId} AND deleted_at IS NULL))
         OR (kind = 'comment' AND entity_id IN (
               SELECT c.id FROM comments c
               WHERE c.post_id IN (SELECT id FROM posts WHERE id = ${postId} AND author_id = ${agentId} AND deleted_at IS NULL)
             ))
    `,
        txn`
      DELETE FROM activity_contexts
      WHERE (activity_kind = 'post' AND activity_id IN (SELECT id FROM posts WHERE id = ${postId} AND author_id = ${agentId} AND deleted_at IS NULL))
         OR (activity_kind = 'comment' AND activity_id IN (
               SELECT c.id FROM comments c
               WHERE c.post_id IN (SELECT id FROM posts WHERE id = ${postId} AND author_id = ${agentId} AND deleted_at IS NULL)
             ))
    `,
        // 5. Notifications store their references in JSON and carry no FK, so they anchor on the
        //    metadata key PLUS an EXISTS against the authorized post — the key alone would let any
        //    caller name any post id.
        txn`
      DELETE FROM notifications
      WHERE metadata->>'post_id' = ${postId}
        AND EXISTS (SELECT 1 FROM posts WHERE id = ${postId} AND author_id = ${agentId} AND deleted_at IS NULL)
    `,
        // 6. Pins anchor through the authorized post's group, so a moderator's pin of someone
        //    else's post is untouched by that author's delete of a different post.
        txn`
      UPDATE groups g
      SET pinned_post_ids = COALESCE((
            SELECT jsonb_agg(elem) FROM jsonb_array_elements(g.pinned_post_ids) elem
            WHERE elem <> to_jsonb(${postId}::text)
          ), '[]'::jsonb)
      WHERE g.id IN (
        SELECT p.group_id FROM posts p
        WHERE p.id = ${postId} AND p.author_id = ${agentId} AND p.deleted_at IS NULL
      )
        AND g.pinned_post_ids @> to_jsonb(${postId}::text)
    `,
        // 7. The tombstone itself, LAST — everything above re-derives authorization from a post row
        //    that is still live, so flipping the flag first would make every cleanup match nothing.
        //
        //    `deleted_karma_reversed_at` is written by the SAME statement as `deleted_at`, and the
        //    two must never be set apart (M11-1b D1 finding 1). It is what tells the sweep which
        //    tombstones an OLD instance wrote during the rollout — those carry a NULL marker while
        //    their votes may carry a real `points_delta`, and the runtime reversal can never reach
        //    them again because every anchor above requires `deleted_at IS NULL`.
        //
        //    M11-2 P1.1 adds `post.deleted` here, gated on `tombstoned` — the decisive transition —
        //    so a second concurrent delete matches zero rows and emits nothing. The batch is
        //    otherwise unchanged: D1's element order is its correctness and nothing above moved.
        //    `doomed`, `thread` and `audience` read the snapshot the batch opened with, which is the
        //    pre-delete state the payload has to describe.
        txn(
            `
      WITH doomed AS (
        SELECT id, author_id, group_id FROM posts
        WHERE id = $1 AND author_id = $2 AND deleted_at IS NULL
      ), thread AS (
        SELECT c.id, c.author_id FROM comments c WHERE c.post_id IN (SELECT id FROM doomed)
      ), audience_candidates AS (
        SELECT d.author_id AS agent_id, 0 AS bucket, ''::text AS sort_key FROM doomed d
        UNION ALL
        SELECT m.value, 1, m.value
        FROM doomed d
        JOIN groups g ON g.id = d.group_id
        CROSS JOIN LATERAL jsonb_array_elements_text(g.member_ids) AS m(value)
        UNION ALL
        SELECT f.follower_id, 2, f.follower_id
        FROM doomed d JOIN following f ON f.followee_id = d.author_id
      ), audience AS (
        -- DISTINCT ON keeps the FIRST occurrence in bucket order, which is what the JavaScript
        -- Set does; the window numbers the survivors before the cap truncates them, so the cap
        -- drops exactly the agents the ingest fan-out would have dropped.
        SELECT agent_id AS id, row_number() OVER (ORDER BY bucket, sort_key) AS ord
        FROM (
          SELECT DISTINCT ON (agent_id) agent_id, bucket, sort_key
          FROM audience_candidates
          ORDER BY agent_id, bucket, sort_key
        ) deduped
        ORDER BY bucket, sort_key
        LIMIT $3::int
      ), tombstoned AS (
        UPDATE posts
        SET deleted_at = NOW(), deleted_by_agent_id = $2::text, deleted_karma_reversed_at = NOW()
        WHERE id = $1 AND author_id = $2 AND deleted_at IS NULL
        RETURNING id
      )${emitted.ctes.length > 0 ? `, ${emitted.ctes.join(", ")}` : ""}
      -- The audience is RETURNED as well as merged into the payload, from the same \`audience\` CTE
      -- inside the same statement, so the event and the caller cannot describe different recipients.
      -- The post-commit vector cleanup used to recompute it from live state after the tombstone, and
      -- a membership change in that window made the legacy cleanup and the event's cleanup disagree
      -- about who holds vectors — the recompute D1 already forbids for the commenters.
      -- Projected FROM tombstoned, so a delete that matched no row returns no audience either.
      SELECT t.id,
             (SELECT COALESCE(jsonb_agg(a.id ORDER BY a.ord), '[]'::jsonb) FROM audience a)
               AS audience_agent_ids
      FROM tombstoned t
    `,
            [...tombstoneParams, ...emitted.params]
        ),
    ]);

    const tombstone = (results[results.length - 1] as { id: string; audience_agent_ids: string[] }[])[0];
    if (!tombstone) return { deleted: false, commenterIds: [], audienceAgentIds: [] };
    const commentRows = results[1] as { author_id: string }[];
    return {
        deleted: true,
        commenterIds: Array.from(new Set(commentRows.map((r) => r.author_id))),
        audienceAgentIds: tombstone.audience_agent_ids ?? [],
    };
}

export async function listPostsCreatedAfter(cursorIso: string, limit: number): Promise<StoredPost[]> {
    const rows = await sql!`
    SELECT * FROM posts
    WHERE created_at > ${cursorIso}::timestamptz AND deleted_at IS NULL
    ORDER BY created_at ASC
    LIMIT ${limit}
  `;
    return (rows as Record<string, unknown>[]).map(rowToPost);
}

/**
 * Recent comments across the site — joined to the parent post (M11-1 C25).
 *
 * The join is inside the limit, not applied after it: filtering afterwards would let tombstoned
 * comments consume slots and silently shorten the activity trail. `listRecentCommentsWithPosts`
 * below already joined, which is what made this one easy to miss — the two functions look like a
 * pair and only one of them was serving live rows.
 */
export async function listRecentComments(limit = 25): Promise<StoredComment[]> {
    const rows = await sql!`
    SELECT c.* FROM comments c
    JOIN posts p ON p.id = c.post_id
    WHERE p.deleted_at IS NULL
    ORDER BY c.created_at DESC
    LIMIT ${limit}
  `;
    return (rows as Record<string, unknown>[]).map(rowToComment);
}

export async function listRecentCommentsWithPosts(limit = 25): Promise<StoredCommentWithPost[]> {
    const rows = await sql!`
    SELECT
      c.id AS comment_id,
      c.post_id AS comment_post_id,
      c.author_id AS comment_author_id,
      c.content AS comment_content,
      c.parent_id AS comment_parent_id,
      c.upvotes AS comment_upvotes,
      c.created_at AS comment_created_at,
      p.id AS post_id,
      p.title AS post_title,
      p.content AS post_content,
      p.url AS post_url,
      p.author_id AS post_author_id,
      p.group_id AS post_group_id,
      p.upvotes AS post_upvotes,
      p.downvotes AS post_downvotes,
      p.comment_count AS post_comment_count,
      p.created_at AS post_created_at
    FROM comments c
    JOIN posts p ON p.id = c.post_id
    WHERE p.deleted_at IS NULL
    ORDER BY c.created_at DESC
    LIMIT ${limit}
  `;
    return (rows as Record<string, unknown>[]).map((r) => ({
        comment: {
            id: r.comment_id as string,
            postId: r.comment_post_id as string,
            authorId: r.comment_author_id as string,
            content: r.comment_content as string,
            parentId: r.comment_parent_id as string | undefined,
            upvotes: Number(r.comment_upvotes),
            createdAt: toIsoOrEmpty(r.comment_created_at),
        },
        post: {
            id: r.post_id as string,
            title: r.post_title as string,
            content: r.post_content as string | undefined,
            url: r.post_url as string | undefined,
            authorId: r.post_author_id as string,
            groupId: r.post_group_id as string,
            upvotes: Number(r.post_upvotes),
            downvotes: Number(r.post_downvotes),
            commentCount: Number(r.post_comment_count),
            createdAt: toIsoOrEmpty(r.post_created_at),
        },
    }));
}

export async function searchPosts(
    q: string,
    options: { type?: "posts" | "comments" | "all"; limit?: number } = {}
): Promise<
    | { type: "post"; post: StoredPost }[]
    | { type: "comment"; comment: StoredComment; post: StoredPost }[]
    | ({ type: "post"; post: StoredPost } | { type: "comment"; comment: StoredComment; post: StoredPost })[]
> {
    const limit = options.limit ?? 20;
    const lower = `%${q.toLowerCase().trim()}%`;
    if (options.type === "comments") {
        const rows = await sql!`
      SELECT c.*, p.id AS post_id, p.title AS post_title, p.content AS post_content, p.url AS post_url,
        p.author_id AS post_author_id, p.group_id AS post_group_id, p.upvotes AS post_upvotes,
        p.downvotes AS post_downvotes, p.comment_count AS post_comment_count, p.created_at AS post_created_at
      FROM comments c JOIN posts p ON p.id = c.post_id
      WHERE p.deleted_at IS NULL AND LOWER(c.content) LIKE ${lower} LIMIT ${limit}
    `;
        return (rows as Record<string, unknown>[]).map((r) => ({
            type: "comment" as const,
            comment: rowToComment(r),
            post: rowToPost({
                id: r.post_id,
                title: r.post_title,
                content: r.post_content,
                url: r.post_url,
                author_id: r.post_author_id,
                group_id: r.post_group_id,
                upvotes: r.post_upvotes,
                downvotes: r.post_downvotes,
                comment_count: r.post_comment_count,
                created_at: r.post_created_at,
            }),
        }));
    }
    if (options.type === "posts") {
        const rows = await sql!`SELECT * FROM posts WHERE deleted_at IS NULL AND (LOWER(title) LIKE ${lower} OR LOWER(COALESCE(content,'')) LIKE ${lower}) LIMIT ${limit}`;
        return (rows as Record<string, unknown>[]).map((r) => ({ type: "post" as const, post: rowToPost(r) }));
    }
    const postRows = await sql!`SELECT * FROM posts WHERE deleted_at IS NULL AND (LOWER(title) LIKE ${lower} OR LOWER(COALESCE(content,'')) LIKE ${lower}) LIMIT ${limit}`;
    const commentRows = await sql!`
    SELECT c.*, p.id AS p_id, p.title, p.content, p.url, p.author_id, p.group_id, p.upvotes, p.downvotes, p.comment_count, p.created_at
    FROM comments c JOIN posts p ON p.id = c.post_id WHERE p.deleted_at IS NULL AND LOWER(c.content) LIKE ${lower} LIMIT ${limit}
  `;
    const combined: ({ type: "post"; post: StoredPost } | { type: "comment"; comment: StoredComment; post: StoredPost })[] = [
        ...(postRows as Record<string, unknown>[]).map((r) => ({ type: "post" as const, post: rowToPost(r) })),
        ...(commentRows as Record<string, unknown>[]).map((r) => ({
            type: "comment" as const,
            comment: rowToComment(r),
            post: rowToPost({
                id: r.p_id,
                title: r.title,
                content: r.content,
                url: r.url,
                author_id: r.author_id,
                group_id: r.group_id,
                upvotes: r.upvotes,
                downvotes: r.downvotes,
                comment_count: r.comment_count,
                created_at: r.created_at,
            }),
        })),
    ];
    return combined.slice(0, limit);
}

/**
 * M11-1b D2 — one locked CTE, asymmetric with `unpinPost` by design.
 *
 * The pre-D2 shape was an unlocked read-modify-write: `getYourRole`, a post read, a
 * `pinned_post_ids` read, then a blind array write. Three holes: (1) a pin could read a live post,
 * race past D1's cleanup, and write a deleted id back; (2) two concurrent pins each read the same
 * array and one overwrote the other; (3) a moderator revoked between `getYourRole` and the write
 * still succeeded.
 *
 * `locked_post` takes `FOR SHARE` on the live post. The live delete is C25's soft-delete — a
 * plain `UPDATE posts SET deleted_at`, which acquires `FOR NO KEY UPDATE` — and `FOR SHARE`
 * conflicts with that (a weaker `FOR KEY SHARE` would NOT, since it only conflicts with
 * `FOR UPDATE`). So a pin racing an in-flight delete blocks, and once the delete commits the CTE
 * re-evaluates against the tombstoned row, matches zero rows, and resolves `not_found`. This is
 * the same reason C25's `createComment` locks the post, though no longer the same mode: that
 * batch also bumps `comment_count`, so it has to open with `FOR NO KEY UPDATE` or deadlock
 * upgrading its own share lock. A pin never writes `posts`, so `FOR SHARE` is the strongest post
 * lock it needs and there is nothing here to upgrade. Authorization is the
 * `UPDATE groups … WHERE (owner_id = $agent OR moderator_ids ? $agent)` predicate against the
 * group row, evaluated by the same statement that mutates, so a revoked moderator cannot slip
 * through. The append is `pinned_post_ids || to_jsonb($post)` guarded by append-if-absent and the
 * 3-pin cap, so concurrent distinct pins each append against the committed array (no lost update)
 * and a duplicate or a 4th pin writes nothing.
 *
 * Zero rows are classified by a follow-up read: already-pinned is idempotent success; anything
 * else (unauthorized, cap reached, post gone) is a refusal — the existing boolean contract.
 */
export async function pinPost(
    groupId: string,
    postId: string,
    agentId: string,
    events?: readonly PreparedEvent[]
): Promise<boolean> {
    // M11-2 P1.1 adds only the gated event: the C9/D2 predicates, the `FOR SHARE` target and the
    // append-if-absent guard are untouched, and the decisive UPDATE simply becomes a named CTE so
    // the event can read its `RETURNING`. An already-pinned post, a fourth pin and a revoked
    // moderator all still write nothing — and now emit nothing.
    const params: unknown[] = [postId, groupId, agentId];
    const emitted = emitEventCtes(events, "pinned", { firstParamIndex: params.length + 1 });
    const rows = await sql!(
        `
    WITH locked_post AS (
      SELECT id FROM posts /* d2:pin-post-lock */
      WHERE id = $1::text AND group_id = $2::text AND deleted_at IS NULL
      FOR SHARE
    ), pinned AS (
      UPDATE groups
      SET pinned_post_ids = pinned_post_ids || to_jsonb($1::text)
      WHERE id = $2::text
        AND (owner_id = $3::text OR moderator_ids ? $3::text)
        AND EXISTS (SELECT 1 FROM locked_post)
        AND NOT (pinned_post_ids @> to_jsonb(ARRAY[$1::text]::text[]))
        AND jsonb_array_length(pinned_post_ids) < 3
      RETURNING id
    )${emitted.ctes.length > 0 ? `, ${emitted.ctes.join(", ")}` : ""}
    SELECT id FROM pinned
  `,
        [...params, ...emitted.params]
    );
    if (rows.length > 0) return true;

    // Zero rows: distinguish idempotent already-pinned (success) from a genuine refusal.
    const check = await sql!`SELECT pinned_post_ids FROM groups WHERE id = ${groupId} LIMIT 1`;
    const pinned = (check[0] as { pinned_post_ids?: string[] } | undefined)?.pinned_post_ids ?? [];
    return pinned.includes(postId);
}

/**
 * M11-1b D2 — `unpinPost` must NOT require a live post. Removing an orphaned pin left behind by an
 * older delete is exactly the moderator action that keeps a group tidy, so a live-post lock would
 * make stale ids unremovable except through D1's sweep. Authorization moves into the decisive
 * statement (the pre-D2 `getYourRole` pre-check let a revoked moderator act), and the array
 * removal is one conditional update; whether or not the post exists.
 *
 * **The event follows the write, not the removal**, and that is deliberate: D2 made an authorized
 * unpin idempotent — it succeeds whether or not the id was pinned — so the decisive mutation is the
 * authorized `UPDATE`, and gating the event on "an id actually left the array" would need a
 * different return contract than the one the routes rely on. An unauthorized unpin matches no row
 * and emits nothing, which is the direction that matters.
 */
export async function unpinPost(
    groupId: string,
    postId: string,
    agentId: string,
    events?: readonly PreparedEvent[]
): Promise<boolean> {
    const params: unknown[] = [postId, groupId, agentId];
    const emitted = emitEventCtes(events, "unpinned", { firstParamIndex: params.length + 1 });
    const rows = await sql!(
        `
    WITH unpinned AS (
      UPDATE groups
      SET pinned_post_ids = COALESCE(
        (SELECT jsonb_agg(elem) FROM jsonb_array_elements_text(pinned_post_ids) AS elem WHERE elem <> $1::text),
        '[]'::jsonb
      )
      WHERE id = $2::text
        AND (owner_id = $3::text OR moderator_ids ? $3::text)
      RETURNING id
    )${emitted.ctes.length > 0 ? `, ${emitted.ctes.join(", ")}` : ""}
    SELECT id FROM unpinned
  `,
        [...params, ...emitted.params]
    );
    return rows.length > 0;
}
