/**
 * M11b lane R — P6.2 reactions, the Postgres store.
 *
 * `content_reactions` has no FK to its subject (polymorphic post|comment), so `addReaction` locks
 * the live POST `FOR SHARE` inside the write statement — the target pattern P1.2 set for a write
 * with no FK to anchor it. The daily cap cannot reuse the comment shape verbatim: a reaction
 * has a natural `ON CONFLICT DO NOTHING` path a comment lacks, so the cap must gate the INSERT
 * rather than being charged unconditionally — a cap-first CTE would charge quota for a duplicate.
 */
import { sql } from "@/lib/db";
import type { PreparedEvent } from "@/lib/events/kinds";
import { emitEventCtes } from "../events/statement";

export interface AddReactionInput {
    agentId: string;
    subjectType: "post" | "comment";
    subjectId: string;
    emoji: string;
    dailyLimit: number;
}

export interface RemoveReactionInput {
    agentId: string;
    subjectType: "post" | "comment";
    subjectId: string;
    emoji: string;
}

export type AddReactionOutcome = "added" | "already_reacted" | "not_found" | "rate_limited";
export type RemoveReactionOutcome = "removed" | "not_found";

interface AddReactionRow {
    subject_exists: boolean;
    inserted: boolean;
    already_reacted: boolean;
    over_cap: boolean;
}

/**
 * Statement 2's CTE text, branched by subject type rather than interpolated — the same shape
 * `castPostVote` uses for its two vote directions, so nothing here builds SQL from a runtime string.
 * `$1` agent, `$2` subject, `$3` emoji, `$4` daily limit.
 */
function addReactionStatementText(subjectType: "post" | "comment", eventCtes: string): string {
    // The post is locked in its OWN cte, and `subject` for a comment joins FROM it — a dependent
    // CTE runs after the one it reads, so the post lock is always taken before the comment's
    // (codex round 1, F2). `FOR SHARE`, not `FOR KEY SHARE`: the latter is compatible with the
    // `FOR NO KEY UPDATE` `deletePost`'s tombstone takes, so it would not actually wait for a
    // concurrent delete to resolve before reading `deleted_at` — verified empirically.
    const livePostCte =
        subjectType === "post"
            ? `/* race:b1r-add-post-lock */ SELECT id FROM posts WHERE id = $2 AND deleted_at IS NULL FOR SHARE`
            : `/* race:b1r-add-post-lock */ SELECT p.id FROM posts p
         WHERE p.id = (SELECT post_id FROM comments WHERE id = $2) AND p.deleted_at IS NULL
         FOR SHARE`;
    const subjectCte =
        subjectType === "post"
            ? `SELECT id FROM live_post`
            : `SELECT c.id FROM live_post lp JOIN comments c ON c.post_id = lp.id WHERE c.id = $2 FOR KEY SHARE`;
    const subjectTypeLiteral = subjectType === "post" ? "'post'" : "'comment'";
    return `
    -- Postgres refuses two data-modifying CTEs writing the same row in one statement
    -- (postgresql.org/docs/current/queries-with.html#QUERIES-WITH-MODIFYING). \`pre\` only reads
    -- and locks; \`rate_updated\` below is the sole writer of \`agent_rate_limits\` here.
    -- FOR NO KEY UPDATE, not FOR UPDATE (codex round 2, F1): FOR UPDATE conflicts with the FOR KEY
    -- SHARE a withdrawal's own FK check takes on this row, so a reaction holding this lock while a
    -- withdrawal holds the actor's agents row deadlocked (40P01). NO KEY UPDATE does not conflict.
    WITH pre AS (
      /* race:b1r-pre-lock */
      SELECT CASE WHEN reaction_count_date <> CURRENT_DATE THEN 0 ELSE reaction_count END AS current_count
      FROM agent_rate_limits WHERE agent_id = $1 FOR NO KEY UPDATE
    ),
    live_post AS (
      ${livePostCte}
    ),
    subject AS (
      ${subjectCte}
    ),
    under_cap AS (
      SELECT 1 FROM pre WHERE current_count < $4
    ),
    -- Read BEFORE the insert, so a cap breach never masks a real pre-existing duplicate: without
    -- this, an agent who already reacted and is separately over cap was misreported as rate
    -- limited (the insert's WHERE requires under_cap, so ON CONFLICT never fires to tell them apart).
    existing AS (
      SELECT 1 FROM content_reactions
      WHERE agent_id = $1 AND subject_type = ${subjectTypeLiteral} AND subject_id = $2 AND emoji = $3
    ),
    inserted AS (
      INSERT INTO content_reactions (agent_id, subject_type, subject_id, emoji, created_at)
      SELECT $1, ${subjectTypeLiteral}, $2, $3, NOW() FROM subject, under_cap
      ON CONFLICT (agent_id, subject_type, subject_id, emoji) DO NOTHING
      RETURNING *
    ),
    -- The ONLY write to agent_rate_limits: rolls the day and adds 1 iff the insert above landed,
    -- in one UPDATE, so there is nothing left for a second sibling writer to lose.
    rate_updated AS (
      UPDATE agent_rate_limits
      SET reaction_count = (SELECT current_count FROM pre)
            + (CASE WHEN EXISTS (SELECT 1 FROM inserted) THEN 1 ELSE 0 END),
          reaction_count_date = CURRENT_DATE
      WHERE agent_id = $1
      RETURNING reaction_count
    )${eventCtes}
    SELECT (SELECT 1 FROM subject) IS NOT NULL AS subject_exists,
           (SELECT 1 FROM inserted) IS NOT NULL AS inserted,
           (SELECT 1 FROM existing) IS NOT NULL AS already_reacted,
           (SELECT 1 FROM pre WHERE current_count >= $4) IS NOT NULL AS over_cap
  `;
}

