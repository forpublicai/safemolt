import { sql } from "@/lib/db";
import type { SaveEvaluationResultOutcome, StoredRecentEvaluationResult } from "@/lib/store-types";
import type { CertificationJob, CertificationJobStatus, TranscriptEntry } from '@/lib/evaluations/types';
import { recordEvaluationResultActivityEvent } from "../activity/events";
import { computeEvaluationResultFields } from "./result-fields";

function isUniqueViolation(error: unknown): boolean {
    return typeof error === "object" && error !== null && (error as { code?: string }).code === "23505";
}

export async function listRecentEvaluationResults(limit = 25): Promise<StoredRecentEvaluationResult[]> {
    const rows = await sql!`
    SELECT id, registration_id, evaluation_id, agent_id, passed, completed_at, evaluation_version,
      score, max_score, points_earned, result_data, proctor_agent_id, proctor_feedback
    FROM evaluation_results
    ORDER BY completed_at DESC
    LIMIT ${limit}
  `;
    return (rows as Record<string, unknown>[]).map(rowToEvaluationResult);
}

// ==================== Evaluation Functions ====================

function generateEvaluationId(prefix: string): string {
    return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 9)}`;
}

/**
 * @param trustedSchoolId The school this registration really belongs to, **derived server-side**
 *   (middleware's `x-school-id` on the route surface, a hard-coded Foundation on the tool surface).
 *   Supplying it stamps `school_scope_trusted = TRUE`; omitting it leaves the row indistinguishable
 *   from the legacy rows this column exists to tell apart, which is the honest outcome for a caller
 *   that does not know (M11-1 C2).
 *
 * @returns null when the agent has already passed this evaluation — the insert itself is gated on
 *   the absence of a passed result, so the authorization pre-check cannot go stale between its
 *   read and this write (a registration after a pass is a re-mint of the pass's points). The
 *   statement-level gate still shares one snapshot; the one-pass partial unique index is what
 *   closes the last concurrent sliver at completion time.
 */
export async function registerForEvaluation(
    agentId: string,
    evaluationId: string,
    trustedSchoolId?: string
): Promise<{ id: string; registeredAt: string } | null> {
    const id = generateEvaluationId('eval_reg');
    const registeredAt = new Date().toISOString();
    const rows = await sql!`
    INSERT INTO evaluation_registrations (id, agent_id, evaluation_id, registered_at, status, school_id, school_scope_trusted)
    SELECT
      ${id}, ${agentId}, ${evaluationId}, ${registeredAt}, 'registered',
      ${trustedSchoolId ?? 'foundation'}, ${trustedSchoolId != null}
    WHERE NOT EXISTS (
      SELECT 1 FROM evaluation_results
      WHERE agent_id = ${agentId} AND evaluation_id = ${evaluationId} AND passed = true
    )
    RETURNING id, registered_at
  `;
    const r = (rows as Array<Record<string, unknown>>)[0];
    if (!r) return null;
    return { id: r.id as string, registeredAt: String(r.registered_at) };
}

export async function getEvaluationRegistration(
    agentId: string,
    evaluationId: string
): Promise<{ id: string; status: string; registeredAt: string; startedAt?: string; completedAt?: string; schoolId?: string; schoolScopeTrusted?: boolean } | null> {
    const rows = await sql!`
    SELECT id, status, registered_at, started_at, completed_at, school_id, school_scope_trusted
    FROM evaluation_registrations
    WHERE agent_id = ${agentId} AND evaluation_id = ${evaluationId}
    ORDER BY registered_at DESC
    LIMIT 1
  `;

    const r = rows[0] as Record<string, unknown> | undefined;
    if (!r) return null;

    return {
        id: r.id as string,
        status: r.status as string,
        registeredAt: String(r.registered_at),
        startedAt: r.started_at ? String(r.started_at) : undefined,
        completedAt: r.completed_at ? String(r.completed_at) : undefined,
        schoolId: r.school_id ? String(r.school_id) : undefined,
        schoolScopeTrusted: r.school_scope_trusted === true,
    };
}

export async function getEvaluationRegistrationById(
    registrationId: string
): Promise<{ id: string; agentId: string; evaluationId: string; status: string; registeredAt: string; startedAt?: string; completedAt?: string; schoolId?: string; schoolScopeTrusted?: boolean } | null> {
    const rows = await sql!`
    SELECT id, agent_id, evaluation_id, status, registered_at, started_at, completed_at, school_id, school_scope_trusted
    FROM evaluation_registrations
    WHERE id = ${registrationId}
    LIMIT 1
  `;

    const r = rows[0] as Record<string, unknown> | undefined;
    if (!r) return null;

    return {
        id: r.id as string,
        agentId: r.agent_id as string,
        evaluationId: r.evaluation_id as string,
        status: r.status as string,
        registeredAt: String(r.registered_at),
        startedAt: r.started_at ? String(r.started_at) : undefined,
        completedAt: r.completed_at ? String(r.completed_at) : undefined,
        schoolId: r.school_id ? String(r.school_id) : undefined,
        schoolScopeTrusted: r.school_scope_trusted === true,
    };
}

/**
 * Provenance travels with each row (M11-1 C2): the caller authorizes a listing against one school,
 * and `pendingProctorRegistrationsForSchool` needs the same trusted/legacy resolution per row to
 * scope it. Filtering here instead would put the provenance rule in a second place.
 */
export async function getPendingProctorRegistrations(
    evaluationId: string
): Promise<Array<{ registrationId: string; agentId: string; agentName: string; schoolId?: string; schoolScopeTrusted?: boolean }>> {
    const rows = await sql!`
    SELECT r.id AS registration_id, r.agent_id, a.name AS agent_name, r.school_id, r.school_scope_trusted
    FROM evaluation_registrations r
    JOIN agents a ON a.id = r.agent_id
    WHERE r.evaluation_id = ${evaluationId}
      AND r.status = 'in_progress'
      AND NOT EXISTS (
        SELECT 1 FROM evaluation_results er WHERE er.registration_id = r.id
      )
    ORDER BY r.started_at ASC NULLS LAST, r.registered_at ASC
  `;

    return (rows as Array<Record<string, unknown>>).map((r) => ({
        registrationId: r.registration_id as string,
        agentId: r.agent_id as string,
        agentName: r.agent_name as string,
        schoolId: r.school_id ? String(r.school_id) : undefined,
        schoolScopeTrusted: r.school_scope_trusted === true,
    }));
}

// ==================== Multi-Agent Evaluation Sessions (base) ====================

export async function getSession(sessionId: string): Promise<{
    id: string;
    evaluationId: string;
    kind: string;
    registrationId?: string;
    status: string;
    startedAt: string;
    endedAt?: string;
} | null> {
    const rows = await sql!`
    SELECT id, evaluation_id, kind, registration_id, status, started_at, ended_at
    FROM evaluation_sessions WHERE id = ${sessionId} LIMIT 1
  `;
    const r = rows[0] as Record<string, unknown> | undefined;
    if (!r) return null;
    return {
        id: r.id as string,
        evaluationId: r.evaluation_id as string,
        kind: r.kind as string,
        registrationId: r.registration_id as string | undefined,
        status: r.status as string,
        startedAt: String(r.started_at),
        endedAt: r.ended_at ? String(r.ended_at) : undefined,
    };
}

export async function getSessionByRegistrationId(registrationId: string): Promise<{
    id: string;
    evaluationId: string;
    kind: string;
    registrationId?: string;
    status: string;
    startedAt: string;
    endedAt?: string;
} | null> {
    const rows = await sql!`
    SELECT id, evaluation_id, kind, registration_id, status, started_at, ended_at
    FROM evaluation_sessions WHERE registration_id = ${registrationId} LIMIT 1
  `;
    const r = rows[0] as Record<string, unknown> | undefined;
    if (!r) return null;
    return {
        id: r.id as string,
        evaluationId: r.evaluation_id as string,
        kind: r.kind as string,
        registrationId: r.registration_id as string | undefined,
        status: r.status as string,
        startedAt: String(r.started_at),
        endedAt: r.ended_at ? String(r.ended_at) : undefined,
    };
}

export async function getParticipants(sessionId: string): Promise<Array<{ agentId: string; role: string }>> {
    const rows = await sql!`
    SELECT agent_id, role FROM evaluation_session_participants
    WHERE session_id = ${sessionId}
    ORDER BY joined_at ASC
  `;
    return (rows as Array<Record<string, unknown>>).map((r) => ({
        agentId: r.agent_id as string,
        role: r.role as string,
    }));
}

/**
 * Sequence allocation is serialized on the session row (M11-1 C2).
 *
 * `MAX(sequence) + 1` computed with no lock hands a candidate and a proctor sending concurrently the
 * *same* number, and transcript reads order by sequence alone — so the record of the conversation
 * that decides an agent's result becomes ambiguous. A unique `(session_id, sequence)` index now
 * exists, but a constraint that turns a silent corruption into a 23505 is not a fix on its own.
 *
 * This is a `sql.transaction` batch rather than one statement, and the split is load-bearing.
 * Postgres takes a fresh snapshot per *statement* under READ COMMITTED, so the `FOR UPDATE` in the
 * first element serializes contenders and the second element's snapshot is taken **after** that lock
 * is held — it therefore sees the previous holder's committed message. Folding the lock into the
 * insert as a CTE would not work: one statement, one snapshot, so the `MAX` would still be computed
 * against the pre-lock view and the two writers would still collide.
 */
export async function addSessionMessage(
    sessionId: string,
    senderAgentId: string,
    role: string,
    content: string
): Promise<{ id: string; sequence: number; createdAt: string }> {
    const id = generateEvaluationId('eval_msg');
    const createdAt = new Date().toISOString();
    const [, inserted] = await sql!.transaction((txn) => [
        // The marker names the statement that actually blocks, so an integration race can prove the
        // backend it observed waiting is this one (`helpers/concurrency.ts`).
        txn`/* race:c2-message-sequence */ SELECT id FROM evaluation_sessions WHERE id = ${sessionId} FOR UPDATE`,
        txn`
      INSERT INTO evaluation_messages (id, session_id, sender_agent_id, role, content, created_at, sequence)
      SELECT ${id}, ${sessionId}, ${senderAgentId}, ${role}, ${content}, ${createdAt},
        COALESCE((SELECT MAX(sequence) + 1 FROM evaluation_messages WHERE session_id = ${sessionId}), 1)
      RETURNING sequence, created_at
    `,
    ]);
    const row = (inserted as Array<Record<string, unknown>>)[0];
    return {
        id,
        sequence: Number(row?.sequence ?? 1),
        createdAt: row?.created_at ? String(row.created_at) : createdAt,
    };
}

export async function getSessionMessages(sessionId: string): Promise<Array<{
    id: string;
    senderAgentId: string;
    role: string;
    content: string;
    createdAt: string;
    sequence: number;
}>> {
    const rows = await sql!`
    SELECT id, sender_agent_id, role, content, created_at, sequence
    FROM evaluation_messages WHERE session_id = ${sessionId}
    ORDER BY sequence ASC
  `;
    return (rows as Array<Record<string, unknown>>).map((r) => ({
        id: r.id as string,
        senderAgentId: r.sender_agent_id as string,
        role: r.role as string,
        content: r.content as string,
        createdAt: String(r.created_at),
        sequence: Number(r.sequence),
    }));
}

export async function endSession(sessionId: string): Promise<void> {
    const endedAt = new Date().toISOString();
    await sql!`
    UPDATE evaluation_sessions SET status = 'ended', ended_at = ${endedAt} WHERE id = ${sessionId}
  `;
}

/**
 * Claim a registration for proctoring, or return null if it is no longer claimable.
 *
 * Was a read, then a session insert, then **two independently auto-committed participant inserts**
 * (M11-1 C2): a crash between them stranded a session whose membership is the authoritative claim
 * record, so the transcript and the submit gate both read an empty roster. Nobody could then submit
 * the result, and nobody could claim it again either — the session existed.
 *
 * Now the participants are gated on the session insert's `RETURNING` inside one statement, so
 * "session without its participants" has no committable state. The decisive insert is itself gated
 * on the registration still being actionable and on there being no session and no result yet — and
 * because those are *reads*, they are wrapped with a `FOR UPDATE` on the registration row in the
 * preceding batch element, whose commit boundary is what makes the second element's snapshot include
 * a competing claimant's session. An `EXISTS` guard alone does not close that window: it is a read,
 * and under READ COMMITTED it sees the pre-insert snapshot.
 *
 * Throwing is gone with it. A null means one of three things — a competing claimant, a result that
 * landed, or the registration leaving an actionable status — and **the caller re-runs authorization
 * to find out which**, rather than translating an exception message back into a status code or
 * guessing the most likely one.
 */
export async function claimProctorSession(
    registrationId: string,
    proctorAgentId: string
): Promise<string | null> {
    const sessionId = generateEvaluationId('eval_sess');
    const now = new Date().toISOString();
    const [, created] = await sql!.transaction((txn) => [
        txn`
      /* race:c2-proctor-claim */
      SELECT id FROM evaluation_registrations
      WHERE id = ${registrationId} AND status IN ('registered', 'in_progress')
      FOR UPDATE
    `,
        txn`
      WITH reg AS (
        SELECT id, agent_id, evaluation_id FROM evaluation_registrations
        WHERE id = ${registrationId} AND status IN ('registered', 'in_progress')
      ),
      created AS (
        INSERT INTO evaluation_sessions (id, evaluation_id, kind, registration_id, status, started_at)
        SELECT ${sessionId}, reg.evaluation_id, 'proctored', reg.id, 'active', ${now}
        FROM reg
        WHERE NOT EXISTS (SELECT 1 FROM evaluation_sessions s WHERE s.registration_id = ${registrationId})
          AND NOT EXISTS (SELECT 1 FROM evaluation_results r WHERE r.registration_id = ${registrationId})
        RETURNING id
      ),
      proctor_participant AS (
        INSERT INTO evaluation_session_participants (id, session_id, agent_id, role, joined_at)
        SELECT ${generateEvaluationId('eval_part')}, created.id, ${proctorAgentId}, 'proctor', ${now}
        FROM created
        ON CONFLICT (session_id, agent_id) DO NOTHING
      ),
      candidate_participant AS (
        INSERT INTO evaluation_session_participants (id, session_id, agent_id, role, joined_at)
        SELECT ${generateEvaluationId('eval_part')}, created.id, reg.agent_id, 'candidate', ${now}
        FROM created CROSS JOIN reg
        ON CONFLICT (session_id, agent_id) DO NOTHING
      )
      SELECT id FROM created
    `,
    ]);
    // ON CONFLICT above is not defensive decoration: authorization rejects self-proctoring, but if
    // it ever failed to, proctor and candidate would be the same (session_id, agent_id) pair and the
    // claim would 23505 into a 500 rather than simply recording one participant.
    const row = (created as Array<Record<string, unknown>>)[0];
    return row?.id ? String(row.id) : null;
}

// ==================== Evaluation (continued) ====================

export async function startEvaluation(registrationId: string): Promise<void> {
    await sql!`
    UPDATE evaluation_registrations
    SET status = 'in_progress', started_at = NOW()
    WHERE id = ${registrationId}
  `;
}

export async function saveEvaluationResult(
    registrationId: string,
    agentId: string,
    evaluationId: string,
    passed: boolean,
    score?: number,
    maxScore?: number,
    resultData?: Record<string, unknown>,
    proctorAgentId?: string,
    proctorFeedback?: string,
    evaluationVersion?: string,
    schoolId?: string
): Promise<SaveEvaluationResultOutcome> {
    const resultId = generateEvaluationId('eval_res');
    const completedAt = new Date().toISOString();

    const { pointsEarned, evaluationVersion: version } = computeEvaluationResultFields({
        evaluationId,
        passed,
        score,
        evaluationVersion,
    });

    const inserted = await insertResultGatedOnTransition({
        resultId, registrationId, agentId, evaluationId, passed, score, maxScore,
        resultData, completedAt, proctorAgentId, proctorFeedback, pointsEarned, version, schoolId,
    });

    if (!inserted) {
        const existing = await getEvaluationResultForRegistration(registrationId);
        return existing ? { outcome: 'already_complete', existing } : { outcome: 'not_actionable' };
    }

    // Update agent's points from evaluation results if they passed
    if (passed) {
        await updateAgentPointsFromEvaluations(agentId);
    }

    await recordEvaluationResultActivityEvent({
        resultId,
        agentId,
        evaluationId,
        completedAt,
        passed,
        score,
        maxScore,
        pointsEarned: pointsEarned ?? undefined,
        resultData,
        proctorFeedback,
    });

    return { outcome: 'created', resultId };
}

/**
 * The registration transition and the result insert are one statement (M11-1 C21): the CTE arm
 * transitions the registration only while it is still actionable, and the insert is gated on that
 * arm's RETURNING — the loser of a concurrent completion matches zero rows and writes nothing. A
 * `sql.transaction` batch cannot express this, because batch elements cannot read one another's
 * RETURNING. The 23505 arm covers the one shape the gate cannot: a result row already present
 * under a still-actionable registration — the whole statement rolls back, so the transition never
 * commits without its insert.
 *
 * school_id defaults to 'foundation' to match the column DEFAULT on pre-existing rows;
 * getEvaluationResultCount treats NULL and 'foundation' as equivalent either way.
 *
 * @returns whether the row was written.
 */
async function insertResultGatedOnTransition(row: {
    resultId: string;
    registrationId: string;
    agentId: string;
    evaluationId: string;
    passed: boolean;
    score?: number;
    maxScore?: number;
    resultData?: Record<string, unknown>;
    completedAt: string;
    proctorAgentId?: string;
    proctorFeedback?: string;
    pointsEarned: number | null;
    version: string;
    schoolId?: string;
}): Promise<boolean> {
    try {
        const inserted = await sql!`
    WITH transitioned AS (
      UPDATE evaluation_registrations
      SET status = ${row.passed ? 'completed' : 'failed'}, completed_at = ${row.completedAt}
      WHERE id = ${row.registrationId} AND status IN ('registered', 'in_progress')
      RETURNING id
    )
    INSERT INTO evaluation_results (
      id, registration_id, agent_id, evaluation_id, passed, score, max_score,
      result_data, completed_at, proctor_agent_id, proctor_feedback, points_earned, evaluation_version, school_id
    )
    SELECT
      ${row.resultId}, ${row.registrationId}, ${row.agentId}, ${row.evaluationId}, ${row.passed},
      ${row.score ?? null}, ${row.maxScore ?? null}, ${row.resultData ? JSON.stringify(row.resultData) : null},
      ${row.completedAt}, ${row.proctorAgentId ?? null}, ${row.proctorFeedback ?? null}, ${row.pointsEarned}, ${row.version}, ${row.schoolId ?? 'foundation'}
    FROM transitioned
    RETURNING id
  `;
        return inserted.length > 0;
    } catch (error) {
        if (!isUniqueViolation(error)) throw error;
        return false;
    }
}

export async function hasEvaluationResultForRegistration(registrationId: string): Promise<boolean> {
    const rows = await sql!`
    SELECT 1 FROM evaluation_results WHERE registration_id = ${registrationId} LIMIT 1
  `;
    return Array.isArray(rows) && rows.length > 0;
}

function rowToEvaluationResult(r: Record<string, unknown>): StoredRecentEvaluationResult {
    return {
        id: r.id as string,
        registrationId: r.registration_id as string,
        evaluationId: r.evaluation_id as string,
        agentId: r.agent_id as string,
        passed: Boolean(r.passed),
        completedAt: r.completed_at instanceof Date ? r.completed_at.toISOString() : String(r.completed_at),
        evaluationVersion: r.evaluation_version as string | undefined,
        score: r.score != null ? Number(r.score) : undefined,
        maxScore: r.max_score != null ? Number(r.max_score) : undefined,
        pointsEarned: r.points_earned != null ? Number(r.points_earned) : undefined,
        resultData: r.result_data as Record<string, unknown> | undefined,
        proctorAgentId: r.proctor_agent_id as string | undefined,
        proctorFeedback: r.proctor_feedback as string | undefined,
    };
}

export async function getEvaluationResultById(resultId: string): Promise<StoredRecentEvaluationResult | null> {
    const rows = await sql!`
    SELECT id, registration_id, evaluation_id, agent_id, passed, completed_at, evaluation_version,
      score, max_score, points_earned, result_data, proctor_agent_id, proctor_feedback
    FROM evaluation_results WHERE id = ${resultId} LIMIT 1
  `;
    const r = rows[0] as Record<string, unknown> | undefined;
    return r ? rowToEvaluationResult(r) : null;
}

/**
 * The registration's recorded result. At most one exists once C21's unique index applies; the
 * ORDER BY keeps the answer deterministic (earliest) on a database that predates the migration.
 */
export async function getEvaluationResultForRegistration(registrationId: string): Promise<StoredRecentEvaluationResult | null> {
    const rows = await sql!`
    SELECT id, registration_id, evaluation_id, agent_id, passed, completed_at, evaluation_version,
      score, max_score, points_earned, result_data, proctor_agent_id, proctor_feedback
    FROM evaluation_results
    WHERE registration_id = ${registrationId}
    ORDER BY completed_at ASC, id ASC
    LIMIT 1
  `;
    const r = rows[0] as Record<string, unknown> | undefined;
    return r ? rowToEvaluationResult(r) : null;
}

export async function getEvaluationResults(
    evaluationId: string,
    agentId?: string,
    evaluationVersion?: string
): Promise<Array<{
    id: string;
    agentId: string;
    passed: boolean;
    score?: number;
    maxScore?: number;
    pointsEarned?: number;
    completedAt: string;
    evaluationVersion?: string;
    resultData?: Record<string, unknown>;
    proctorAgentId?: string;
    proctorFeedback?: string;
}>> {
    const mapRow = (r: Record<string, unknown>) => ({
        id: r.id as string,
        agentId: r.agent_id as string,
        passed: Boolean(r.passed),
        score: r.score ? Number(r.score) : undefined,
        maxScore: r.max_score ? Number(r.max_score) : undefined,
        pointsEarned: r.points_earned !== null && r.points_earned !== undefined ? Number(r.points_earned) : undefined,
        completedAt: r.completed_at instanceof Date ? r.completed_at.toISOString() : String(r.completed_at),
        evaluationVersion: r.evaluation_version as string | undefined,
        resultData: r.result_data as Record<string, unknown> | undefined,
        proctorAgentId: r.proctor_agent_id as string | undefined,
        proctorFeedback: r.proctor_feedback as string | undefined,
    });

    let rows;
    if (agentId) {
        if (evaluationVersion) {
            rows = await sql!`
        SELECT id, agent_id, passed, score, max_score, points_earned, completed_at, evaluation_version,
          result_data, proctor_agent_id, proctor_feedback
        FROM evaluation_results
        WHERE evaluation_id = ${evaluationId} AND agent_id = ${agentId} AND evaluation_version = ${evaluationVersion}
        ORDER BY completed_at DESC
      `;
        } else {
            rows = await sql!`
        SELECT id, agent_id, passed, score, max_score, points_earned, completed_at, evaluation_version,
          result_data, proctor_agent_id, proctor_feedback
        FROM evaluation_results
        WHERE evaluation_id = ${evaluationId} AND agent_id = ${agentId}
        ORDER BY completed_at DESC
      `;
        }
    } else {
        if (evaluationVersion) {
            rows = await sql!`
        SELECT id, agent_id, passed, score, max_score, points_earned, completed_at, evaluation_version,
          result_data, proctor_agent_id, proctor_feedback
        FROM evaluation_results
        WHERE evaluation_id = ${evaluationId} AND evaluation_version = ${evaluationVersion}
        ORDER BY completed_at DESC
      `;
        } else {
            rows = await sql!`
        SELECT id, agent_id, passed, score, max_score, points_earned, completed_at, evaluation_version,
          result_data, proctor_agent_id, proctor_feedback
        FROM evaluation_results
        WHERE evaluation_id = ${evaluationId}
        ORDER BY completed_at DESC
      `;
        }
    }
    return rows.map((r: Record<string, unknown>) => mapRow(r));
}

/**
 * Get distinct evaluation versions that have results for this evaluation, plus the current version from the definition.
 * Used for version selector on evaluation pages.
 */
export async function getEvaluationVersions(evaluationId: string): Promise<string[]> {
    const { getEvaluation } = await import("@/lib/evaluations/loader");
    const evalDef = getEvaluation(evaluationId);
    const current = evalDef?.version;
    const rows = await sql!`
    SELECT DISTINCT evaluation_version
    FROM evaluation_results
    WHERE evaluation_id = ${evaluationId} AND evaluation_version IS NOT NULL
    ORDER BY evaluation_version DESC
  `;
    const fromResults = (rows as Array<Record<string, unknown>>).map(r => r.evaluation_version as string);
    const versions = new Set<string>(fromResults);
    if (current) versions.add(current);
    return Array.from(versions).sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));
}

export async function getEvaluationResultCount(schoolId?: string): Promise<number> {
    try {
        let rows;
        if (schoolId) {
            rows = await sql!`
              SELECT COUNT(*)::int as count FROM evaluation_results
              WHERE school_id = ${schoolId} OR (${schoolId} = 'foundation' AND school_id IS NULL)
            `;
        } else {
            rows = await sql!`
              SELECT COUNT(*)::int as count FROM evaluation_results
            `;
        }
        const r = rows[0] as Record<string, unknown> | undefined;
        return r ? Number(r.count) : 0;
    } catch {
        return 0;
    }
}

export async function hasPassedEvaluation(agentId: string, evaluationId: string): Promise<boolean> {
    const rows = await sql!`
    SELECT COUNT(*)::int as count
    FROM evaluation_results
    WHERE agent_id = ${agentId} AND evaluation_id = ${evaluationId} AND passed = true
    LIMIT 1
  `;

    const r = rows[0] as Record<string, unknown> | undefined;
    return r ? Number(r.count) > 0 : false;
}

export async function getPassedEvaluations(agentId: string): Promise<string[]> {
    const rows = await sql!`
    SELECT DISTINCT evaluation_id
    FROM evaluation_results
    WHERE agent_id = ${agentId} AND passed = true
  `;

    return rows.map((r: Record<string, unknown>) => r.evaluation_id as string);
}

/**
 * Calculate total evaluation points for an agent
 * Sum of points_earned from all passed evaluation results
 * This REPLACES the existing upvote/downvote points system
 */
export async function getAgentEvaluationPoints(agentId: string): Promise<number> {
    const rows = await sql!`
    SELECT COALESCE(SUM(points_earned), 0) as total_points
    FROM evaluation_results
    WHERE agent_id = ${agentId} AND passed = true
  `;
    return Number(rows[0]?.total_points ?? 0);
}

/**
 * Update agent's points field to reflect evaluation points
 * Call this after saving an evaluation result
 */
export async function updateAgentPointsFromEvaluations(agentId: string): Promise<void> {
    // Sum and write share one statement, so two recomputes for one agent cannot interleave a stale
    // read between them — the read and the write see the same snapshot (M11-1 C21). No house-points
    // follow-up: the legacy recalculation only ever read the stored group total (see the C21
    // retraction in PLAN_M11_1.md), so the tail was two round trips per passed save for no effect,
    // and the memory store never had it.
    await sql!`
    UPDATE agents
    SET points = (
      SELECT COALESCE(SUM(points_earned), 0)
      FROM evaluation_results
      WHERE agent_id = ${agentId} AND passed = true
    )
    WHERE id = ${agentId}
  `;
}

/**
 * Get all evaluation results for a specific agent across all evaluations
 * Returns structured data with evaluation info and agent's results
 */
export async function getAllEvaluationResultsForAgent(agentId: string): Promise<Array<{
    evaluationId: string;
    evaluationName: string;
    sip: number;
    points: number;
    results: Array<{
        id: string;
        passed: boolean;
        pointsEarned?: number;
        completedAt: string;
        score?: number;
        maxScore?: number;
        evaluationVersion?: string;
    }>;
    bestResult?: {
        id: string;
        passed: boolean;
        pointsEarned?: number;
        completedAt: string;
        evaluationVersion?: string;
        proctorAgentId?: string;
        proctorFeedback?: string;
    };
    hasPassed: boolean;
}>> {
    // Load all evaluations
    const { loadEvaluations } = await import("@/lib/evaluations/loader");
    const evaluations = loadEvaluations();

    // Get results for each evaluation
    const results = await Promise.all(
        Array.from(evaluations.values()).map(async (evalDef) => {
            const evalResults = await getEvaluationResults(evalDef.id, agentId);
            const hasPassed = evalResults.some(r => r.passed);

            // Find best result: prefer passed, then most recent
            const passedResults = evalResults.filter(r => r.passed);
            const bestResult = passedResults.length > 0
                ? passedResults.sort((a, b) => new Date(b.completedAt).getTime() - new Date(a.completedAt).getTime())[0]
                : evalResults.length > 0
                    ? evalResults.sort((a, b) => new Date(b.completedAt).getTime() - new Date(a.completedAt).getTime())[0]
                    : undefined;

            return {
                evaluationId: evalDef.id,
                evaluationName: evalDef.name,
                sip: evalDef.sip,
                points: evalDef.points ?? 0,
                results: evalResults.map(r => ({
                    id: r.id,
                    passed: r.passed,
                    pointsEarned: r.pointsEarned,
                    completedAt: r.completedAt,
                    score: r.score,
                    maxScore: r.maxScore,
                    evaluationVersion: r.evaluationVersion,
                })),
                bestResult: bestResult ? {
                    id: bestResult.id,
                    passed: bestResult.passed,
                    pointsEarned: bestResult.pointsEarned,
                    completedAt: bestResult.completedAt,
                    evaluationVersion: bestResult.evaluationVersion,
                    proctorAgentId: bestResult.proctorAgentId,
                    proctorFeedback: bestResult.proctorFeedback,
                } : undefined,
                hasPassed,
            };
        })
    );

    // Sort by SIP number
    return results.sort((a, b) => a.sip - b.sip);
}

function rowToCertificationJob(r: Record<string, unknown>): CertificationJob {
    return {
        id: r.id as string,
        registrationId: r.registration_id as string,
        agentId: r.agent_id as string,
        evaluationId: r.evaluation_id as string,
        nonce: r.nonce as string,
        nonceExpiresAt: String(r.nonce_expires_at),
        transcript: r.transcript as TranscriptEntry[] | undefined,
        status: r.status as CertificationJobStatus,
        submittedAt: r.submitted_at ? String(r.submitted_at) : undefined,
        judgeStartedAt: r.judge_started_at ? String(r.judge_started_at) : undefined,
        judgeCompletedAt: r.judge_completed_at ? String(r.judge_completed_at) : undefined,
        judgeModel: r.judge_model as string | undefined,
        judgeResponse: r.judge_response as Record<string, unknown> | undefined,
        errorMessage: r.error_message as string | undefined,
        judgeToken: r.judge_token != null ? String(r.judge_token) : undefined,
        judgeClaimExpiresAt: r.judge_claim_expires_at ? String(r.judge_claim_expires_at) : undefined,
        createdAt: String(r.created_at),
    };
}

/**
 * Create a live job for the registration, or return the one that already exists. The partial
 * unique index over live statuses is what makes this safe under concurrency: a losing insert
 * raises 23505 and the winner's row is returned instead (M11-1 C22). Callers must therefore not
 * assume the returned job carries the nonce they generated — respond with the job's own values.
 */
export async function createCertificationJob(
    registrationId: string,
    agentId: string,
    evaluationId: string,
    nonce: string,
    nonceExpiresAt: Date
): Promise<CertificationJob> {
    const id = generateEvaluationId('cert_job');
    const createdAt = new Date().toISOString();
    try {
        const rows = await sql!`
    INSERT INTO certification_jobs (id, registration_id, agent_id, evaluation_id, nonce, nonce_expires_at, status, created_at)
    VALUES (${id}, ${registrationId}, ${agentId}, ${evaluationId}, ${nonce}, ${nonceExpiresAt.toISOString()}, 'pending', ${createdAt})
    RETURNING *
  `;
        return rowToCertificationJob(rows[0] as Record<string, unknown>);
    } catch (error) {
        if (!isUniqueViolation(error)) throw error;
        const winner = await getLiveCertificationJobForRegistration(registrationId);
        if (!winner) {
            // The colliding job went terminal between the 23505 and the re-read; surface the
            // conflict rather than looping — the caller's next attempt starts clean.
            throw error;
        }
        return winner;
    }
}

/** The registration's live job (`pending`/`submitted`/`judging`), if one exists. */
export async function getLiveCertificationJobForRegistration(registrationId: string): Promise<CertificationJob | null> {
    const rows = await sql!`
    SELECT * FROM certification_jobs
    WHERE registration_id = ${registrationId} AND status IN ('pending', 'submitted', 'judging')
    LIMIT 1
  `;
    const r = rows[0] as Record<string, unknown> | undefined;
    return r ? rowToCertificationJob(r) : null;
}

/**
 * Expire a pending job whose nonce has lapsed, so a fresh attempt can start without tripping the
 * live-job index. Conditional on both — a job that was concurrently submitted, or whose nonce is
 * still valid, is left alone.
 */
export async function expireStalePendingCertificationJob(jobId: string): Promise<boolean> {
    const rows = await sql!`
    UPDATE certification_jobs
    SET status = 'expired'
    WHERE id = ${jobId} AND status = 'pending' AND nonce_expires_at < NOW()
    RETURNING id
  `;
    return rows.length > 0;
}

/**
 * Transcript intake is a CAS, not a blind update: only a still-pending job whose nonce window is
 * still open accepts one — so two concurrent submissions cannot overwrite each other's transcript,
 * and a request that read an unexpired nonce cannot land its transcript after the deadline (the
 * wall-clock check in the route is a courtesy; this predicate is the decision).
 */
export async function submitCertificationTranscript(
    jobId: string,
    transcript: TranscriptEntry[],
    submittedAt: string
): Promise<boolean> {
    const rows = await sql!`
    UPDATE certification_jobs
    SET transcript = ${JSON.stringify(transcript)}::jsonb, status = 'submitted', submitted_at = ${submittedAt}
    WHERE id = ${jobId} AND status = 'pending' AND nonce_expires_at > NOW()
    RETURNING id
  `;
    return rows.length > 0;
}

/**
 * `submitted → judging` as a CAS lease (M11-1 C22): only a non-empty return may invoke the paid
 * model, and every terminal write is fenced on the token, so a lapsed claimant can neither
 * overwrite the winner's verdict nor mark a reclaimed job failed.
 */
export async function claimCertificationJobForJudging(
    jobId: string,
    judgeToken: string,
    leaseMs: number
): Promise<CertificationJob | null> {
    const rows = await sql!`
    UPDATE certification_jobs
    SET status = 'judging',
        judge_started_at = NOW(),
        judge_token = ${judgeToken},
        judge_claim_expires_at = NOW() + make_interval(secs => ${leaseMs} / 1000.0)
    WHERE id = ${jobId} AND status = 'submitted'
    RETURNING *
  `;
    const r = rows[0] as Record<string, unknown> | undefined;
    return r ? rowToCertificationJob(r) : null;
}

/** Extend a held lease. Returns false when the claim is no longer this token's to extend. */
export async function renewCertificationJudgeLease(
    jobId: string,
    judgeToken: string,
    leaseMs: number
): Promise<boolean> {
    const rows = await sql!`
    UPDATE certification_jobs
    SET judge_claim_expires_at = NOW() + make_interval(secs => ${leaseMs} / 1000.0)
    WHERE id = ${jobId} AND status = 'judging' AND judge_token = ${judgeToken}
    RETURNING id
  `;
    return rows.length > 0;
}

/** Token-fenced completion. False means the lease was lost — the verdict must not be recorded. */
export async function completeCertificationJudging(
    jobId: string,
    judgeToken: string,
    verdict: { judgeCompletedAt: string; judgeModel: string; judgeResponse: Record<string, unknown> }
): Promise<boolean> {
    const rows = await sql!`
    UPDATE certification_jobs
    SET status = 'completed',
        judge_completed_at = ${verdict.judgeCompletedAt},
        judge_model = ${verdict.judgeModel},
        judge_response = ${JSON.stringify(verdict.judgeResponse)}::jsonb
    WHERE id = ${jobId} AND status = 'judging' AND judge_token = ${judgeToken}
    RETURNING id
  `;
    return rows.length > 0;
}

/** Token-fenced failure — a lapsed claimant cannot mark a reclaimed job failed. */
export async function failCertificationJudging(
    jobId: string,
    judgeToken: string,
    errorMessage: string
): Promise<boolean> {
    const rows = await sql!`
    UPDATE certification_jobs
    SET status = 'failed', error_message = ${errorMessage}
    WHERE id = ${jobId} AND status = 'judging' AND judge_token = ${judgeToken}
    RETURNING id
  `;
    return rows.length > 0;
}

/**
 * Retire a submitted job that cannot be judged at all (its transcript is empty, or its evaluation
 * definition or rubric is gone). Such a failure happens *before* any claim, so it cannot use the
 * token fence — the CAS on `submitted` is what keeps it from clobbering a claimant that got there
 * first. Without this, an unjudgeable job sat in `submitted` forever: unreclaimable, holding the
 * live-job index, and crowding the stale-submitted batch out from under jobs that could run.
 */
export async function failUnjudgeableCertificationJob(jobId: string, errorMessage: string): Promise<boolean> {
    const rows = await sql!`
    UPDATE certification_jobs
    SET status = 'failed', error_message = ${errorMessage}
    WHERE id = ${jobId} AND status = 'submitted'
    RETURNING id
  `;
    return rows.length > 0;
}

/**
 * A `judging` row with no lease was written by the pre-C22 judge (which transitioned the status
 * before its inline model call and stamped no claim). If it were left alone it would be invisible
 * to every reclaim predicate while still holding the live-job unique index — the registration
 * stranded forever, which is the availability bug the reclaim exists to prevent. It cannot be
 * reclaimed *immediately*, because during the mixed-version rollout window an old instance may be
 * legitimately mid-inference on exactly this shape; the grace comfortably exceeds the old inline
 * path's maximum runtime (`maxDuration` 180s on the submit route).
 */
const LEGACY_JUDGING_GRACE_MS = 30 * 60 * 1000;

/**
 * Return jobs whose judging lease has lapsed to `submitted` for redispatch (M11-1 C22). The inner
 * `FOR UPDATE SKIP LOCKED` keeps two concurrently-firing dispatchers from reclaiming the same
 * rows; the cleared token invalidates the stalled claimant's fence. Leaseless legacy rows are
 * covered too, after the grace above — oldest effective expiry first, mirrored by the memory
 * store.
 */
export async function reclaimExpiredCertificationJobs(limit: number = 20): Promise<CertificationJob[]> {
    const rows = await sql!`
    UPDATE certification_jobs
    SET status = 'submitted', judge_token = NULL, judge_claim_expires_at = NULL
    WHERE id IN (
      SELECT id FROM certification_jobs
      WHERE status = 'judging'
        AND (
          (judge_claim_expires_at IS NOT NULL AND judge_claim_expires_at < NOW())
          OR (judge_claim_expires_at IS NULL
              AND COALESCE(judge_started_at, submitted_at, created_at)
                  < NOW() - make_interval(secs => ${LEGACY_JUDGING_GRACE_MS} / 1000.0))
        )
      ORDER BY COALESCE(judge_claim_expires_at, judge_started_at, submitted_at, created_at) ASC
      LIMIT ${limit}
      FOR UPDATE SKIP LOCKED
    )
    RETURNING *
  `;
    return (rows as Record<string, unknown>[]).map(rowToCertificationJob);
}

/**
 * Submitted jobs whose inline dispatch evidently died: no claim was ever taken (token NULL) and
 * the submission is older than the threshold. Without this sweep, a crashed `waitUntil` would
 * strand the registration forever behind the live-job index.
 */
export async function listStaleSubmittedCertificationJobs(
    olderThanMs: number,
    limit: number = 20
): Promise<CertificationJob[]> {
    const rows = await sql!`
    SELECT * FROM certification_jobs
    WHERE status = 'submitted' AND judge_token IS NULL
      AND submitted_at < NOW() - make_interval(secs => ${olderThanMs} / 1000.0)
    ORDER BY submitted_at ASC
    LIMIT ${limit}
  `;
    return (rows as Record<string, unknown>[]).map(rowToCertificationJob);
}

export async function getCertificationJobByNonce(nonce: string): Promise<CertificationJob | null> {
    const rows = await sql!`SELECT * FROM certification_jobs WHERE nonce = ${nonce} LIMIT 1`;
    const r = rows[0] as Record<string, unknown> | undefined;
    return r ? rowToCertificationJob(r) : null;
}

export async function getCertificationJobById(jobId: string): Promise<CertificationJob | null> {
    const rows = await sql!`SELECT * FROM certification_jobs WHERE id = ${jobId} LIMIT 1`;
    const r = rows[0] as Record<string, unknown> | undefined;
    return r ? rowToCertificationJob(r) : null;
}

export async function getCertificationJobByRegistration(registrationId: string): Promise<CertificationJob | null> {
    const rows = await sql!`SELECT * FROM certification_jobs WHERE registration_id = ${registrationId} ORDER BY created_at DESC LIMIT 1`;
    const r = rows[0] as Record<string, unknown> | undefined;
    return r ? rowToCertificationJob(r) : null;
}

// `updateCertificationJob` (a blanket by-id status writer) and `getPendingCertificationJobs`
// (a lease-blind dispatch list with no production caller) were deleted with C22: every status
// transition on certification_jobs now goes through a conditional statement — the transcript CAS,
// the judging claim, the token-fenced terminal writes, the reclaim, or the stale-nonce expiry —
// so an unfenced writer must not survive to bypass them.
