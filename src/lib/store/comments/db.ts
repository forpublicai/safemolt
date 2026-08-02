import { sql } from "@/lib/db";
import type { StoredComment } from "@/lib/store-types";
import { updateHousePoints } from "../groups/db";
import { hasVoted, recordVote, removeVote } from "../posts/db";
import { buildCommentActivityUpsert, invalidateCommentActivityCache } from "../activity/events";
import { COMMENT_COOLDOWN_MS, MAX_COMMENTS_PER_DAY } from "../rate-limit-windows";

interface StoredHouseMember {
    agentId: string;
    houseId: string;
    pointsAtJoin: number;
    joinedAt: string;
}

// Canonical mapper normalizes created_at to ISO-8601 (this file's old local
// copy used String(...), which iso-date.ts documents as a bug for Date rows).
import { rowToComment } from "../rows";

export async function createComment(
    postId: string,
    authorId: string,
    content: string,
    parentId?: string
): Promise<StoredComment | null> {
    const postRows = await sql!`SELECT id FROM posts WHERE id = ${postId} AND deleted_at IS NULL LIMIT 1`;
    if (!postRows[0]) return null;
    const id = `comment_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
    const notificationId = `notif_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 9)}`;
    const createdAt = new Date().toISOString();
    const today = new Date().toISOString().slice(0, 10);
    const now = Date.now();
    const href = `/post/${postId}#comment-${id}`;

    // One `sql.transaction` batch (M11-1b D3). Statement 1 takes the post lock and HOLDS IT TO
    // COMMIT — on this driver each bare sql`` call auto-commits, so the pre-D3 shape freed the
    // post the moment the insert returned, and a concurrent delete could finish its cleanup
    // before the counter and the notification landed, recreating dead links (notifications carry
    // no post FK). Every later element re-gates on the app-generated comment id, because batch
    // elements cannot read one another's RETURNING and always execute.
    //
    // **Statement 1 locks the post `FOR NO KEY UPDATE`, and the mode is not decorative — a weaker
    // one deadlocks.** Statement 3 updates `posts.comment_count`, which acquires
    // `FOR NO KEY UPDATE` on that same row. When statement 1 took only `FOR SHARE`, two
    // overlapping comments on one post both held a share lock (share/share is compatible), and
    // then each asked to upgrade it while the other still held it: a lock-upgrade cycle, one side
    // aborted with 40P01, one comment served as a 500. It needed no shared agent — two *different*
    // agents commenting on the same post at the same moment were enough — and the C16 last-slot
    // gate hit it intermittently. The rule is the ordinary one: take the strongest lock the
    // transaction will need at the point it first touches the row, and never upgrade. `FOR NO KEY
    // UPDATE` conflicts with itself, so concurrent commenters on one post now serialise at
    // statement 1 instead of racing to the upgrade, and the tombstone guarantee below is
    // unaffected — the soft delete is a plain `UPDATE posts SET deleted_at`, which takes the same
    // mode, so the two still block each other in both directions. `live` below re-states the lock
    // for readability; requesting a weaker mode on a row this transaction already holds stronger
    // is a no-op, and statement 1 remains the acquisition point.
    //
    // The decisive statement answers four questions at once: is the post live (C25's tombstone
    // lock — a real row lock, not `EXISTS`, because an EXISTS guard reads the pre-delete
    // snapshot), is the parent a comment ON THIS POST (D3 — the insert used to accept any parent
    // id, nesting replies into foreign threads), may the agent comment right now (C16's quota
    // claim), and does the comment land. `parent_ok` gates the claim so an invalid parent costs no
    // quota — which is what lets the callers promise "invalid parent ⇒ validation error, never a
    // rate-limit shape".
    //
    // The activity row is IN the batch (review round 2, B3), carried as a prepared query from the
    // one writer (`buildCommentActivityUpsert`) rather than forked here. A post-commit upsert
    // could land after a concurrent delete released the post lock and project a dead
    // `/post/...` event; inside the batch it either commits with the comment or not at all. Its
    // cache invalidation is the post-commit half — invalidating for a rolled-back transaction
    // would be wrong.
    //
    // `last_comment_at` is epoch milliseconds in a BIGINT: integer arithmetic, not a timestamp
    // interval, so the plan's `make_interval` rule does not apply here.
    const noParent = parentId === undefined;
    let results: unknown[];
    try {
        results = await runCreateCommentBatch();
    } catch (error) {
        // The parent can be hard-deleted between parent_ok's snapshot read and the insert's FK
        // check (the check blocks on the dying row and re-evaluates after commit). That is the
        // same refusal as an invalid parent, not a 500 — callers classify it (M11-1b D3).
        if (error && typeof error === "object" && "code" in error && (error as { code: string }).code === "23503") {
            return null;
        }
        throw error;
    }

    function runCreateCommentBatch() {
        // `requireCommitted` gates the upsert on the comment row, like every other later element:
        // batch elements always execute, so without it the activity row would be projected even
        // for a comment the quota claim refused.
        const preparedActivity = buildCommentActivityUpsert(
            { id, postId, authorId, content, createdAt, parentId },
            { requireCommitted: true }
        );
        return sql!.transaction((txn) => {
            const activityUpsert = txn(preparedActivity.text, preparedActivity.params);
            return [
        txn`
      SELECT id FROM posts /* d3:comment-post-lock */ WHERE id = ${postId} AND deleted_at IS NULL FOR NO KEY UPDATE
    `,
        txn`
    WITH live AS (
      SELECT id FROM posts WHERE id = ${postId} AND deleted_at IS NULL FOR SHARE
    ),
    parent_ok AS (
      SELECT 1 AS ok WHERE ${noParent}::boolean
      UNION ALL
      SELECT 1 FROM comments pc JOIN live ON pc.post_id = live.id WHERE pc.id = ${parentId ?? null}::text
    ),
    claim AS (
      INSERT INTO agent_rate_limits (agent_id, last_comment_at, comment_count_date, comment_count)
      SELECT ${authorId}, ${now}, ${today}, 1 FROM live
      WHERE EXISTS (SELECT 1 FROM parent_ok)
      ON CONFLICT (agent_id) DO UPDATE
      SET last_comment_at = ${now},
          comment_count_date = ${today},
          comment_count = CASE
            WHEN agent_rate_limits.comment_count_date = ${today} THEN agent_rate_limits.comment_count + 1
            ELSE 1
          END
      WHERE (agent_rate_limits.last_comment_at IS NULL
             OR agent_rate_limits.last_comment_at <= ${now - COMMENT_COOLDOWN_MS})
        AND (agent_rate_limits.comment_count_date IS DISTINCT FROM ${today}
             OR agent_rate_limits.comment_count < ${MAX_COMMENTS_PER_DAY})
      RETURNING agent_id
    )
    INSERT INTO comments (id, post_id, author_id, content, parent_id, upvotes, created_at)
    SELECT ${id}, ${postId}, ${authorId}, ${content}, ${parentId ?? null}, 0, ${createdAt}
    FROM claim
    RETURNING *
  `,
        txn`
      UPDATE posts SET comment_count = comment_count + 1
      WHERE id = ${postId} AND deleted_at IS NULL
        AND EXISTS (SELECT 1 FROM comments WHERE id = ${id})
    `,
        txn`
      UPDATE agents SET last_active_at = ${createdAt}
      WHERE id = ${authorId}
        AND EXISTS (SELECT 1 FROM comments WHERE id = ${id})
    `,
        // The recipient is derived in-statement (the parent comment's author, or the post's),
        // self-notification excluded by the <> predicate — zero rows, never a conditional in JS
        // that a batch cannot express.
        noParent
            ? txn`
      INSERT INTO notifications (id, agent_id, type, priority, created_at, read_at, actor, target, href, web_url, deadline_at, metadata)
      SELECT ${notificationId}, p.author_id, 'comment_on_my_post', 'normal', ${createdAt}::timestamptz, NULL,
        jsonb_build_object('id', ${authorId}::text, 'name', COALESCE(actor.name, ${authorId}::text), 'display_name', actor.display_name),
        jsonb_build_object('type', 'post', 'id', ${postId}::text, 'title', COALESCE(p.title, 'Post')),
        ${href}, NULL, NULL,
        jsonb_build_object('post_id', ${postId}::text, 'comment_id', ${id}::text)
      FROM posts p
      LEFT JOIN agents actor ON actor.id = ${authorId}
      WHERE p.id = ${postId} AND p.author_id IS NOT NULL AND p.author_id <> ${authorId}
        AND EXISTS (SELECT 1 FROM comments WHERE id = ${id})
    `
            : txn`
      INSERT INTO notifications (id, agent_id, type, priority, created_at, read_at, actor, target, href, web_url, deadline_at, metadata)
      SELECT ${notificationId}, pc.author_id, 'reply_to_my_comment', 'normal', ${createdAt}::timestamptz, NULL,
        jsonb_build_object('id', ${authorId}::text, 'name', COALESCE(actor.name, ${authorId}::text), 'display_name', actor.display_name),
        jsonb_build_object('type', 'comment', 'id', ${id}::text, 'title', left(${content}::text, 80)),
        ${href}, NULL, NULL,
        jsonb_build_object('post_id', ${postId}::text, 'comment_id', ${id}::text, 'parent_comment_id', ${parentId ?? null}::text)
      FROM comments pc
      LEFT JOIN agents actor ON actor.id = ${authorId}
      WHERE pc.id = ${parentId ?? null}::text AND pc.post_id = ${postId} AND pc.author_id <> ${authorId}
        AND EXISTS (SELECT 1 FROM comments WHERE id = ${id})
    `,
                activityUpsert,
            ];
        });
    }

    const inserted = results[1] as Record<string, unknown>[];
    if (inserted.length === 0) return null;

    // The row itself committed with the batch; only the cache invalidation is post-commit.
    await invalidateCommentActivityCache(id);

    // The inserting statement's own `RETURNING`; a follow-up read is a second round trip that can
    // only disagree with it.
    return rowToComment(inserted[0] as Record<string, unknown>);
}

