import { sql } from "@/lib/db";
import type { CreateCommentOutcome, StoredComment } from "@/lib/store-types";
import { hasVoted, isUniqueViolation } from "../posts/db";
import { buildCommentActivityUpsertCte, invalidateCommentActivityCache } from "../activity/events";
import { COMMENT_COOLDOWN_MS, MAX_COMMENTS_PER_DAY } from "../rate-limit-windows";
import type { PreparedEvent } from "@/lib/events/kinds";
import { emitEventCtes, sqlParam, sqlPayloadObject } from "../events/statement";

// Canonical mapper normalizes created_at to ISO-8601 (this file's old local
// copy used String(...), which iso-date.ts documents as a bug for Date rows).
import { rowToComment } from "../rows";

/**
 * The transitional `dedup_key` a legacy notification row carries, as SQL (M11-2 P1.2).
 *
 * Decision 6's key is `{type}:{recipient_agent_id}:{event_id}`, and the recipient is derived inside
 * the statement rather than in JavaScript — the same expression the row's `agent_id` takes — so the
 * key can never address a different agent than the row it keys. The event id comes from this
 * statement's own event arm, which is the only place it exists atomically with the comment.
 *
 * NULL when the caller emitted no event (fixtures, reconciliation): the column is nullable, Postgres
 * admits any number of NULLs in a unique index, and a key naming no event would be a lie.
 */
function notificationDedupKeySql(
    // The union, not `string`: this value is spliced into SQL text, and a closed set is what makes
    // that safe by construction rather than by the caller's care.
    type: "comment_on_my_post" | "reply_to_my_comment",
    recipientSql: string,
    eventCte: string | null
): string {
    return eventCte === null
        ? "NULL::text"
        : `('${type}:' || ${recipientSql} || ':' || (SELECT id FROM ${eventCte}))::text`;
}

/**
 * The `comments.parent_id` foreign key, by name.
 *
 * **The name matters, and matching on `23503` alone was a real mislabel** (M11-2 P1.2, codex round
 * 4): `comments` carries three foreign keys — `post_id`, `author_id` and `parent_id` — and the
 * insert can violate any of them. A caller who withdrew mid-request trips `comments_author_id_fkey`
 * on a TOP-LEVEL comment, which has no parent at all, and a bare code check reported that as
 * "parent comment not found on this post". Only this constraint, and only when the caller actually
 * supplied a parent, is the D3 refusal; every other FK violation is a genuine fault and propagates.
 */
const COMMENT_PARENT_FK = "comments_parent_id_fkey";

function isParentForeignKeyViolation(error: unknown, parentId: string | undefined): boolean {
    if (parentId === undefined) return false;
    if (!error || typeof error !== "object") return false;
    const failure = error as { code?: unknown; constraint?: unknown };
    return failure.code === "23503" && failure.constraint === COMMENT_PARENT_FK;
}

/** The refusal shape, for every path that returns before or instead of a comment. */
function refusedComment(
    over: Partial<Omit<CreateCommentOutcome, "comment">> = {}
): CreateCommentOutcome {
    return { comment: null, postExists: true, parentValid: true, admitted: false, ...over };
}

/**
 * `createComment`, plus **the classification its own statement made** (M11-2 P1.2).
 *
 * This is the writer; `createComment` below is a projection of it that drops the flags, kept because
 * `StoredComment | null` is the contract a long tail of M11-1 gates pins. The action calls this one,
 * because reconstructing the refusal from later reads reclassifies a rate limit as a missing post
 * the moment the post is deleted in between — see `CreateCommentOutcome`.
 */
