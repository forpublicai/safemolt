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
import { buildExecutionGuardCte, type ExecutionGuard } from "../execution-guard";

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

export type AddReactionOutcome =
    | "added"
    | "already_reacted"
    | "not_found"
    | "rate_limited"
    | "execution_guard_failed";
export type RemoveReactionOutcome = "removed" | "not_found" | "execution_guard_failed";

interface AddReactionRow {
    subject_exists: boolean;
    inserted: boolean;
    already_reacted: boolean;
    over_cap: boolean;
    guard_passed?: number;
}

/** Statement 1: lock the whole live subject (post, or post+comment) before the seed touches agents. */
function subjectOnlyLockStatementText(subjectType: "post" | "comment"): string {
    return subjectType === "post"
        ? `/* race:b1r-add-post-lock */ SELECT id FROM posts WHERE id = $1 AND deleted_at IS NULL FOR SHARE`
        : `/* race:b1r-add-post-lock */ SELECT p.id, c.id FROM posts p
       JOIN comments c ON c.post_id = p.id
       WHERE c.id = $1 AND p.deleted_at IS NULL
       FOR SHARE`;
}

/** The seed's own FK (`agent_rate_limits.agent_id`): a withdrawn actor trips this, not a 500 (F3). */
const ACTOR_RATE_LIMIT_FK = "agent_rate_limits_agent_id_fkey";
function isActorForeignKeyViolation(error: unknown): boolean {
    if (!error || typeof error !== "object") return false;
    const failure = error as { code?: unknown; constraint?: unknown };
    return failure.code === "23503" && failure.constraint === ACTOR_RATE_LIMIT_FK;
}

/**
 * Runs `run`, translating the seed's own actor-FK violation into a refusal instead of throwing
 * (F3) — split out so `addReaction`'s own branching stays under the complexity budget.
 */
async function runOrActorGone(run: () => Promise<unknown[]>): Promise<{ ok: true; results: unknown[] } | { ok: false }> {
    try {
        return { ok: true, results: await run() };
    } catch (error) {
        if (isActorForeignKeyViolation(error)) return { ok: false };
        throw error;
    }
}

/** Statement 2: seed the rate row, gated on the guard so a disabled runner creates nothing (F2). */
function seedStatementText(guardCte: string | null): string {
    const insert = `
      /* race:b1r-seed-lock */
      INSERT INTO agent_rate_limits (agent_id, reaction_count_date, reaction_count)
      SELECT $1, CURRENT_DATE, 0${guardCte ? " WHERE EXISTS (SELECT 1 FROM guard)" : ""}
      ON CONFLICT (agent_id) DO UPDATE SET reaction_count = agent_rate_limits.reaction_count
    `;
    return guardCte ? `WITH ${guardCte} ${insert}` : insert;
}

/**
 * Statement 3's CTE text (the decisive statement), branched by subject type rather than
 * interpolated. `$1` agent, `$2` subject, `$3` emoji, `$4` daily limit. Re-takes the subject lock
 * statement 1 already holds — free, within the same transaction.
 */
function addReactionStatementText(subjectType: "post" | "comment", eventCtes: string, guardCte: string | null): string {
    const livePostCte =
        subjectType === "post"
            ? `SELECT id FROM posts WHERE id = $2 AND deleted_at IS NULL FOR SHARE`
            : `SELECT p.id FROM posts p
         WHERE p.id = (SELECT post_id FROM comments WHERE id = $2) AND p.deleted_at IS NULL
         FOR SHARE`;
    const subjectCte =
        subjectType === "post"
            ? `SELECT id FROM live_post`
            : `SELECT c.id FROM live_post lp JOIN comments c ON c.post_id = lp.id WHERE c.id = $2 FOR KEY SHARE`;
    const subjectTypeLiteral = subjectType === "post" ? "'post'" : "'comment'";
    const ctes = [
        // `pre` only reads and locks; `rate_updated` below is the sole writer of `agent_rate_limits`
        // here (Postgres refuses two data-modifying CTEs writing the same row in one statement).
        // FOR NO KEY UPDATE, not FOR UPDATE (codex round 2, F1): the latter conflicts with the
        // FOR KEY SHARE a withdrawal's own FK check takes on this row.
        `pre AS (
      /* race:b1r-pre-lock */
      SELECT CASE WHEN reaction_count_date <> CURRENT_DATE THEN 0 ELSE reaction_count END AS current_count
      FROM agent_rate_limits WHERE agent_id = $1 FOR NO KEY UPDATE
    )`,
        ...(guardCte ? [guardCte] : []),
        `live_post AS ( ${livePostCte} )`,
        `subject AS ( ${subjectCte} )`,
        `under_cap AS ( SELECT 1 FROM pre WHERE current_count < $4 )`,
        // Read BEFORE the insert, so a cap breach never masks a real pre-existing duplicate — the
        // insert's WHERE requires under_cap, so ON CONFLICT never fires to tell them apart.
        `existing AS (
      SELECT 1 FROM content_reactions
      WHERE agent_id = $1 AND subject_type = ${subjectTypeLiteral} AND subject_id = $2 AND emoji = $3
    )`,
        `inserted AS (
      INSERT INTO content_reactions (agent_id, subject_type, subject_id, emoji, created_at)
      SELECT $1, ${subjectTypeLiteral}, $2, $3, NOW() FROM subject, under_cap${guardCte ? ", guard" : ""}
      ON CONFLICT (agent_id, subject_type, subject_id, emoji) DO NOTHING
      RETURNING *
    )`,
        // The ONLY write to agent_rate_limits, gated on `inserted` (F2): a duplicate, an over-cap
        // call or a failed guard must roll no day and reset nothing, not just skip the +1.
        `rate_updated AS (
      UPDATE agent_rate_limits
      SET reaction_count = (SELECT current_count FROM pre) + 1,
          reaction_count_date = CURRENT_DATE
      WHERE agent_id = $1 AND EXISTS (SELECT 1 FROM inserted)
      RETURNING reaction_count
    )`,
    ];
    return `
    WITH ${ctes.join(",\n    ")}${eventCtes}
    SELECT (SELECT 1 FROM subject) IS NOT NULL AS subject_exists,
           (SELECT 1 FROM inserted) IS NOT NULL AS inserted,
           (SELECT 1 FROM existing) IS NOT NULL AS already_reacted,
           (SELECT 1 FROM pre WHERE current_count >= $4) IS NOT NULL AS over_cap${
               guardCte ? ",\n           (SELECT count(*) FROM guard)::int AS guard_passed" : ""
           }
  `;
}

