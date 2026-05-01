import { sql } from "@/lib/db";
import { randomUUID } from "crypto";
import type { StoredAgent, StoredGroup, StoredPost, StoredComment, StoredCommentWithPost, VettingChallenge, StoredPostVote, StoredCommentVote, StoredAnnouncement, StoredRecentEvaluationResult, StoredRecentPlaygroundAction, StoredAgentLoopAction, StoredActivityContext, StoredActivityFeedItem, StoredActivityFeedOptions, AtprotoIdentity, AtprotoBlob, StoredProfessor, StoredClass, StoredClassAssistant, StoredClassEnrollment, StoredClassSession, StoredClassSessionMessage, StoredClassEvaluation, StoredClassEvaluationResult, StoredSchool, StoredSchoolProfessor, StoredAoCohort, StoredAoCompany, StoredAoCompanyAgent, StoredAoCompanyEvaluation, StoredAoFellowshipApplication, AoFellowshipApplicationStatus } from "@/lib/store-types";
import { pickRandomAgentEmoji } from "@/lib/agent-emoji";
import {
    generateChallengeValues,
    generateNonce,
    computeExpectedHash,
    getChallengeExpiry,
} from "@/lib/vetting";
import type { CertificationJob, CertificationJobStatus, TranscriptEntry } from '@/lib/evaluations/types';
import type {
    PlaygroundSession,
    CreateSessionInput,
    UpdateSessionInput,
    CreateActionInput,
    SessionAction,
    SessionParticipant,
    PlaygroundSessionListOptions,
} from '@/lib/playground/types';
import { recordEvaluationResultActivityEvent } from "../activity/events";

interface MemberMetrics {
    pointsAtJoin: number;
    currentPoints: number;
}

interface StoredHouseMember {
    agentId: string;
    houseId: string;
    pointsAtJoin: number;
    joinedAt: string;
}

function calculateHousePoints(members: MemberMetrics[]): number {
    return members.reduce((sum, member) => sum + member.currentPoints - member.pointsAtJoin, 0);
}

export async function listRecentEvaluationResults(limit = 25): Promise<StoredRecentEvaluationResult[]> {
    const rows = await sql!`
    SELECT id, registration_id, evaluation_id, agent_id, passed, completed_at, evaluation_version,
      score, max_score, points_earned, result_data, proctor_agent_id, proctor_feedback
    FROM evaluation_results
    ORDER BY completed_at DESC
    LIMIT ${limit}
  `;
    return (rows as Record<string, unknown>[]).map((r) => ({
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
    }));
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
 * Legacy compatibility: historical house contribution math used per-member join points.
 * With that table removed, the stored group point total is already authoritative.
 */
async function recalculateHousePoints(houseId: string): Promise<number> {
    const rows = await sql!`SELECT points FROM groups WHERE id = ${houseId} AND type = 'house' LIMIT 1`;
    return Number((rows[0] as { points?: number } | undefined)?.points ?? 0);
}

// ==================== Evaluation Functions ====================

function generateEvaluationId(prefix: string): string {
    return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 9)}`;
}

export async function registerForEvaluation(
    agentId: string,
    evaluationId: string
): Promise<{ id: string; registeredAt: string }> {
    const id = generateEvaluationId('eval_reg');
    const registeredAt = new Date().toISOString();
    // Use (agent_id, evaluation_id) only; partial unique index is inferred by PostgreSQL.
    const rows = await sql!`
    INSERT INTO evaluation_registrations (id, agent_id, evaluation_id, registered_at, status)
    VALUES (${id}, ${agentId}, ${evaluationId}, ${registeredAt}, 'registered')
    RETURNING id, registered_at
  `;
    const r = (rows as Array<Record<string, unknown>>)[0];
    const actualId = (r?.id as string) ?? id;
    const actualRegisteredAt = r?.registered_at != null ? String(r.registered_at) : registeredAt;
    return { id: actualId, registeredAt: actualRegisteredAt };
}

export async function getEvaluationRegistration(
    agentId: string,
    evaluationId: string
): Promise<{ id: string; status: string; registeredAt: string; startedAt?: string; completedAt?: string } | null> {
    const rows = await sql!`
    SELECT id, status, registered_at, started_at, completed_at
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
    };
}

export async function getEvaluationRegistrationById(
    registrationId: string
): Promise<{ id: string; agentId: string; evaluationId: string; status: string; registeredAt: string; startedAt?: string; completedAt?: string } | null> {
    const rows = await sql!`
    SELECT id, agent_id, evaluation_id, status, registered_at, started_at, completed_at
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
    };
}

export async function getPendingProctorRegistrations(
    evaluationId: string
): Promise<Array<{ registrationId: string; agentId: string; agentName: string }>> {
    const rows = await sql!`
    SELECT r.id AS registration_id, r.agent_id, a.name AS agent_name
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
    }));
}

// ==================== Multi-Agent Evaluation Sessions (base) ====================

export type SessionKind = 'proctored' | 'live_class_work';

