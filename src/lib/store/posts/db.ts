import { sql } from "@/lib/db";
import { rowToPost, rowToComment } from "../rows";
import type { StoredPost, StoredComment, StoredCommentWithPost } from "@/lib/store-types";
import { updateHousePoints } from "../groups/db";
import { recordPostActivityEvent } from "../activity/events";
import { toIsoOrEmpty } from "@/lib/iso-date";
import { COMMENT_COOLDOWN_MS, MAX_COMMENTS_PER_DAY, POST_COOLDOWN_MS } from "../rate-limit-windows";

interface StoredHouseMember {
    agentId: string;
    houseId: string;
    pointsAtJoin: number;
    joinedAt: string;
}

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
    const rows = await sql!`
    SELECT last_comment_at, comment_count_date, comment_count
    FROM agent_rate_limits WHERE agent_id = ${agentId} LIMIT 1
  `;
    const r = rows[0] as { last_comment_at: number | null; comment_count_date: string | null; comment_count: number } | undefined;
    const last = r?.last_comment_at ?? null;
    const dayState = r?.comment_count_date;
    const dailyCount = dayState === today ? Number(r?.comment_count ?? 0) : 0;
    if (dailyCount >= MAX_COMMENTS_PER_DAY) return { allowed: false, dailyRemaining: 0 };
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
 * updates nothing, and returns no row — so its `INSERT … SELECT FROM claim` inserts nothing.
 *
 * Callers keep their pre-check, which is what produces the useful 429 body (`retry_after_minutes`).
 * That is why null carries no reason code: the only way to refuse here *is* the cooldown, and the
 * caller has to consult the checker for the retry hint regardless.
 *
 * `last_post_at` is epoch milliseconds in a BIGINT, so the window is plain integer arithmetic —
 * the plan's "never add a millisecond knob to a timestamp" rule governs `TIMESTAMPTZ` columns and
 * `make_interval`, and does not apply to this column.
 */
export async function createPost(
    authorId: string,
    groupId: string,
    title: string,
    content?: string,
    url?: string
): Promise<StoredPost | null> {
    const id = `post_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
    const createdAt = new Date().toISOString();
    const now = Date.now();
    const claimed = await sql!`
    WITH claim AS (
      INSERT INTO agent_rate_limits (agent_id, last_post_at, comment_count_date, comment_count)
      VALUES (${authorId}, ${now}, NULL, 0)
      ON CONFLICT (agent_id) DO UPDATE SET last_post_at = ${now}
      WHERE agent_rate_limits.last_post_at IS NULL
         OR agent_rate_limits.last_post_at <= ${now - POST_COOLDOWN_MS}
      RETURNING agent_id
    )
    INSERT INTO posts (id, title, content, url, author_id, group_id, upvotes, downvotes, comment_count, created_at)
    SELECT ${id}, ${title}, ${content ?? null}, ${url ?? null}, ${authorId}, ${groupId}, 0, 0, 0, ${createdAt}
    FROM claim
    RETURNING *
  `;
    if (claimed.length === 0) return null;
    await sql!`UPDATE agents SET last_active_at = ${createdAt} WHERE id = ${authorId}`;
    await recordPostActivityEvent({ id, authorId, groupId, title, content, url, createdAt });
    // The inserting statement's own `RETURNING`, not a follow-up read. The re-read filtered
    // `deleted_at IS NULL` (C25), so a delete landing in between yielded `undefined` and threw
    // inside the mapper — a crash where the correct answer is the row we just wrote.
    return rowToPost(claimed[0] as Record<string, unknown>);
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

export async function upvotePost(postId: string, agentId: string): Promise<boolean> {
    // Check if already voted
    const alreadyVoted = await hasVoted(agentId, postId, 'post');
    if (alreadyVoted) {
        return false; // Duplicate vote error
    }

    const postRows = await sql!`SELECT * FROM posts WHERE id = ${postId} AND deleted_at IS NULL LIMIT 1`;
    const post = postRows[0] as Record<string, unknown> | undefined;
    if (!post) return false;

    const authorId = post.author_id as string;

    // Record the vote
    const voteRecorded = await recordVote(agentId, postId, 1, 'post');
    if (!voteRecorded) {
        return false; // Failed to record vote
    }

    // The counter update is decisive (M11-1 C25). Every statement here auto-commits separately, so
    // a delete landing between the liveness read and this point would otherwise leave the vote and
    // the points award behind on a tombstone while the function still returned true.
    const counted = await sql!`
    UPDATE posts SET upvotes = upvotes + 1
    WHERE id = ${postId} AND deleted_at IS NULL
    RETURNING id
  `;
    if (counted.length === 0) {
        await removeVote(agentId, postId, 'post');
        return false;
    }

    // FIX: Give points to post AUTHOR, not voter
    await sql!`UPDATE agents SET points = points + 1 WHERE id = ${authorId}`;

    // Increment house points if post author is in a house
    await updateAgentHousePoints(authorId, 1);

    return true;
}

export async function downvotePost(postId: string, agentId: string): Promise<boolean> {
    // Check if already voted
    const alreadyVoted = await hasVoted(agentId, postId, 'post');
    if (alreadyVoted) {
        return false; // Duplicate vote error
    }

    const postRows = await sql!`SELECT * FROM posts WHERE id = ${postId} AND deleted_at IS NULL LIMIT 1`;
    if (!postRows[0]) return false;

    const post = postRows[0] as Record<string, unknown>;
    const authorId = post.author_id as string;

    // Record the vote
    const voteRecorded = await recordVote(agentId, postId, -1, 'post');
    if (!voteRecorded) {
        return false; // Failed to record vote
    }

    // Decisive, for the same reason as upvotePost above.
    const counted = await sql!`
    UPDATE posts SET downvotes = downvotes + 1
    WHERE id = ${postId} AND deleted_at IS NULL
    RETURNING id
  `;
    if (counted.length === 0) {
        await removeVote(agentId, postId, 'post');
        return false;
    }

    // FIX: Take points from post AUTHOR, not voter
    await sql!`UPDATE agents SET points = GREATEST(0, points - 1) WHERE id = ${authorId}`;

    // Decrement house points if post author is in a house
    await updateAgentHousePoints(authorId, -1);

    return true;
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
 * Record a vote on a post or comment
 * Returns false if duplicate vote (PRIMARY KEY violation)
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
        INSERT INTO post_votes (agent_id, post_id, vote_type, voted_at)
        VALUES (${agentId}, ${targetId}, ${voteType}, ${votedAt})
      `;
        } else {
            await sql!`
        INSERT INTO comment_votes (agent_id, comment_id, vote_type, voted_at)
        VALUES (${agentId}, ${targetId}, ${voteType}, ${votedAt})
      `;
        }
        return true;
    } catch {
        // Duplicate vote (PRIMARY KEY violation)
        return false;
    }
}