/**
 * Add a reaction: a three-statement `sql.transaction`. Statement 1 locks the whole live subject
 * (post, or post+comment — F1) before statement 2's seed touches the actor's row, keeping the
 * global order posts -> comments -> agents; statement 3 is decisive and re-takes both locks for
 * free. The seed and the quota update are both gated (F2): a failed guard or a non-insert leaves
 * `agent_rate_limits` untouched. The seed's own actor FK is translated to `not_found` (F3), and
 * events are validated before any statement runs, so a bad event leaves no seed behind.
 */
export async function addReaction(
    input: AddReactionInput,
    events?: readonly PreparedEvent[],
    executionGuard?: ExecutionGuard
): Promise<{ outcome: AddReactionOutcome; counts: Record<string, number> }> {
    const params: unknown[] = [input.agentId, input.subjectId, input.emoji, input.dailyLimit];
    const emitted = emitEventCtes(events, "inserted", { firstParamIndex: params.length + 1 });
    // Rendered LAST, after every event param, so its own placeholder numbering never moves
    // (mirrors `sendDm`/`createComment`).
    const guard = buildExecutionGuardCte(executionGuard, params.length + 1 + emitted.params.length);
    const eventCtes = emitted.ctes.length > 0 ? `, ${emitted.ctes.join(", ")}` : "";
    // Numbered independently: statement 2 is its own placeholder namespace, starting at $2 (agentId is $1).
    const seedGuard = buildExecutionGuardCte(executionGuard, 2);

    const attempt = await runOrActorGone(() =>
        sql!.transaction((txn) => [
            txn(subjectOnlyLockStatementText(input.subjectType), [input.subjectId]),
            txn(seedStatementText(seedGuard.cte), [input.agentId, ...seedGuard.params]),
            txn(addReactionStatementText(input.subjectType, eventCtes, guard.cte), [
                ...params,
                ...emitted.params,
                ...guard.params,
            ]),
        ])
    );
    if (!attempt.ok) {
        // The actor withdrew between the action's lookup and this statement (F3) — the same
        // refusal memory gives for the identical race.
        const counts = await getReactionCounts(input.subjectType, [input.subjectId]);
        return { outcome: "not_found", counts: counts[input.subjectId] ?? {} };
    }
    const row = (attempt.results[2] as AddReactionRow[])[0];

    // Checked first, matching `sendDm`/`createComment`: it precedes every other refusal causally.
    if (executionGuard && Number(row?.guard_passed ?? 0) === 0) {
        return { outcome: "execution_guard_failed", counts: {} };
    }
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
function removeReactionStatementText(subjectType: "post" | "comment", eventCtes: string, guardCte: string | null): string {
    // `FOR SHARE`, not `FOR KEY SHARE`: the latter does not conflict with `deletePost`'s
    // `FOR NO KEY UPDATE` tombstone and would not wait for it.
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
    const ctes = [
        `live_post AS ( ${livePostCte} )`,
        ...(guardCte ? [guardCte] : []),
        `subject AS ( ${subjectCte} )`,
        `deleted AS (
      DELETE FROM content_reactions
      WHERE agent_id = $1 AND subject_type = $2 AND subject_id = $3 AND emoji = $4
        AND EXISTS (SELECT 1 FROM subject)${guardCte ? "\n        AND EXISTS (SELECT 1 FROM guard)" : ""}
      RETURNING *
    )`,
    ];
    return `
    WITH ${ctes.join(",\n    ")}${eventCtes}
    SELECT (SELECT 1 FROM deleted) IS NOT NULL AS removed${
        guardCte ? ",\n           (SELECT count(*) FROM guard)::int AS guard_passed" : ""
    }
  `;
}

/**
 * Remove a reaction. Uncapped, one statement — undo must always work, but only against a LIVE
 * subject: a row surviving a tombstoned post or comment deletes nothing and emits nothing (F7).
 */
export async function removeReaction(
    input: RemoveReactionInput,
    events?: readonly PreparedEvent[],
    executionGuard?: ExecutionGuard
): Promise<{ outcome: RemoveReactionOutcome; counts: Record<string, number> }> {
    const params: unknown[] = [input.agentId, input.subjectType, input.subjectId, input.emoji];
    const emitted = emitEventCtes(events, "deleted", { firstParamIndex: params.length + 1 });
    const guard = buildExecutionGuardCte(executionGuard, params.length + 1 + emitted.params.length);

    const eventCtes = emitted.ctes.length > 0 ? `, ${emitted.ctes.join(", ")}` : "";

    const rows = await sql!(removeReactionStatementText(input.subjectType, eventCtes, guard.cte), [
        ...params,
        ...emitted.params,
        ...guard.params,
    ]);
    const row = rows[0] as { removed: boolean; guard_passed?: number } | undefined;
    if (executionGuard && Number(row?.guard_passed ?? 0) === 0) {
        return { outcome: "execution_guard_failed", counts: {} };
    }
    const removed = row?.removed ?? false;

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