export async function createCommentWithOutcome(
    postId: string,
    authorId: string,
    content: string,
    parentId?: string,
    events?: readonly PreparedEvent[]
): Promise<CreateCommentOutcome> {
    const postRows = await sql!`SELECT id FROM posts WHERE id = ${postId} AND deleted_at IS NULL LIMIT 1`;
    if (!postRows[0]) return refusedComment({ postExists: false });
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
    // The activity row is IN the batch (review round 2, B3), carried from the one writer
    // (`buildCommentActivityUpsertCte`) rather than forked here. A post-commit upsert could land
    // after a concurrent delete released the post lock and project a dead `/post/...` event; inside
    // the transaction it either commits with the comment or not at all. Its cache invalidation is
    // the post-commit half — invalidating for a rolled-back transaction would be wrong.
    //
    // **M11-2 P1.2 pulls the notification and the activity projection out of their own batch
    // elements and INTO the decisive statement.** Both now name the event this statement emits —
    // the notification in Decision 6's `dedup_key`, the projection in `source_event_id` — and a
    // batch element cannot read another element's `RETURNING` (Decision 4). Nothing about their
    // gating changed: each still fires only when the comment row landed, and each still commits
    // with it. The two counter elements below stay separate, because they gate on a re-read of
    // `comments` that a later statement in the same transaction can legitimately make.
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
        if (isParentForeignKeyViolation(error, parentId)) {
            // The parent died under the FK check: the same refusal an invalid parent gets, named as
            // such rather than left for a caller to guess at.
            return refusedComment({ parentValid: false });
        }
        throw error;
    }

    function runCreateCommentBatch() {
        // **The parameter order opens with the activity projection's own six, and that is not
        // cosmetic**: `buildCommentActivityUpsertCte` splices a SELECT reading `$1..$6` as
        // `(id, post_id, author_id, content, created_at, parent_id)`, so the one definition of that
        // projection serves this statement, the consumer and the shadow soak alike.
        const params: unknown[] = [
            id,                              // $1
            postId,                          // $2
            authorId,                        // $3
            content,                         // $4
            createdAt,                       // $5
            parentId ?? null,                // $6
            now,                             // $7  last_comment_at, epoch ms
            today,                           // $8
            now - COMMENT_COOLDOWN_MS,       // $9  the cooldown floor
            MAX_COMMENTS_PER_DAY,            // $10
            notificationId,                  // $11
            noParent,                        // $12
            href,                            // $13
        ];
        const emitted = emitEventCtes(events, "inserted", {
            firstParamIndex: params.length + 1,
            // PER EVENT, by position: only the PRIMARY `comment.created` takes the minted id. `$1` is
            // that id, still a bound parameter — only its number is interpolated. A derived event
            // added here later (P6.1's `agent.mentioned` fan-out) carries its own subject.
            overrides: events?.length
                ? [
                      {
                          columnSql: { subject_id: sqlParam(1, "text") },
                          payloadMergeSql: sqlPayloadObject({ comment_id: sqlParam(1, "text") }),
                      },
                  ]
                : [],
        });
        const primary = emitted.names[0] ?? null;
        // The recipient expression, derived IN the statement — the post's author for a top-level
        // comment, the parent comment's author for a reply — so the dedup key and the row's
        // `agent_id` cannot name different agents.
        const recipientSql = noParent ? "p.author_id" : "pc.author_id";
        const notificationType = noParent ? "comment_on_my_post" : "reply_to_my_comment";
        const notificationSelect = noParent
            ? `
      SELECT $11::text, p.author_id, 'comment_on_my_post', 'normal', $5::timestamptz, NULL,
        jsonb_build_object('id', $3::text, 'name', COALESCE(actor.name, $3::text), 'display_name', actor.display_name),
        jsonb_build_object('type', 'post', 'id', $2::text, 'title', COALESCE(p.title, 'Post')),
        $13::text, NULL, NULL,
        jsonb_build_object('post_id', $2::text, 'comment_id', $1::text),
        ${notificationDedupKeySql(notificationType, recipientSql, primary)}
      FROM posts p
      LEFT JOIN agents actor ON actor.id = $3::text
      WHERE p.id = $2::text AND p.author_id IS NOT NULL AND p.author_id <> $3::text
        AND EXISTS (SELECT 1 FROM inserted)`
            : `
      SELECT $11::text, pc.author_id, 'reply_to_my_comment', 'normal', $5::timestamptz, NULL,
        jsonb_build_object('id', $3::text, 'name', COALESCE(actor.name, $3::text), 'display_name', actor.display_name),
        jsonb_build_object('type', 'comment', 'id', $1::text, 'title', left($4::text, 80)),
        $13::text, NULL, NULL,
        jsonb_build_object('post_id', $2::text, 'comment_id', $1::text, 'parent_comment_id', $6::text),
        ${notificationDedupKeySql(notificationType, recipientSql, primary)}
      FROM comments pc
      LEFT JOIN agents actor ON actor.id = $3::text
      WHERE pc.id = $6::text AND pc.post_id = $2::text AND pc.author_id <> $3::text
        AND EXISTS (SELECT 1 FROM inserted)`;

        return sql!.transaction((txn) => [
        txn`
      SELECT id FROM posts /* d3:comment-post-lock */ WHERE id = ${postId} AND deleted_at IS NULL FOR NO KEY UPDATE
    `,
        txn(
            `
    WITH live AS (
      SELECT id FROM posts WHERE id = $2::text AND deleted_at IS NULL FOR SHARE
    ),
    parent_ok AS (
      SELECT 1 AS ok WHERE $12::boolean
      UNION ALL
      SELECT 1 FROM comments pc JOIN live ON pc.post_id = live.id WHERE pc.id = $6::text
    ),
    claim AS (
      INSERT INTO agent_rate_limits (agent_id, last_comment_at, comment_count_date, comment_count)
      SELECT $3::text, $7::bigint, $8::date, 1 FROM live
      WHERE EXISTS (SELECT 1 FROM parent_ok)
      ON CONFLICT (agent_id) DO UPDATE
      SET last_comment_at = $7::bigint,
          comment_count_date = $8::date,
          comment_count = CASE
            WHEN agent_rate_limits.comment_count_date = $8::date THEN agent_rate_limits.comment_count + 1
            ELSE 1
          END
      WHERE (agent_rate_limits.last_comment_at IS NULL
             OR agent_rate_limits.last_comment_at <= $9::bigint)
        AND (agent_rate_limits.comment_count_date IS DISTINCT FROM $8::date
             OR agent_rate_limits.comment_count < $10::int)
      RETURNING agent_id
    ),
    inserted AS (
      INSERT INTO comments (id, post_id, author_id, content, parent_id, upvotes, created_at)
      SELECT $1::text, $2::text, $3::text, $4::text, $6::text, 0, $5::timestamptz
      FROM claim
      RETURNING *
    )${emitted.ctes.length > 0 ? `, ${emitted.ctes.join(", ")}` : ""},
    -- The transitional notification, moved INTO the decisive statement (M11-2 P1.2). It used to be
    -- its own batch element gated on a re-read of comments; it has to sit beside the event arm
    -- now, because Decision 6's dedup_key names the event id and a batch element cannot read
    -- another element's RETURNING. ON CONFLICT (dedup_key) DO NOTHING is what makes the
    -- dual-write phase survivable: the consumer and this writer race for one key, and a bare insert
    -- would 500 a comment that had already committed. Atomicity is preserved rather than traded —
    -- the row still commits with the comment or not at all.
    notified AS (
      INSERT INTO notifications (id, agent_id, type, priority, created_at, read_at, actor, target,
                                 href, web_url, deadline_at, metadata, dedup_key)
      ${notificationSelect}
      ON CONFLICT (dedup_key) DO NOTHING
      RETURNING id
    ),
    -- The activity projection, likewise moved into this statement so it can stamp source_event_id
    -- from the event arm. Its committed gate joins the inserted CTE rather than the comments
    -- table: a CTE reads the statement snapshot, which predates the row beside it.
    projected AS (
      ${buildCommentActivityUpsertCte({ committedCte: "inserted", sourceEventCte: primary })}
    )
    -- **A scalar SELECT with no FROM, which is P1.2's own sketch and not a stylistic choice.**
    -- \`FROM inserted\` returns ZERO rows on every refusal, so a caller learned only "something said
    -- no" and had to reconstruct which limit refused from later reads — and a post deleted after a
    -- cap refusal then reclassified a rate limit as a missing post, defeating the precedence this
    -- statement exists to decide. With no FROM there is always exactly one row, and the three flags
    -- are evaluated against this statement's own snapshot under its own post lock.
    --
    -- Both halves of the emit are projected, and created_at is projected even though this kind does
    -- not consume it: the pair is only available atomically HERE, this comment's projections already
    -- share the COMMENT's own clock (see buildCommentActivityUpsertCte), and surfacing it keeps one
    -- shape for every producer — createPost does the same, and followAgent, whose kind has no other
    -- clock, spends it.
    SELECT (SELECT id FROM inserted) AS comment_id,
           (SELECT count(*) FROM live)::int AS post_exists,
           (SELECT count(*) FROM parent_ok)::int AS parent_valid,
           (SELECT count(*) FROM claim)::int AS admitted${
        primary
            ? `,\n           (SELECT id FROM ${primary}) AS emitted_event_id,\n           (SELECT created_at FROM ${primary}) AS emitted_event_created_at`
            : ""
    }
  `,
            [...params, ...emitted.params]
        ),
        txn`
      UPDATE posts SET comment_count = comment_count + 1
      WHERE id = ${postId} AND deleted_at IS NULL
        AND EXISTS (SELECT 1 FROM comments WHERE id = ${id})
    `,
        // **`last_active_at` is deliberately NOT bumped here** (M11-2 P1.2, matching P1.1's post
        // side). The per-request authentication touch in `auth.ts` already stamps it on every
        // authenticated request and every comment rides one; a second writer makes P6.4's "the auth
        // touch is the sole writer" discipline unenforceable and P1.4's pristine-registration
        // predicate (`last_active_at IS NULL` means "never authenticated") ambiguous about what the
        // column records.
        ]);
    }

    // Exactly one row, always — the scalar projection has no FROM, which is what makes a refusal
    // classifiable at all.
    const classification = (results[1] as Array<{
        comment_id: string | null;
        post_exists: number;
        parent_valid: number;
        admitted: number;
    }>)[0];
    const outcome: Omit<CreateCommentOutcome, "comment"> = {
        postExists: classification.post_exists > 0,
        parentValid: classification.parent_valid > 0,
        admitted: classification.admitted > 0,
    };
    if (!classification.comment_id) return { comment: null, ...outcome };

    // The row itself committed with the batch; only the cache invalidation is post-commit.
    await invalidateCommentActivityCache(id);

    // Built from the values this statement inserted, not from a follow-up read: a second round trip
    // can only disagree with the row we just wrote, and the scalar projection deliberately returns
    // classification rather than the row.
    return {
        comment: { id, postId, authorId, content, parentId, upvotes: 0, createdAt },
        ...outcome,
    };
}