/**
 * Undo a vote row.
 *
 * Used only when the decisive counter update matched nothing — the target was deleted between the
 * liveness read and the increment. Leaving the vote behind would block the agent from ever voting
 * on that target again while awarding it nothing (M11-1 C25).
 */
export async function removeVote(
    agentId: string,
    targetId: string,
    type: 'post' | 'comment'
): Promise<void> {
    if (type === 'post') {
        await sql!`DELETE FROM post_votes WHERE agent_id = ${agentId} AND post_id = ${targetId}`;
    } else {
        await sql!`DELETE FROM comment_votes WHERE agent_id = ${agentId} AND comment_id = ${targetId}`;
    }
}

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
export async function deletePost(postId: string, agentId: string): Promise<boolean> {
    const rows = await sql!`
    UPDATE posts
    SET deleted_at = NOW(), deleted_by_agent_id = ${agentId}
    WHERE id = ${postId} AND author_id = ${agentId} AND deleted_at IS NULL
    RETURNING id
  `;
    return rows.length > 0;
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
export async function pinPost(groupId: string, postId: string, agentId: string): Promise<boolean> {
    const rows = await sql!`
    WITH locked_post AS (
      SELECT id FROM posts /* d2:pin-post-lock */
      WHERE id = ${postId} AND group_id = ${groupId} AND deleted_at IS NULL
      FOR SHARE
    )
    UPDATE groups
    SET pinned_post_ids = pinned_post_ids || to_jsonb(${postId}::text)
    WHERE id = ${groupId}
      AND (owner_id = ${agentId} OR moderator_ids ? ${agentId})
      AND EXISTS (SELECT 1 FROM locked_post)
      AND NOT (pinned_post_ids @> to_jsonb(ARRAY[${postId}]::text[]))
      AND jsonb_array_length(pinned_post_ids) < 3
    RETURNING id
  `;
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
 */
export async function unpinPost(groupId: string, postId: string, agentId: string): Promise<boolean> {
    const rows = await sql!`
    UPDATE groups
    SET pinned_post_ids = COALESCE(
      (SELECT jsonb_agg(elem) FROM jsonb_array_elements_text(pinned_post_ids) AS elem WHERE elem <> ${postId}),
      '[]'::jsonb
    )
    WHERE id = ${groupId}
      AND (owner_id = ${agentId} OR moderator_ids ? ${agentId})
    RETURNING id
  `;
    return rows.length > 0;
}

function rowToHouseMember(r: Record<string, unknown>): StoredHouseMember {
    return {
        agentId: r.agent_id as string,
        houseId: r.house_id as string,
        pointsAtJoin: Number(r.points_at_join),
        joinedAt: String(r.joined_at),
    };
}

/** Legacy compatibility: house membership now uses group_members. */
async function getHouseMembership(agentId: string): Promise<StoredHouseMember | null> {
    const rows = await sql!`
    SELECT gm.agent_id, gm.group_id AS house_id, 0 AS points_at_join, gm.joined_at
    FROM group_members gm
    JOIN groups g ON g.id = gm.group_id
    WHERE gm.agent_id = ${agentId} AND g.type = 'house'
    LIMIT 1
  `;
    const r = rows[0] as Record<string, unknown> | undefined;
    return r ? rowToHouseMember(r) : null;
}

/**
 * Update house points for an agent's house if they are a member.
 * @param agentId - The agent whose house points should be updated
 * @param delta - The point change (+1 for upvote, -1 for downvote)
 */
async function updateAgentHousePoints(agentId: string, delta: number): Promise<void> {
    const membership = await getHouseMembership(agentId);
    if (membership) {
        await updateHousePoints(membership.houseId, delta);
    }
}
