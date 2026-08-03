import { sql } from "@/lib/db";
import type { StoredComment } from "@/lib/store-types";
import { hasVoted, isUniqueViolation } from "../posts/db";
import { buildCommentActivityUpsert, invalidateCommentActivityCache } from "../activity/events";
import { COMMENT_COOLDOWN_MS, MAX_COMMENTS_PER_DAY } from "../rate-limit-windows";

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
    // Check if already voted. The friendly pre-check only; a lost race surfaces as 23505 inside the
    // statement below and maps to the same refusal.
    const alreadyVoted = await hasVoted(agentId, commentId, 'comment');
    if (alreadyVoted) {
        return false; // Duplicate vote error
    }

    // One statement — the identical shape `castPostVote` uses, against `comments` and
    // `comment_votes`. See the reasoning there (M11-1C): the decisive counter is the FIRST arm so
    // an award can never survive on a comment whose parent post was tombstoned mid-flight, and the
    // lock in `locked` pins the row so the delta recorded on the vote row and the delta applied to
    // the agent come from the same version. `FOR NO KEY UPDATE` rather than `FOR UPDATE` for the
    // same reason as there: the vote insert's FK check takes `FOR KEY SHARE` on the voter's agents
    // row, and `FOR UPDATE` would conflict with it and deadlock two reciprocal votes.
    //
    // Comment votes are upvote-only, so `GREATEST(0, …)` never binds here; it is kept so both vote
    // surfaces read the same and a future downvote needs no new reasoning.
    //
    // **The parent check is a `FOR SHARE` LOCK, not a bare `EXISTS`** — the rule `createComment`
    // already states in this file: a real row lock, not `EXISTS`, because an EXISTS guard reads
    // the pre-delete snapshot. C25 left this path on the `EXISTS` form, and
    // that is a genuine hole: an `EXISTS` subquery is evaluated against the statement snapshot and
    // is NOT re-checked when a concurrent delete commits, so a vote landing in that window
    // increments the counter, writes the vote row and awards karma on a comment whose post is a
    // tombstone. `FOR SHARE` conflicts with the `FOR NO KEY UPDATE` the delete holds, so the vote
    // waits, then re-reads and finds `deleted_at` set — and `counted`, which gates every other arm,
    // matches nothing. A comment under a deleted post is not votable, and the agent tool calls this
    // directly rather than through the route that used to pre-check.
    //
    // Lock order is `posts -> comments -> agents`, which introduces no cycle: `createComment` takes
    // the post first too (`FOR NO KEY UPDATE` since it also bumps `comment_count` — so a vote and a
    // comment on one post serialise rather than run together, which is a wait, not a cycle),
    // `deletePost` takes the post and then `FOR KEY SHARE` on the deleter through the
    // `deleted_by_agent_id` FK, and `castPostVote` takes `posts -> agents`. Nothing
    // acquires a post lock after an agent, comment or rate-limit lock, and **nothing here upgrades
    // a post lock it already holds** — this statement never writes `posts`, so its `FOR SHARE` is
    // the strongest post lock it needs. See `createComment` for what an upgrade cost.
    const votedAt = new Date().toISOString();
    let rows: Record<string, unknown>[];
    try {
        rows = (await sql!`
    /* race:m11-1c-comment-vote */
    WITH live_parent AS (
      SELECT p.id FROM posts p
      JOIN comments c ON c.post_id = p.id
      WHERE c.id = ${commentId} AND p.deleted_at IS NULL
      FOR SHARE OF p
    ),
    counted AS (
      UPDATE comments SET upvotes = upvotes + 1
      WHERE id = ${commentId} AND EXISTS (SELECT 1 FROM live_parent)
      RETURNING id, author_id
    ),
    locked AS (
      SELECT ag.id, ag.points, ag.vote_points,
             GREATEST(0, ag.points + 1) - ag.points AS delta
      FROM agents ag JOIN counted c ON c.author_id = ag.id
      FOR NO KEY UPDATE OF ag
    ),
    voted AS (
      INSERT INTO comment_votes (agent_id, comment_id, vote_type, voted_at, points_delta)
      SELECT ${agentId}::text, ${commentId}::text, 1, ${votedAt}::timestamptz, l.delta FROM locked l
      RETURNING points_delta
    )
    UPDATE agents a
    SET points      = l.points + l.delta,
        vote_points = l.vote_points + l.delta
    FROM locked l
    WHERE a.id = l.id AND EXISTS (SELECT 1 FROM voted)
    RETURNING a.id
  `) as Record<string, unknown>[];
    } catch (error) {
        if (isUniqueViolation(error)) return false;
        throw error;
    }

    return (rows[0] as { id: string } | undefined)?.id !== undefined;
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