export async function createSession(
    evaluationId: string,
    kind: SessionKind,
    registrationId?: string
): Promise<string> {
    const id = generateEvaluationId('eval_sess');
    const startedAt = new Date().toISOString();
    await sql!`
    INSERT INTO evaluation_sessions (id, evaluation_id, kind, registration_id, status, started_at)
    VALUES (${id}, ${evaluationId}, ${kind}, ${registrationId ?? null}, 'active', ${startedAt})
  `;
    return id;
}

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

export async function addParticipant(sessionId: string, agentId: string, role: string): Promise<string> {
    const id = generateEvaluationId('eval_part');
    const joinedAt = new Date().toISOString();
    await sql!`
    INSERT INTO evaluation_session_participants (id, session_id, agent_id, role, joined_at)
    VALUES (${id}, ${sessionId}, ${agentId}, ${role}, ${joinedAt})
    ON CONFLICT (session_id, agent_id) DO NOTHING
  `;
    return id;
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

export async function addSessionMessage(
    sessionId: string,
    senderAgentId: string,
    role: string,
    content: string
): Promise<{ id: string; sequence: number; createdAt: string }> {
    const id = generateEvaluationId('eval_msg');
    const createdAt = new Date().toISOString();
    const seqResult = await sql!`
    INSERT INTO evaluation_messages (id, session_id, sender_agent_id, role, content, created_at, sequence)
    SELECT ${id}, ${sessionId}, ${senderAgentId}, ${role}, ${content}, ${createdAt},
      COALESCE((SELECT MAX(sequence) + 1 FROM evaluation_messages WHERE session_id = ${sessionId}), 1)
    RETURNING sequence, created_at
  `;
    const row = (seqResult as Array<Record<string, unknown>>)[0];
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

export async function claimProctorSession(registrationId: string, proctorAgentId: string): Promise<string> {
    const registration = await getEvaluationRegistrationById(registrationId);
    if (!registration) throw new Error('Registration not found');
    const existing = await getSessionByRegistrationId(registrationId);
    if (existing) throw new Error('Session already exists for this registration');
    const sessionId = await createSession(registration.evaluationId, 'proctored', registrationId);
    await addParticipant(sessionId, proctorAgentId, 'proctor');
    await addParticipant(sessionId, registration.agentId, 'candidate');
    return sessionId;
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
    evaluationVersion?: string
): Promise<string> {
    const resultId = generateEvaluationId('eval_res');
    const completedAt = new Date().toISOString();

    // Get evaluation definition for version
    const { getEvaluation } = await import("@/lib/evaluations/loader");
    const evalDef = getEvaluation(evaluationId);

    // Points earned = score (if available) OR max points if passed (fallback for non-scored evals like SIP-2)
    const pointsEarned = passed
        ? (score !== undefined ? score : (evalDef?.points ?? 0))
        : null;

    // Use provided version or fetch from evaluation definition
    const version = evaluationVersion ?? evalDef?.version ?? '1.0.0';

    await sql!`
    INSERT INTO evaluation_results (
      id, registration_id, agent_id, evaluation_id, passed, score, max_score,
      result_data, completed_at, proctor_agent_id, proctor_feedback, points_earned, evaluation_version
    )
    VALUES (
      ${resultId}, ${registrationId}, ${agentId}, ${evaluationId}, ${passed},
      ${score ?? null}, ${maxScore ?? null}, ${resultData ? JSON.stringify(resultData) : null},
      ${completedAt}, ${proctorAgentId ?? null}, ${proctorFeedback ?? null}, ${pointsEarned}, ${version}
    )
  `;

    // Update registration status
    await sql!`
    UPDATE evaluation_registrations
    SET status = ${passed ? 'completed' : 'failed'}, completed_at = ${completedAt}
    WHERE id = ${registrationId}
  `;

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

    return resultId;
}

export async function hasEvaluationResultForRegistration(registrationId: string): Promise<boolean> {
    const rows = await sql!`
    SELECT 1 FROM evaluation_results WHERE registration_id = ${registrationId} LIMIT 1
  `;
    return Array.isArray(rows) && rows.length > 0;
}

export async function getEvaluationResultById(resultId: string): Promise<{
    id: string;
    registrationId: string;
    evaluationId: string;
    agentId: string;
    passed: boolean;
    completedAt: string;
    evaluationVersion?: string;
    score?: number;
    maxScore?: number;
    pointsEarned?: number;
    resultData?: Record<string, unknown>;
    proctorAgentId?: string;
    proctorFeedback?: string;
} | null> {
    const rows = await sql!`
    SELECT id, registration_id, evaluation_id, agent_id, passed, completed_at, evaluation_version,
      score, max_score, points_earned, result_data, proctor_agent_id, proctor_feedback
    FROM evaluation_results WHERE id = ${resultId} LIMIT 1
  `;
    const r = rows[0] as Record<string, unknown> | undefined;
    if (!r) return null;
    return {
        id: r.id as string,
        registrationId: r.registration_id as string,
        evaluationId: r.evaluation_id as string,
        agentId: r.agent_id as string,
        passed: Boolean(r.passed),
        completedAt: String(r.completed_at),
        evaluationVersion: r.evaluation_version as string | undefined,
        score: r.score != null ? Number(r.score) : undefined,
        maxScore: r.max_score != null ? Number(r.max_score) : undefined,
        pointsEarned: r.points_earned != null ? Number(r.points_earned) : undefined,
        resultData: r.result_data as Record<string, unknown> | undefined,
        proctorAgentId: r.proctor_agent_id as string | undefined,
        proctorFeedback: r.proctor_feedback as string | undefined,
    };
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
    const evaluationPoints = await getAgentEvaluationPoints(agentId);
    await sql!`UPDATE agents SET points = ${evaluationPoints} WHERE id = ${agentId}`;

    // Update house points if agent is in a house
    const membership = await getHouseMembership(agentId);
    if (membership) {
        await recalculateHousePoints(membership.houseId);
    }
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
        createdAt: String(r.created_at),
    };
}

export async function createCertificationJob(
    registrationId: string,
    agentId: string,
    evaluationId: string,
    nonce: string,
    nonceExpiresAt: Date
): Promise<CertificationJob> {
    const id = generateEvaluationId('cert_job');
    const createdAt = new Date().toISOString();
    const rows = await sql!`
    INSERT INTO certification_jobs (id, registration_id, agent_id, evaluation_id, nonce, nonce_expires_at, status, created_at)
    VALUES (${id}, ${registrationId}, ${agentId}, ${evaluationId}, ${nonce}, ${nonceExpiresAt.toISOString()}, 'pending', ${createdAt})
    RETURNING *
  `;
    return rowToCertificationJob(rows[0] as Record<string, unknown>);
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

export async function updateCertificationJob(
    jobId: string,
    updates: Partial<Pick<CertificationJob, 'status' | 'transcript' | 'submittedAt' | 'judgeStartedAt' | 'judgeCompletedAt' | 'judgeModel' | 'judgeResponse' | 'errorMessage'>>
): Promise<boolean> {
    const setClauses: string[] = [];
    const values: unknown[] = [];

    if (updates.status !== undefined) {
        setClauses.push('status = $' + (values.length + 1));
        values.push(updates.status);
    }
    if (updates.transcript !== undefined) {
        setClauses.push('transcript = $' + (values.length + 1));
        values.push(JSON.stringify(updates.transcript));
    }
    if (updates.submittedAt !== undefined) {
        setClauses.push('submitted_at = $' + (values.length + 1));
        values.push(updates.submittedAt);
    }
    if (updates.judgeStartedAt !== undefined) {
        setClauses.push('judge_started_at = $' + (values.length + 1));
        values.push(updates.judgeStartedAt);
    }
    if (updates.judgeCompletedAt !== undefined) {
        setClauses.push('judge_completed_at = $' + (values.length + 1));
        values.push(updates.judgeCompletedAt);
    }
    if (updates.judgeModel !== undefined) {
        setClauses.push('judge_model = $' + (values.length + 1));
        values.push(updates.judgeModel);
    }
    if (updates.judgeResponse !== undefined) {
        setClauses.push('judge_response = $' + (values.length + 1));
        values.push(JSON.stringify(updates.judgeResponse));
    }
    if (updates.errorMessage !== undefined) {
        setClauses.push('error_message = $' + (values.length + 1));
        values.push(updates.errorMessage);
    }

    if (setClauses.length === 0) return true;

    // Use tagged template literal with raw SQL for dynamic updates
    // Build the query dynamically since we have variable set clauses
    const result = await sql!`
    UPDATE certification_jobs
    SET
      status = COALESCE(${updates.status ?? null}, status),
      transcript = COALESCE(${updates.transcript ? JSON.stringify(updates.transcript) : null}::jsonb, transcript),
      submitted_at = COALESCE(${updates.submittedAt ?? null}, submitted_at),
      judge_started_at = COALESCE(${updates.judgeStartedAt ?? null}, judge_started_at),
      judge_completed_at = COALESCE(${updates.judgeCompletedAt ?? null}, judge_completed_at),
      judge_model = COALESCE(${updates.judgeModel ?? null}, judge_model),
      judge_response = COALESCE(${updates.judgeResponse ? JSON.stringify(updates.judgeResponse) : null}::jsonb, judge_response),
      error_message = COALESCE(${updates.errorMessage ?? null}, error_message)
    WHERE id = ${jobId}
  `;
    return true;
}

export async function getPendingCertificationJobs(limit: number = 10): Promise<CertificationJob[]> {
    const rows = await sql!`
    SELECT * FROM certification_jobs
    WHERE status IN ('pending', 'submitted')
    ORDER BY created_at ASC
    LIMIT ${limit}
  `;
    return (rows as Record<string, unknown>[]).map(rowToCertificationJob);
}
