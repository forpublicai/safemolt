import { sql } from "@/lib/db";
import type { NeonQueryFunctionInTransaction } from "@neondatabase/serverless";
import type {
    EvaluationStartEffectInput,
    EvaluationStartOutcome,
    EvaluationRegistrationOutcome,
    SaveEvaluationResultInput,
    SaveEvaluationResultOutcome,
    StoredRecentEvaluationResult,
} from "@/lib/store-types";
import type { CertificationJob, CertificationJobStatus, TranscriptEntry } from '@/lib/evaluations/types';
import {
    buildEvaluationResultActivityUpsert,
    invalidateEvaluationResultActivityCache,
} from "../activity/events";
import type { PreparedEvent } from "@/lib/events/kinds";
import { emitEventCtes, sqlParam, sqlPayloadObject } from "../events/statement";
import { computeEvaluationResultFields } from "./result-fields";

/** The query tag inside a `sql.transaction` batch, for helpers that build one of its elements. */
type EvaluationsTxn = NeonQueryFunctionInTransaction<false, false>;

function isExpectedResultUniquenessViolation(error: unknown): boolean {
    if (typeof error !== "object" || error === null) return false;
    const e = error as { code?: string; constraint?: string };
    return e.code === "23505" && (
        e.constraint === "idx_eval_results_registration_uniq" ||
        e.constraint === "idx_eval_results_one_pass"
    );
}

function isUniqueViolation(error: unknown): boolean {
    return typeof error === "object" && error !== null && (error as { code?: string }).code === "23505";
}

function isActiveRegistrationViolation(error: unknown): boolean {
    if (typeof error !== "object" || error === null) return false;
    const e = error as { code?: string; constraint?: string };
    return e.code === "23505" && e.constraint === "idx_eval_reg_active";
}