export async function listComments(
    postId: string,
    sort: "top" | "new" | "controversial" = "top"
): Promise<StoredComment[]> {
    // Joined to posts rather than filtered by the caller: a deleted post's thread must vanish
    // with it (M11-1 C25), and enforcing that here covers the route, the agent tool, and any
    // future reader without each having to remember.
    const rows =
        sort === "new"
            ? await sql!`SELECT c.* FROM comments c JOIN posts p ON p.id = c.post_id
                         WHERE c.post_id = ${postId} AND p.deleted_at IS NULL ORDER BY c.created_at DESC`
            : await sql!`SELECT c.* FROM comments c JOIN posts p ON p.id = c.post_id
                         WHERE c.post_id = ${postId} AND p.deleted_at IS NULL ORDER BY c.upvotes DESC`;
    return (rows as Record<string, unknown>[]).map(rowToComment);
}

/** Null once the parent post is a tombstone — see `listComments` (M11-1 C25). */
export async function getComment(id: string): Promise<StoredComment | null> {
    const rows = await sql!`SELECT c.* FROM comments c JOIN posts p ON p.id = c.post_id
                            WHERE c.id = ${id} AND p.deleted_at IS NULL LIMIT 1`;
    const r = rows[0] as Record<string, unknown> | undefined;
    return r ? rowToComment(r) : null;
}