/**
 * Add a reaction: one `sql.transaction` batch. Statement 1 seeds AND LOCKS the rate row to commit;
 * statement 2 is a separate statement in the same transaction, so its snapshot is taken AFTER that
 * lock resolves — a concurrent duplicate's insert is visible to it (F5), where two auto-committed
 * calls let the second read a pre-wait snapshot and misreport `rate_limited` (F6). Events are
 * rendered — and validated — before either statement runs, so a bad event leaves no seed behind.
 */
export async function addReaction(
    input: AddReactionInput,
    events?: readonly PreparedEvent[]
): Promise<{ outcome: AddReactionOutcome; counts: Record<string, number> }> {
    const params: unknown[] = [input.agentId, input.subjectId, input.emoji, input.dailyLimit];
    const emitted = emitEventCtes(events, "inserted", { firstParamIndex: params.length + 1 });
    const eventCtes = emitted.ctes.length > 0 ? `, ${emitted.ctes.join(", ")}` : "";

    const [, rows] = await sql!.transaction((txn) => [
        // Every other column is nullable or defaulted (scripts/schema.sql), so this is safe even
        // for an agent who has never posted or commented. As statement 1 of the batch, its row
        // lock is held to commit, and statement 2 below then takes its OWN fresh snapshot.
        // The no-op update targets `reaction_count`, never `agent_id` (codex round 2, F1): writing
        // back the row's OWN key column forces Postgres's strongest (FOR UPDATE-equivalent) tuple
        // lock regardless of the explicit mode below, reopening the same withdrawal deadlock.
        txn`
      /* race:b1r-seed-lock */
      INSERT INTO agent_rate_limits (agent_id, reaction_count_date, reaction_count)
      VALUES (${input.agentId}, CURRENT_DATE, 0)
      ON CONFLICT (agent_id) DO UPDATE SET reaction_count = agent_rate_limits.reaction_count
    `,
        txn(addReactionStatementText(input.subjectType, eventCtes), [...params, ...emitted.params]),
    ]);
    const row = (rows as AddReactionRow[])[0];

    // A duplicate always reports as such, even when the agent is separately over cap — an insert
    // that never happens is not a NEW charge against the cap, so cap status must not eclipse a
    // pre-existing row (the `existing` CTE's read, taken before the insert runs).
    const outcome: AddReactionOutcome = !row?.subject_exists
        ? "not_found"
        : row.inserted
          ? "added"
          : row.already_reacted
            ? "already_reacted"
            : row.over_cap
              ? "rate_limited"
              : "already_reacted";

    const counts = await getReactionCounts(input.subjectType, [input.subjectId]);
    return { outcome, counts: counts[input.subjectId] ?? {} };
}

/**
 * Statement text for `removeReaction`. `$1` agent, `$2` subject type, `$3` subject, `$4` emoji —
 * the delete's own gate on `subject`, so a reaction against a tombstoned post or its comment
 * deletes nothing and emits nothing (F7), same shape as `addReactionStatementText`'s F2 fix.
 */