async function classifyRegistrationAfterActiveConflict(agentId: string, evaluationId: string): Promise<EvaluationRegistrationOutcome> {
    const rows = await sql!`
      SELECT r.id, r.registered_at, r.status, true AS already_passed
      FROM evaluation_results er
      JOIN evaluation_registrations r ON r.id = er.registration_id
      WHERE er.agent_id = ${agentId} AND er.evaluation_id = ${evaluationId} AND er.passed = true
      ORDER BY er.completed_at DESC LIMIT 1
    `;
    const passed = rows[0] as Record<string, unknown> | undefined;
    if (passed) return { kind: "already_passed", id: String(passed.id), registeredAt: String(passed.registered_at) };
    const active = await sql!`
      SELECT id, registered_at, status
      FROM evaluation_registrations
      WHERE agent_id = ${agentId} AND evaluation_id = ${evaluationId}
        AND status IN ('registered', 'in_progress')
      ORDER BY registered_at DESC LIMIT 1
    `;
    const existing = active[0] as Record<string, unknown> | undefined;
    if (existing) {
        const id = String(existing.id);
        const registeredAt = String(existing.registered_at);
        const status = existing.status as "registered" | "in_progress";
        return { kind: "existing", id, registeredAt, registration: { id, registeredAt, status } };
    }
    throw new Error("Active registration conflict disappeared before classification");
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
    trustedSchoolId?: string,
    events?: readonly PreparedEvent[]
): Promise<EvaluationRegistrationOutcome> {
    const id = generateEvaluationId('eval_reg');
    const registeredAt = new Date().toISOString();
    const params: unknown[] = [id, agentId, evaluationId, registeredAt, trustedSchoolId ?? 'foundation', trustedSchoolId != null];
    // `evaluation.registered` rides the insert's own `RETURNING`, so the pass-gated refusal above
    // writes nothing and emits nothing. `subject_id` is store-assigned — the registration id is
    // minted here (`$1`), after the action decided the event — and it stays a bound parameter.
    const emitted = emitEventCtes(events, "registered", {
        firstParamIndex: params.length + 1,
        overrides: events?.length ? [{ columnSql: { subject_id: sqlParam(1, "text") } }] : [],
    });
    const query = `
    WITH passed AS (
      SELECT r.id, r.registered_at, r.status
      FROM evaluation_results er
      JOIN evaluation_registrations r ON r.id = er.registration_id
      WHERE er.agent_id = $2::text AND er.evaluation_id = $3::text AND er.passed = true
      ORDER BY er.completed_at DESC LIMIT 1
    ), existing AS (
      SELECT id, registered_at, status FROM evaluation_registrations
      WHERE agent_id = $2::text AND evaluation_id = $3::text
        AND status IN ('registered', 'in_progress')
      ORDER BY registered_at DESC LIMIT 1
    ), registered AS (
      INSERT INTO evaluation_registrations (id, agent_id, evaluation_id, registered_at, status, school_id, school_scope_trusted)
      SELECT $1::text, $2::text, $3::text, $4::timestamptz, 'registered', $5::text, $6::boolean
      WHERE NOT EXISTS (SELECT 1 FROM passed) AND NOT EXISTS (SELECT 1 FROM existing)
      RETURNING id, registered_at, status
    )${emitted.ctes.length > 0 ? `, ${emitted.ctes.join(", ")}` : ""}
    SELECT id, registered_at, status, false AS created, true AS already_passed FROM passed
    UNION ALL
    SELECT id, registered_at, status, false, false FROM existing
    WHERE NOT EXISTS (SELECT 1 FROM passed)
    UNION ALL
    SELECT id, registered_at, status, true, false FROM registered
    WHERE NOT EXISTS (SELECT 1 FROM passed) AND NOT EXISTS (SELECT 1 FROM existing)
  `;
    let transactionResults: Awaited<ReturnType<NonNullable<typeof sql>["transaction"]>>;
    try {
        transactionResults = await sql!.transaction((txn) => [
            txn`SELECT id FROM agents WHERE id = ${agentId} FOR UPDATE`,
            txn(query, [...params, ...emitted.params]),
        ]);
    } catch (error) {
        if (isActiveRegistrationViolation(error)) return classifyRegistrationAfterActiveConflict(agentId, evaluationId);
        throw error;
    }
    const rows = transactionResults[1] as Array<Record<string, unknown>>;
    const r = (rows as Array<Record<string, unknown>>)[0];
    if (r?.already_passed === true) {
        return { kind: "already_passed", id: String(r.id), registeredAt: String(r.registered_at) };
    }
    if (r?.created === true) { const id = r.id as string; const registeredAt = String(r.registered_at); return { kind: "created", id, registeredAt, registration: { id, registeredAt, status: "registered" } }; }
    if (r?.id) { const id = String(r.id); const registeredAt = String(r.registered_at); const status = r.status as "registered" | "in_progress"; return { kind: "existing", id, registeredAt, registration: { id, registeredAt, status } }; }
    return { kind: "already_passed", id: "", registeredAt: "" };
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
    content: string,
    events?: readonly PreparedEvent[]
): Promise<{ id: string; sequence: number; createdAt: string; role: string } | null> {
    const id = generateEvaluationId('eval_msg');
    const createdAt = new Date().toISOString();
    void role;
    const params: unknown[] = [id, sessionId, senderAgentId, content, createdAt];
    // `evaluation.session_message` rides ELEMENT 2 — the insert, which is the decisive mutation;
    // element 1 is a lock that decides nothing. `message_id` is store-assigned (`$1`), and the
    // CONTENT is deliberately not in the payload: a transcript is content, and a payload copy of it
    // would outlive every deletion path the platform has.
    const emitted = emitEventCtes(events, "inserted", {
        firstParamIndex: params.length + 1,
        overrides: events?.length
            ? [{ payloadMergeSql: sqlPayloadObject({ message_id: sqlParam(1, "text") }) }]
            : [],
    });
    const [, , inserted] = await sql!.transaction((txn) => [
        // Match D4's agent-first order. The message INSERT has an agent FK, so taking this
        // compatible lock before the session lock avoids agent -> session / session -> agent
        // deadlocks with completion.
        txn`/* race:c2-message-agent */ SELECT id FROM agents WHERE id = ${senderAgentId} FOR KEY SHARE`,
        // The marker names the statement that actually blocks, so an integration race can prove the
        // backend it observed waiting is this one (`helpers/concurrency.ts`).
        txn`/* race:c2-message-sequence */ SELECT id FROM evaluation_sessions WHERE id = ${sessionId} FOR UPDATE`,
        txn(
            `
      WITH inserted AS (
        INSERT INTO evaluation_messages (id, session_id, sender_agent_id, role, content, created_at, sequence)
        SELECT $1::text, $2::text, $3::text, participant.role, $4::text, $5::timestamptz,
          COALESCE((SELECT MAX(sequence) + 1 FROM evaluation_messages WHERE session_id = $2::text), 1)
        FROM evaluation_sessions AS session
        JOIN evaluation_session_participants AS participant
          ON participant.session_id = session.id AND participant.agent_id = $3::text
        WHERE session.id = $2::text AND session.status = 'active'
        RETURNING sequence, created_at, role
      )${emitted.ctes.length > 0 ? `, ${emitted.ctes.join(", ")}` : ""}
      SELECT sequence, created_at, role FROM inserted
    `,
            [...params, ...emitted.params]
        ),
    ]);
    const row = (inserted as Array<Record<string, unknown>>)[0];
    if (!row) return null;
    return {
        id,
        sequence: Number(row?.sequence ?? 1),
        createdAt: row?.created_at ? String(row.created_at) : createdAt,
        role: String(row.role),
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
    proctorAgentId: string,
    events?: readonly PreparedEvent[]
): Promise<string | null> {
    const sessionId = generateEvaluationId('eval_sess');
    const proctorParticipantId = generateEvaluationId('eval_part');
    const candidateParticipantId = generateEvaluationId('eval_part');
    const now = new Date().toISOString();
    const params: unknown[] = [registrationId, sessionId, now, proctorAgentId, proctorParticipantId, candidateParticipantId];
    // Gated on `created` — the same CTE the participants are gated on — so a competing claimant, a
    // landed result and a registration that left an actionable status all emit nothing. The
    // session id is store-assigned (`$2`); the subject is the registration, which the action knows.
    const emitted = emitEventCtes(events, "created", {
        firstParamIndex: params.length + 1,
        overrides: events?.length
            ? [{ payloadMergeSql: sqlPayloadObject({ session_id: sqlParam(2, "text") }) }]
            : [],
    });
    const [, , created] = await sql!.transaction((txn) => [
        // Global order: AGENTS, then registration, then session/participants. The candidate id
        // comes from the registration, but the rows themselves are locked before the registration.
        txn`
          SELECT id FROM agents
          WHERE id = ${proctorAgentId}
             OR id = (SELECT agent_id FROM evaluation_registrations WHERE id = ${registrationId})
          ORDER BY id
          FOR UPDATE
        `,
        txn`
      /* race:c2-proctor-claim */
      SELECT id FROM evaluation_registrations
      WHERE id = ${registrationId} AND status IN ('registered', 'in_progress')
      FOR UPDATE
    `,
        txn(
            `
      WITH reg AS (
        SELECT id, agent_id, evaluation_id FROM evaluation_registrations
        WHERE id = $1::text AND status IN ('registered', 'in_progress')
      ),
      created AS (
        INSERT INTO evaluation_sessions (id, evaluation_id, kind, registration_id, status, started_at)
        SELECT $2::text, reg.evaluation_id, 'proctored', reg.id, 'active', $3::timestamptz
        FROM reg
        WHERE NOT EXISTS (SELECT 1 FROM evaluation_sessions s WHERE s.registration_id = $1::text)
          AND NOT EXISTS (SELECT 1 FROM evaluation_results r WHERE r.registration_id = $1::text)
        RETURNING id
      ),
      proctor_participant AS (
        INSERT INTO evaluation_session_participants (id, session_id, agent_id, role, joined_at)
        SELECT $5::text, created.id, $4::text, 'proctor', $3::timestamptz
        FROM created
        ON CONFLICT (session_id, agent_id) DO NOTHING
      ),
      candidate_participant AS (
        INSERT INTO evaluation_session_participants (id, session_id, agent_id, role, joined_at)
        SELECT $6::text, created.id, reg.agent_id, 'candidate', $3::timestamptz
        FROM created CROSS JOIN reg
        ON CONFLICT (session_id, agent_id) DO NOTHING
      )${emitted.ctes.length > 0 ? `, ${emitted.ctes.join(", ")}` : ""}
      SELECT id FROM created
    `,
            [...params, ...emitted.params]
        ),
    ]);
    // ON CONFLICT above is not defensive decoration: authorization rejects self-proctoring, but if
    // it ever failed to, proctor and candidate would be the same (session_id, agent_id) pair and the
    // claim would 23505 into a 500 rather than simply recording one participant.
    const row = (created as Array<Record<string, unknown>>)[0];
    return row?.id ? String(row.id) : null;
}

// ==================== Evaluation (continued) ====================

/**
 * M11-1b D4 — a CAS, not an unconditional write.
 *
 * The route reads `registered` and then called this with no condition, so a submit that completed
 * in the gap was dragged back: `completed` -> `in_progress`, which reopens a finished registration
 * and lets its result be superseded. `registered` is the only state a start may leave, and
 * re-starting an already-started registration is a no-op rather than a fresh `started_at`.
 *
 * @returns whether this call performed the transition. `false` means the registration was not
 *   `registered` — already started, already terminal, or gone.
 */
export async function startEvaluation(
    registrationId: string,
    events?: readonly PreparedEvent[]
): Promise<boolean> {
    const params: unknown[] = [registrationId];
    // Gated on the CAS itself: a re-start, a terminal registration and a missing one all match zero
    // rows, write nothing and emit nothing.
    const emitted = emitEventCtes(events, "started", {
        firstParamIndex: params.length + 1,
        overrides: events?.length ? [{ columnSql: { subject_id: sqlParam(1, "text") } }] : [],
    });
    const rows = await sql!(
        `
    WITH started AS (
      UPDATE evaluation_registrations
      SET status = 'in_progress', started_at = NOW()
      WHERE id = $1::text AND status = 'registered'
      RETURNING id
    )${emitted.ctes.length > 0 ? `, ${emitted.ctes.join(", ")}` : ""}
    SELECT id FROM started
  `,
        [...params, ...emitted.params]
    );
    return rows.length > 0;
}

/** CAS plus the flow's durable row. The event is gated on the complete operation, not only the CAS. */
export async function startEvaluationWithEffect(
    registrationId: string,
    effect: EvaluationStartEffectInput,
    events?: readonly PreparedEvent[]
): Promise<EvaluationStartOutcome> {
    const isPoaw = effect.kind === "poaw";
    const id = isPoaw ? effect.challengeId : generateEvaluationId("cert_job");
    const params: unknown[] = isPoaw
        ? [registrationId, effect.challengeId, JSON.stringify(effect.values), effect.nonce, effect.expectedHash, effect.createdAt, effect.expiresAt]
        : [registrationId, id, effect.agentId, effect.evaluationId, effect.nonce, effect.nonceExpiresAt];
    const emitted = emitEventCtes(events, "started", {
        firstParamIndex: params.length + 1,
        overrides: events?.length ? [{ columnSql: { subject_id: sqlParam(1, "text") } }] : [],
    });
    const query = isPoaw
        ? `/* start-evaluation-with-effect */ WITH locked AS (
              SELECT id, agent_id, status FROM evaluation_registrations WHERE id = $1::text FOR UPDATE
            ), existing AS (
              SELECT vc.* FROM vetting_challenges vc JOIN locked l ON l.agent_id = vc.agent_id
              WHERE vc.consumed_at IS NULL AND vc.expires_at > NOW()
              ORDER BY vc.created_at DESC LIMIT 1
            ), started AS (
              UPDATE evaluation_registrations r SET status = 'in_progress', started_at = NOW()
              FROM locked l WHERE r.id = l.id AND l.status = 'registered' RETURNING r.id
            ), effect AS (
              INSERT INTO vetting_challenges (id, agent_id, "values", nonce, expected_hash, created_at, expires_at)
              SELECT $2::text, l.agent_id, $3::jsonb, $4::text, $5::text, $6::timestamptz, $7::timestamptz
              FROM locked l WHERE l.status = 'registered' AND NOT EXISTS (SELECT 1 FROM existing)
              RETURNING id, agent_id, "values", nonce, expected_hash, created_at, expires_at
            )${emitted.ctes.length > 0 ? `, ${emitted.ctes.join(", ")}` : ""}
            SELECT started.id AS started_id,
                   COALESCE(existing.id, effect.id) AS challenge_id,
                   COALESCE(existing.agent_id, effect.agent_id) AS agent_id,
                   COALESCE(existing.values, effect.values) AS values,
                   COALESCE(existing.nonce, effect.nonce) AS nonce,
                   COALESCE(existing.expected_hash, effect.expected_hash) AS expected_hash,
                   COALESCE(existing.created_at, effect.created_at) AS created_at,
                   COALESCE(existing.expires_at, effect.expires_at) AS expires_at,
                   (effect.id IS NOT NULL) AS created
            FROM locked LEFT JOIN existing ON true LEFT JOIN effect ON true LEFT JOIN started ON true`
        : `/* start-evaluation-with-effect */ WITH locked AS (
              SELECT id, agent_id, status FROM evaluation_registrations WHERE id = $1::text FOR UPDATE
            ), live AS (
              SELECT cj.* FROM certification_jobs cj JOIN locked l ON l.id = cj.registration_id
              WHERE cj.status IN ('pending', 'submitted', 'judging', 'completed')
              ORDER BY cj.created_at DESC LIMIT 1 FOR UPDATE OF cj
            ), refreshed AS (
              UPDATE certification_jobs cj
              SET nonce = $5::text, nonce_expires_at = $6::timestamptz, created_at = NOW(), status = 'pending'
              FROM live
              WHERE cj.id = live.id AND live.status = 'pending' AND live.nonce_expires_at <= NOW()
              RETURNING cj.*
            ), created AS (
              INSERT INTO certification_jobs (id, registration_id, agent_id, evaluation_id, nonce, nonce_expires_at, status, created_at)
              SELECT $2::text, l.id, $3::text, $4::text, $5::text, $6::timestamptz, 'pending', NOW()
              FROM locked l
              WHERE l.status IN ('registered', 'in_progress') AND NOT EXISTS (SELECT 1 FROM live)
              RETURNING *
            ), selected AS (
              SELECT 'refreshed'::text AS arm, r.* FROM refreshed r
              UNION ALL
              SELECT 'created'::text, c.* FROM created c
              UNION ALL
              SELECT 'existing_job'::text, l.* FROM live l
              WHERE NOT EXISTS (SELECT 1 FROM refreshed) AND NOT EXISTS (SELECT 1 FROM created)
            ), started AS (
              UPDATE evaluation_registrations r SET status = 'in_progress', started_at = NOW()
              WHERE r.id = $1::text AND r.status = 'registered' AND EXISTS (SELECT 1 FROM selected)
              RETURNING r.id
            )${emitted.ctes.length > 0 ? `, ${emitted.ctes.join(", ")}` : ""}
            SELECT started.id AS started_id, selected.arm, selected.id AS job_id, selected.registration_id,
                   selected.agent_id, selected.evaluation_id, selected.nonce, selected.nonce_expires_at,
                   selected.status, selected.created_at
            FROM selected LEFT JOIN started ON true`;
    const transactionResults = await sql!.transaction((txn) => [
        // D4 completion locks the acting/candidate agent before the registration. Keep this order
        // for both PoAW and certification starts; ORDER BY prevents crossed two-agent starts.
        txn`
          /* start-evaluation-with-effect */
          SELECT id FROM agents
          WHERE id = (SELECT agent_id FROM evaluation_registrations WHERE id = ${registrationId})
             OR id = ${isPoaw ? registrationId : effect.agentId}::text
          ORDER BY id
          FOR UPDATE
        `,
        txn`SELECT id FROM evaluation_registrations WHERE id = ${registrationId} FOR UPDATE`,
        txn(query, [...params, ...emitted.params]),
    ]);
    const rows = transactionResults[2] as Array<Record<string, unknown>>;
    // The PoAW projection carries no job_id column — its zero-row result alone means "refused".
    if (rows.length === 0 || (isPoaw && !rows[0]?.challenge_id) || (!isPoaw && !rows[0]?.job_id)) return { kind: "none", started: false };
    if (isPoaw) {
        const row = rows[0] as Record<string, unknown>;
        const challenge = { id: String(row.challenge_id), agentId: String(row.agent_id), values: row.values as number[], nonce: String(row.nonce), expectedHash: String(row.expected_hash), createdAt: new Date(String(row.created_at)).toISOString(), expiresAt: new Date(String(row.expires_at)).toISOString(), fetched: false, consumed: false };
        return row.created === true ? { kind: "created", started: true, challenge } : { kind: "existing_challenge", started: Boolean(row.started_id), challenge };
    }
    const row = rows[0] as Record<string, unknown>;
    const job: CertificationJob = {
        id: String(row.job_id), registrationId: String(row.registration_id), agentId: String(row.agent_id),
        evaluationId: String(row.evaluation_id), nonce: String(row.nonce), nonceExpiresAt: new Date(String(row.nonce_expires_at)).toISOString(),
        status: row.status as CertificationJobStatus, createdAt: new Date(String(row.created_at)).toISOString(),
    };
    const arm = String(row.arm) as "created" | "refreshed" | "existing_job";
    return { kind: arm, started: Boolean(row.started_id), certificationJob: job };
}

export async function saveEvaluationResult(input: SaveEvaluationResultInput): Promise<SaveEvaluationResultOutcome> {
    const resultId = generateEvaluationId('eval_res');
    const completedAt = new Date().toISOString();

    const { pointsEarned, evaluationVersion: version } = computeEvaluationResultFields({
        evaluationId: input.evaluationId,
        passed: input.passed,
        score: input.score,
        evaluationVersion: input.evaluationVersion,
    });

    const inserted = await completeRegistrationAtomically({
        row: { ...input, resultId, completedAt, pointsEarned, version },
        endProctorSessionId: input.endProctorSessionId,
        consumeChallengeId: input.consumeChallengeId,
        certificationJobId: input.certificationJobId,
        certificationJudgeToken: input.certificationJudgeToken,
        certificationJudgeCompletedAt: input.certificationJudgeCompletedAt,
        certificationJudgeModel: input.certificationJudgeModel,
        certificationJudgeResponse: input.certificationJudgeResponse,
        events: input.events,
    });

    if (!inserted) {
        const existing = await getEvaluationResultForRegistration(input.registrationId);
        return existing ? { outcome: 'already_complete', existing } : { outcome: 'not_actionable' };
    }

    // The only thing left outside the transaction: invalidating a cache for a transaction that
    // rolled back would be wrong, so it waits until the write is known to have committed.
    await invalidateEvaluationResultActivityCache(resultId);

    return { outcome: 'created', resultId };
}

/**
 * M11-1b D4 — completion as ONE transaction: the agent lock, the gated transition-plus-insert, the
 * points recompute, the activity row, and the proctor session end.
 *
 * **The agent lock is element 1, and it does two jobs.**
 *
 * 1. *Points.* The recompute is a `SUM` over `evaluation_results` followed by an agent update.
 *    Making it a later batch element fixes only self-visibility: two concurrent completions for the
 *    same agent on DIFFERENT registrations each sum a snapshot excluding the other, and the last
 *    writer wins — points lost permanently. `FOR UPDATE` on the agent row makes same-agent
 *    completions serialize, and because each statement in a transaction takes a fresh snapshot, the
 *    loser's recompute runs after the winner committed and sees both results.
 *
 * 2. *A pre-existing 40P01, closed.* Before D4 the completion's first write was the registration
 *    update, and the result insert's `agent_id` FK then took an implicit `FOR KEY SHARE` on the
 *    agent — order `evaluation_registrations -> agents`. M11-1 C14's vetting batch opens with
 *    `SELECT ... FROM agents ... FOR UPDATE` and then updates the registration — order
 *    `agents -> evaluation_registrations`. `FOR UPDATE` conflicts with `FOR KEY SHARE`, so a
 *    vetting run and an ordinary completion for one agent could deadlock and one request 500ed.
 *    Taking the agent row FIRST, with the same `FOR UPDATE` C14 uses, puts both writers in one
 *    global order. This is why the lock cannot be weakened to `FOR NO KEY UPDATE` here even though
 *    that is the gentler mode elsewhere: it must be the mode C14 already takes, or the two orders
 *    are only half-aligned.
 *
 * Every element after the decisive one re-gates on the result row, because fixed batch elements
 * execute even when the decisive element returned zero rows. Without that, a LOSING completion
 * would still end the proctor session and still project an activity row.
 *
 * **M11-2 P1.4 folds the PoAW challenge into this transaction, and the lock order is C14's.**
 * The executor used to consume the challenge before the route ever reached this function, so a
 * crash in between burned a valid challenge with no result to show for it. Now the executor only
 * validates and the challenge travels here as `consumeChallengeId`: the challenge row is LOCKED as
 * element 2 — `agents -> vetting_challenges`, the same global order the C14 vetting batch takes, so
 * the two can never deadlock against each other — the decisive statement refuses outright unless
 * the challenge is still unconsumed, and consumption is the LAST element, gated on the result row.
 * A failure anywhere rolls consumption back with everything else, which is the whole point.
 *
 * The lock is filtered on `consumed_at IS NULL` deliberately: a consumed challenge takes no lock,
 * the decisive statement's own `EXISTS` then refuses, and the caller reports the standing result
 * (or `not_actionable`) exactly as it does for any other loser. Expiry is NOT re-checked here —
 * `consumeVettingChallenge` never checked it either, and the executor owns that clock, so adding it
 * would silently narrow a window the surfaces publish as 15 seconds from the JS side only.
 */
async function completeRegistrationAtomically(input: {
    row: Parameters<typeof buildResultInsertGatedOnTransition>[0];
    endProctorSessionId?: string;
    consumeChallengeId?: string;
    certificationJobId?: string;
    certificationJudgeToken?: string;
    certificationJudgeCompletedAt?: string;
    certificationJudgeModel?: string;
    certificationJudgeResponse?: Record<string, unknown>;
    events?: readonly PreparedEvent[];
}): Promise<boolean> {
    const { row } = input;
    const challengeId = input.consumeChallengeId ?? null;
    const recompute = buildAgentPointsRecompute(row.agentId, row.resultId);
    const activity = buildEvaluationResultActivityUpsert(
        {
            resultId: row.resultId,
            agentId: row.agentId,
            evaluationId: row.evaluationId,
            completedAt: row.completedAt,
            passed: row.passed,
            score: row.score,
            maxScore: row.maxScore,
            pointsEarned: row.pointsEarned ?? undefined,
            resultData: row.resultData,
            proctorFeedback: row.proctorFeedback,
        },
        { requireCommitted: true }
    );

    // The decisive element's position moves with the optional challenge lock, so it is computed
    // rather than written as a literal `1`: a hard-coded index that silently pointed at the lock
    // would report every completion as refused.
    const decisiveIndex = challengeId === null ? 1 : 2;
    const certificationJobId = input.certificationJobId ?? null;
    const certificationJudgeToken = input.certificationJudgeToken ?? null;
    const certificationParams = [
        certificationJobId,
        certificationJudgeToken,
        input.certificationJudgeCompletedAt ?? null,
        input.certificationJudgeModel ?? null,
        input.certificationJudgeResponse ? JSON.stringify(input.certificationJudgeResponse) : null,
    ];

    try {
        const results = await sql!.transaction((txn) => [
            txn`/* d4:completion-agent-lock */
              SELECT id FROM agents
              WHERE id = ${row.agentId}
                 OR (${row.proctorAgentId ?? null}::text IS NOT NULL AND id = ${row.proctorAgentId ?? null}::text)
              ORDER BY id
              FOR UPDATE`,
            ...(challengeId === null
                ? []
                : [
                      txn`/* d4:completion-challenge-lock */ SELECT id FROM vetting_challenges WHERE id = ${challengeId} AND consumed_at IS NULL FOR UPDATE`,
                  ]),
            buildResultInsertGatedOnTransition(row, challengeId, input.events, certificationParams)(txn),
            // The recompute is delta-based and floors at zero (M11-1C); running it for a failed
            // result is a no-op, so it is unconditional apart from the result-row gate.
            txn(recompute.text, recompute.params),
            txn(activity.text, activity.params),
            // Proctored completion used to call `endSession` AFTER `saveEvaluationResult` returned,
            // so a failure between them stranded a completed registration with an active session.
            // It is an element now, gated on the winning result like everything else.
            txn`
              UPDATE evaluation_sessions
              SET status = 'ended', ended_at = NOW()
              WHERE id = ${input.endProctorSessionId ?? null}
                AND EXISTS (SELECT 1 FROM evaluation_results WHERE id = ${row.resultId})
            `,
            // LAST, and gated on the result row: a completion that wrote nothing consumes nothing,
            // so a losing racer's challenge stays spendable.
            ...(challengeId === null
                ? []
                : [
                      txn`
              UPDATE vetting_challenges SET consumed_at = NOW()
              WHERE id = ${challengeId} AND consumed_at IS NULL
                AND EXISTS (SELECT 1 FROM evaluation_results WHERE id = ${row.resultId})
            `,
                  ]),
        ]);
        return (results[decisiveIndex] as unknown[]).length > 0;
    } catch (error) {
        // A result row already present under a still-actionable registration: the whole transaction
        // rolls back, so the transition never commits without its insert (M11-1 C21).
        if (!isExpectedResultUniquenessViolation(error)) throw error;
        return false;
    }
}

/**
 * The decisive element: the registration transition and the result insert as ONE statement
 * (M11-1 C21). The CTE arm transitions the registration only while it is still actionable, and the
 * insert is gated on that arm's `RETURNING` — the loser of a concurrent completion matches zero
 * rows and writes nothing. This cannot be split into two batch elements, because batch elements
 * cannot read one another's `RETURNING`.
 *
 * Returned as a function of the transaction's query tag so it can be an element of D4's completion
 * batch rather than a standalone auto-commit. The 23505 case is handled by the caller, which owns
 * the transaction the violation rolls back.
 *
 * school_id defaults to 'foundation' to match the column DEFAULT on pre-existing rows;
 * getEvaluationResultCount treats NULL and 'foundation' as equivalent either way.
 *
 * **`evaluation.completed` is gated on the INSERT, not on the transition arm** (M11-2 P1.4). In
 * committed state the two are the same gate — the insert reads `FROM transitioned`, and a 23505 on
 * the insert rolls the transition back with it — but the payload names `result_id`, and an event
 * gated on the transition alone could describe a result row that the same transaction then failed
 * to write. `result_id` is store-assigned (`$4`): the id is minted inside `saveEvaluationResult`,
 * after the action has already decided the event.
 *
 * **The challenge gate is part of the DECISION, not a follow-up check.** With a challenge supplied,
 * the transition only fires while that challenge is unconsumed, so a replayed PoAW submit writes no
 * result at all rather than writing one and failing to consume.
 */
function buildResultInsertGatedOnTransition(
    row: {
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
    },
    consumeChallengeId: string | null = null,
    events?: readonly PreparedEvent[],
    certificationParams: unknown[] = []
) {
    const params: unknown[] = [
        row.passed ? 'completed' : 'failed',
        row.completedAt,
        row.registrationId,
        row.resultId,
        row.agentId,
        row.evaluationId,
        row.passed,
        row.score ?? null,
        row.maxScore ?? null,
        row.resultData ? JSON.stringify(row.resultData) : null,
        row.proctorAgentId ?? null,
        row.proctorFeedback ?? null,
        row.pointsEarned,
        row.version,
        row.schoolId ?? 'foundation',
        consumeChallengeId,
        ...certificationParams,
    ];
    const emitted = emitEventCtes(events, "inserted", {
        firstParamIndex: params.length + 1,
        overrides: events?.length
            ? [{ payloadMergeSql: sqlPayloadObject({ result_id: sqlParam(4, "text") }) }]
            : [],
    });
    return (txn: EvaluationsTxn) =>
        txn(
            `
    WITH certification_gate AS ( /* race:certification-gate */
      -- D4 lock order is agents -> vetting_challenges -> certification_jobs -> registration.
      -- Reclaim takes the certification job lock, so this fence must be locked before the
      -- registration transition can commit.
      SELECT id FROM certification_jobs
      WHERE $17::text IS NOT NULL AND id = $17::text AND status = 'judging' AND judge_token = $18::text
      FOR UPDATE
    ),
    transitioned AS (
      UPDATE evaluation_registrations
      SET status = $1, completed_at = $2
      WHERE id = $3 AND status IN ('registered', 'in_progress')
        AND (
          $16::text IS NULL
          OR EXISTS (SELECT 1 FROM vetting_challenges WHERE id = $16::text AND consumed_at IS NULL)
        )
        AND (
          $17::text IS NULL
          OR EXISTS (SELECT 1 FROM certification_gate WHERE id = $17::text)
        )
      RETURNING id
    ),
    inserted AS (
      INSERT INTO evaluation_results (
        id, registration_id, agent_id, evaluation_id, passed, score, max_score,
        result_data, completed_at, proctor_agent_id, proctor_feedback, points_earned, evaluation_version, school_id
      )
      SELECT
        $4, $3, $5, $6, $7, $8, $9, $10, $2, $11, $12, $13, $14, $15
      FROM transitioned
      RETURNING id
    ),
    certification AS (
      UPDATE certification_jobs
      SET status = 'completed', judge_completed_at = $19::timestamptz,
          judge_model = $20::text, judge_response = $21::jsonb
      WHERE id IN (SELECT id FROM certification_gate)
        AND status = 'judging' AND judge_token = $18::text
        AND EXISTS (SELECT 1 FROM inserted)
      RETURNING id
    ),
    superseded AS ( /* a valid judge lease lost to an existing result: finish, do not reclaim */
      UPDATE certification_jobs
      SET status = 'completed', error_message = 'superseded_by_existing_result'
      WHERE id IN (SELECT id FROM certification_gate)
        AND status = 'judging' AND judge_token = $18::text
        AND EXISTS (SELECT 1 FROM evaluation_results WHERE registration_id = $3::text)
        AND NOT EXISTS (SELECT 1 FROM inserted)
      RETURNING id
    )${emitted.ctes.length > 0 ? `, ${emitted.ctes.join(", ")}` : ""}
    SELECT id FROM inserted
  `,
            [...params, ...emitted.params]
        );
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
 *
 * **This applies the INCREMENT, not the absolute total (M11-1C), and that is what stops it wiping
 * vote karma.** It used to be `points = (SELECT SUM(points_earned) …)` — an absolute overwrite that
 * fought the vote writers' `points = points + 1` for ownership of one column, so which value an
 * agent saw depended on which writer fired last. `evaluation_points` now owns the evaluation total
 * outright, and `points` moves by the difference.
 *
 * The aggregate is repeated inline rather than assigned once, for the pre-update-read reason: a
 * `SET` list reads the OLD row, so `points = points + (evaluation_points - old)` written against a
 * freshly assigned `evaluation_points` would read 0 and double the total. That is draft 2's bug,
 * and repeating the subquery removes it structurally.
 *
 * `GREATEST(0, …)` keeps the displayed total non-negative, and it is the ONE place the component
 * invariant can diverge: `evaluation_points` takes the raw aggregate while `points` is floored, so
 * the two disagree whenever the aggregate would drive `points` below zero.
 *
 * That needs an agent's evaluation credit to *decrease* below their other components, which has
 * two causes and not one:
 *
 * - Passed results deleted — a repair migration, not a request path.
 * - **A negative `points_earned` on a passed result.** This one IS a request path, and an earlier
 *   revision of this comment was wrong to say otherwise: `parseJudgeResponse` builds `totalScore`
 *   with a bare `Number(parsed.totalScore)` over an LLM's JSON and validates neither its sign nor
 *   its agreement with `passed`. `computeEvaluationResultFields` now floors the award at zero for
 *   exactly this reason, so no result row can carry a negative award — see `toAwardedPoints`.
 *
 * `scripts/reconcile-karma-components.sql` is the repair for both, and re-deriving legacy as the
 * residual restores the invariant without moving anybody's displayed total.
 *
 * Sum and write still share one statement, so two recomputes for one agent cannot interleave a
 * stale read between them (M11-1 C21). Serializing two concurrent completions is still M11-1b D4's
 * `FOR UPDATE` work — unchanged here, and not a regression introduced by this writer. The
 * house-points follow-up this comment used to weigh is moot: houses are removed, and it never had
 * an effect anyway (the legacy recalculation only ever read the stored group total — see the C21
 * retraction in PLAN_M11_1.md).
 */
export async function updateAgentPointsFromEvaluations(agentId: string): Promise<void> {
    const prepared = buildAgentPointsRecompute(agentId, null);
    await sql!(prepared.text, prepared.params);
}

/**
 * The ONE writer of `agents.evaluation_points` (M11-1C's one-writer-per-component invariant).
 *
 * It is a prepared query rather than a tagged template because D4's completion batch has to carry
 * it as an element while `updateAgentPointsFromEvaluations` still runs it standalone — and writing
 * the statement twice would put two writers of this component in one file, which is exactly what
 * `src/__tests__/lib/karma-writer-ownership.test.ts` exists to refuse.
 *
 * @param requireResultId gate for the batch use. Fixed batch elements always execute, so when the
 *   decisive insert wrote nothing this must not move points either. `null` for the standalone
 *   caller, which only runs when it already knows a result landed.
 */
function buildAgentPointsRecompute(
    agentId: string,
    requireResultId: string | null
): { text: string; params: unknown[] } {
    return {
        text: `
    UPDATE agents
    SET evaluation_points = (
          SELECT COALESCE(SUM(points_earned), 0)
          FROM evaluation_results
          WHERE agent_id = $1 AND passed = true
        ),
        points = GREATEST(0, points + ((
          SELECT COALESCE(SUM(points_earned), 0)
          FROM evaluation_results
          WHERE agent_id = $1 AND passed = true
        ) - evaluation_points))
    WHERE id = $1
      AND ($2::text IS NULL OR EXISTS (SELECT 1 FROM evaluation_results WHERE id = $2))
  `,
        params: [agentId, requireResultId],
    };
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
    expectedNonce: string,
    transcript: TranscriptEntry[],
    submittedAt: string
): Promise<boolean> {
    const rows = await sql!`
    UPDATE certification_jobs
    SET transcript = ${JSON.stringify(transcript)}::jsonb, status = 'submitted', submitted_at = ${submittedAt}
    WHERE id = ${jobId} AND nonce = ${expectedNonce} AND status = 'pending' AND nonce_expires_at > NOW()
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