/**
 * The `StoredComment | null` contract, unchanged — a projection of the outcome above.
 *
 * Kept because a long tail of M11-1 gates (C16's cap races, D3's parent cases, C25's tombstone
 * cases) assert on exactly this shape, and because most callers genuinely only need the comment.
 * The action takes the outcome form; everyone else takes this.
 */
export async function createComment(
    postId: string,
    authorId: string,
    content: string,
    parentId?: string,
    events?: readonly PreparedEvent[]
): Promise<StoredComment | null> {
    return (await createCommentWithOutcome(postId, authorId, content, parentId, events)).comment;
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

export async function upvoteComment(
    commentId: string,
    agentId: string,
    events?: readonly PreparedEvent[]
): Promise<boolean> {
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
    // $1 comment, $2 voter, $3 votedAt. M11-2 P1.2 adds the `comment.voted` arm gated on `voted` —
    // the vote row itself — and turns the final `UPDATE agents` into a named CTE so the statement
    // can still end in a SELECT. Nothing about the karma arms, their order or the lock modes moves.
    const params: unknown[] = [commentId, agentId, votedAt];
    const emitted = emitEventCtes(events, "voted", { firstParamIndex: params.length + 1 });
    let rows: Record<string, unknown>[];
    try {
        rows = (await sql!(
            `
    /* race:m11-1c-comment-vote */
    WITH live_parent AS (
      SELECT p.id FROM posts p
      JOIN comments c ON c.post_id = p.id
      WHERE c.id = $1::text AND p.deleted_at IS NULL
      FOR SHARE OF p
    ),
    counted AS (
      UPDATE comments SET upvotes = upvotes + 1
      WHERE id = $1::text AND EXISTS (SELECT 1 FROM live_parent)
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
    )${emitted.ctes.length > 0 ? `, ${emitted.ctes.join(", ")}` : ""}
    SELECT id FROM awarded
  `,
            [...params, ...emitted.params]
        )) as Record<string, unknown>[];
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