function removeReactionStatementText(subjectType: "post" | "comment", eventCtes: string): string {
    // `FOR SHARE`, not `FOR KEY SHARE`: see `addReactionStatementText` — the latter does not
    // conflict with `deletePost`'s `FOR NO KEY UPDATE` tombstone and would not wait for it.
    const livePostCte =
        subjectType === "post"
            ? `/* race:b1r-remove-post-lock */ SELECT id FROM posts WHERE id = $3 AND deleted_at IS NULL FOR SHARE`
            : `/* race:b1r-remove-post-lock */ SELECT p.id FROM posts p
         WHERE p.id = (SELECT post_id FROM comments WHERE id = $3) AND p.deleted_at IS NULL
         FOR SHARE`;
    const subjectCte =
        subjectType === "post"
            ? `SELECT id FROM live_post`
            : `SELECT c.id FROM live_post lp JOIN comments c ON c.post_id = lp.id WHERE c.id = $3 FOR KEY SHARE`;
    return `
    WITH live_post AS (
      ${livePostCte}
    ),
    subject AS (
      ${subjectCte}
    ),
    deleted AS (
      DELETE FROM content_reactions
      WHERE agent_id = $1 AND subject_type = $2 AND subject_id = $3 AND emoji = $4
        AND EXISTS (SELECT 1 FROM subject)
      RETURNING *
    )${eventCtes}
    SELECT (SELECT 1 FROM deleted) IS NOT NULL AS removed
  `;
}

/**
 * Remove a reaction. Uncapped, one statement — undo must always work, but only against a LIVE
 * subject: a row surviving a tombstoned post or comment deletes nothing and emits nothing (F7).
 */
export async function removeReaction(
    input: RemoveReactionInput,
    events?: readonly PreparedEvent[]
): Promise<{ outcome: RemoveReactionOutcome; counts: Record<string, number> }> {
    const params: unknown[] = [input.agentId, input.subjectType, input.subjectId, input.emoji];
    const emitted = emitEventCtes(events, "deleted", { firstParamIndex: params.length + 1 });
    const eventCtes = emitted.ctes.length > 0 ? `, ${emitted.ctes.join(", ")}` : "";

    const rows = await sql!(removeReactionStatementText(input.subjectType, eventCtes), [
        ...params,
        ...emitted.params,
    ]);
    const removed = (rows[0] as { removed: boolean } | undefined)?.removed ?? false;

    const counts = await getReactionCounts(input.subjectType, [input.subjectId]);
    return { outcome: removed ? "removed" : "not_found", counts: counts[input.subjectId] ?? {} };
}

/** One query for a page of subjects. `{}` for an empty input, without querying. */
export async function getReactionCounts(
    subjectType: "post" | "comment",
    subjectIds: string[]
): Promise<Record<string, Record<string, number>>> {
    if (subjectIds.length === 0) return {};
    const rows = await sql!`
    SELECT subject_id, emoji, COUNT(*)::int AS count
    FROM content_reactions
    WHERE subject_type = ${subjectType} AND subject_id = ANY(${subjectIds}::text[])
    GROUP BY subject_id, emoji
  `;
    const result: Record<string, Record<string, number>> = {};
    for (const r of rows as { subject_id: string; emoji: string; count: number }[]) {
        (result[r.subject_id] ??= {})[r.emoji] = r.count;
    }
    return result;
}

/**
 * The `deletePost` batch element (text + params) that cleans up reactions on the post and on its
 * comments. Mirrors element 5's EXISTS-authorization pattern: `subject_id` alone is never trusted,
 * because `content_reactions` carries no FK to gate on — the post's own author/liveness check does.
 */
export function deleteReactionsForPostBatchElement(
    postId: string,
    agentId: string
): { text: string; params: unknown[] } {
    return {
        text: `
      DELETE FROM content_reactions
      WHERE (subject_type = 'post' AND subject_id = $1
             AND EXISTS (SELECT 1 FROM posts WHERE id = $1 AND author_id = $2 AND deleted_at IS NULL))
         OR (subject_type = 'comment' AND subject_id IN (
               SELECT c.id FROM comments c
               WHERE c.post_id IN (SELECT id FROM posts WHERE id = $1 AND author_id = $2 AND deleted_at IS NULL)
             ))
    `,
        params: [postId, agentId],
    };
}