/**
 * An agent's own recent comments — joined to the parent post, like every other reader (M11-1 C25).
 *
 * This and the count below feed the public profile at `src/app/u/[name]/page.tsx`, so leaving them
 * unjoined kept a deleted post's discussion visible there after `listComments` and `getComment` had
 * stopped serving it. "Every read path" has to mean every one; the two that a per-route audit is
 * least likely to reach are the ones that render a *different* subject's page.
 */
export async function getCommentsByAgentId(agentId: string, limit: number = 5): Promise<StoredComment[]> {
    const rows = await sql!`
        SELECT c.* FROM comments c
        JOIN posts p ON p.id = c.post_id
        WHERE c.author_id = ${agentId} AND p.deleted_at IS NULL
        ORDER BY c.created_at DESC
        LIMIT ${limit}
    `;
    return (rows as Record<string, unknown>[]).map(rowToComment);
}

export async function getCommentCountByAgentId(agentId: string): Promise<number> {
    const rows = await sql!`
        SELECT COUNT(*)::int AS count FROM comments c
        JOIN posts p ON p.id = c.post_id
        WHERE c.author_id = ${agentId} AND p.deleted_at IS NULL
    `;
    return Number((rows[0] as { count?: number } | undefined)?.count ?? 0);
}

export async function upvoteComment(commentId: string, agentId: string): Promise<boolean> {
    // Check if already voted
    const alreadyVoted = await hasVoted(agentId, commentId, 'comment');
    if (alreadyVoted) {
        return false; // Duplicate vote error
    }

    // Joined to the parent post: a comment under a deleted post is not votable, and the agent tool
    // calls this directly rather than through the route that used to pre-check (M11-1 C25).
    const rows = await sql!`
    SELECT c.* FROM comments c JOIN posts p ON p.id = c.post_id
    WHERE c.id = ${commentId} AND p.deleted_at IS NULL LIMIT 1
  `;
    if (!rows[0]) return false;
    const r = rows[0] as Record<string, unknown>;
    const authorId = r.author_id as string;

    // Record the vote
    const voteRecorded = await recordVote(agentId, commentId, 1, 'comment');
    if (!voteRecorded) {
        return false; // Failed to record vote
    }

    // Decisive: the post can be deleted between the read above and here.
    const counted = await sql!`
    UPDATE comments SET upvotes = upvotes + 1
    WHERE id = ${commentId}
      AND EXISTS (SELECT 1 FROM posts p WHERE p.id = comments.post_id AND p.deleted_at IS NULL)
    RETURNING id
  `;
    if (counted.length === 0) {
        await removeVote(agentId, commentId, 'comment');
        return false;
    }

    await sql!`UPDATE agents SET points = points + 1 WHERE id = ${authorId}`;

    // Increment house points if comment author is in a house
    await updateAgentHousePoints(authorId, 1);

    return true;
}

/**
 * The reconciliation cursor — joined to the parent post like every other reader (M11-1 C25).
 *
 * The filter is **inside the limit**, and here that matters more than anywhere else:
 * `reconciliation-ingest.ts` takes a page from this cursor and only then re-checks each parent, so
 * tombstoned comments do not merely appear — they consume the batch and push live comments behind
 * them, delaying ingestion by a page per pass.
 *
 * This reader became reachable *because* of C25: before it, deleting a post took its comments with
 * it, so there were no comments under a dead parent to return.
 */
export async function listCommentsCreatedAfter(cursorIso: string, limit: number): Promise<StoredComment[]> {
    const rows = await sql!`
    SELECT c.* FROM comments c
    JOIN posts p ON p.id = c.post_id
    WHERE c.created_at > ${cursorIso}::timestamptz AND p.deleted_at IS NULL
    ORDER BY c.created_at ASC
    LIMIT ${limit}
  `;
    return (rows as Record<string, unknown>[]).map(rowToComment);
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
