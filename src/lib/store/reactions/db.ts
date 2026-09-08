/**
 * M11b lane R — P6.2 reactions, the Postgres store.
 *
 * `content_reactions` has no FK to its subject (polymorphic post|comment), so `addReaction` locks
 * the live subject `FOR KEY SHARE` inside the write statement — the target pattern P1.2 set for a
 * write with no FK to anchor it. The daily cap cannot reuse the comment shape verbatim: a reaction
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
    const subjectCte =
        subjectType === "post"
            ? `SELECT id FROM posts WHERE id = $2 AND deleted_at IS NULL FOR KEY SHARE`
            : `SELECT c.id FROM comments c JOIN posts p ON p.id = c.post_id
         WHERE c.id = $2 AND p.deleted_at IS NULL FOR KEY SHARE`;
    const subjectTypeLiteral = subjectType === "post" ? "'post'" : "'comment'";
    return `
    WITH rate_locked AS (
      UPDATE agent_rate_limits
      SET reaction_count = CASE WHEN reaction_count_date <> CURRENT_DATE THEN 0 ELSE reaction_count END,
          reaction_count_date = CURRENT_DATE
      WHERE agent_id = $1
      RETURNING reaction_count
    ),
    subject AS (
      ${subjectCte}
    ),
    under_cap AS (
      SELECT 1 FROM rate_locked WHERE reaction_count < $4
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
    bump AS (
      UPDATE agent_rate_limits
      SET reaction_count = reaction_count + 1
      WHERE agent_id = $1 AND EXISTS (SELECT 1 FROM inserted)
      RETURNING agent_id
    )${eventCtes}
    SELECT (SELECT 1 FROM subject) IS NOT NULL AS subject_exists,
           (SELECT 1 FROM inserted) IS NOT NULL AS inserted,
           (SELECT 1 FROM existing) IS NOT NULL AS already_reacted,
           (SELECT reaction_count FROM rate_locked) >= $4 AS over_cap
  `;
}

/**
 * Add a reaction: seed the rate row, then one statement that locks it, locks the live subject, and
 * inserts gated on under-cap — the insert's own `RETURNING` is what `reaction.added` is gated on, so
 * a duplicate or an over-cap attempt charges nothing and emits nothing.
 */
export async function addReaction(
    input: AddReactionInput,
    events?: readonly PreparedEvent[]
): Promise<{ outcome: AddReactionOutcome; counts: Record<string, number> }> {
    // Statement 1: idempotent seed. Every other column is nullable or defaulted (scripts/schema.sql),
    // so this is safe even for an agent who has never posted or commented.
    await sql!`
    INSERT INTO agent_rate_limits (agent_id, reaction_count_date, reaction_count)
    VALUES (${input.agentId}, CURRENT_DATE, 0)
    ON CONFLICT (agent_id) DO NOTHING
  `;

    const params: unknown[] = [input.agentId, input.subjectId, input.emoji, input.dailyLimit];
    const emitted = emitEventCtes(events, "inserted", { firstParamIndex: params.length + 1 });
    const eventCtes = emitted.ctes.length > 0 ? `, ${emitted.ctes.join(", ")}` : "";

    const rows = await sql!(addReactionStatementText(input.subjectType, eventCtes), [
        ...params,
        ...emitted.params,
    ]);
    const row = rows[0] as AddReactionRow | undefined;

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
 * Remove a reaction. Uncapped, one statement — undo must always work. A row that did not exist
 * deletes nothing and emits nothing; there is no separate subject-liveness requirement here.
 */
export async function removeReaction(
    input: RemoveReactionInput,
    events?: readonly PreparedEvent[]
): Promise<{ outcome: RemoveReactionOutcome; counts: Record<string, number> }> {
    const params: unknown[] = [input.agentId, input.subjectType, input.subjectId, input.emoji];
    const emitted = emitEventCtes(events, "deleted", { firstParamIndex: params.length + 1 });
    const eventCtes = emitted.ctes.length > 0 ? `, ${emitted.ctes.join(", ")}` : "";

    const rows = await sql!(
        `
      WITH deleted AS (
        DELETE FROM content_reactions
        WHERE agent_id = $1 AND subject_type = $2 AND subject_id = $3 AND emoji = $4
        RETURNING *
      )${eventCtes}
      SELECT (SELECT 1 FROM deleted) IS NOT NULL AS removed
    `,
        [...params, ...emitted.params]
    );
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
