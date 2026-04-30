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
import {
    logActivityEventWriteFailure,
    recordPlaygroundActionActivityEvent,
    recordPlaygroundSessionActivityEvent,
} from "../activity/events";

export async function listRecentPlaygroundActions(limit = 25): Promise<StoredRecentPlaygroundAction[]> {
    const rows = await sql!`
    SELECT a.id, a.session_id, a.agent_id, a.round, a.content, a.created_at,
      s.game_id, s.status AS session_status
    FROM playground_actions a
    LEFT JOIN playground_sessions s ON s.id = a.session_id
    ORDER BY a.created_at DESC
    LIMIT ${limit}
  `;
    return (rows as Record<string, unknown>[]).map((r) => ({
        id: r.id as string,
        sessionId: r.session_id as string,
        agentId: r.agent_id as string,
        round: Number(r.round),
        content: r.content as string,
        createdAt: r.created_at instanceof Date ? r.created_at.toISOString() : String(r.created_at),
        gameId: (r.game_id as string | undefined) ?? "playground",
        sessionStatus: (r.session_status as string | undefined) ?? "unknown",
    }));
}

function rowToPlaygroundSession(r: Record<string, unknown>): PlaygroundSession {
    return {
        id: r.id as string,
        gameId: r.game_id as string,
        status: r.status as PlaygroundSession['status'],
        participants: (r.participants as PlaygroundSession['participants']) ?? [],
        transcript: (r.transcript as PlaygroundSession['transcript']) ?? [],
        currentRound: Number(r.current_round),
        currentRoundPrompt: r.current_round_prompt as string | undefined,
        roundDeadline: r.round_deadline ? String(r.round_deadline) : undefined,
        maxRounds: Number(r.max_rounds),
        summary: r.summary as string | undefined,
        createdAt: String(r.created_at),
        startedAt: r.started_at ? String(r.started_at) : undefined,
        completedAt: r.completed_at ? String(r.completed_at) : undefined,
        metadata: r.metadata as Record<string, unknown> | undefined,
    };
}

function rowToSessionAction(r: Record<string, unknown>): SessionAction {
    return {
        id: r.id as string,
        sessionId: r.session_id as string,
        agentId: r.agent_id as string,
        round: Number(r.round),
        content: r.content as string,
        createdAt: String(r.created_at),
    };
}

export async function getPlaygroundSessionsByAgentId(agentId: string, limit: number = 5): Promise<PlaygroundSession[]> {
    const rows = await sql!`
        SELECT * FROM playground_sessions
        WHERE participants @> ${JSON.stringify([{ agentId }])}::jsonb
        ORDER BY created_at DESC
        LIMIT ${limit}
    `;
    return (rows as Record<string, unknown>[]).map(rowToPlaygroundSession);
}

export async function getPlaygroundSessionCountByAgentId(agentId: string): Promise<number> {
    const rows = await sql!`
        SELECT COUNT(*)::int AS count FROM playground_sessions
        WHERE participants @> ${JSON.stringify([{ agentId }])}::jsonb
    `;
    return Number((rows[0] as { count?: number } | undefined)?.count ?? 0);
}

export async function createPlaygroundSession(input: CreateSessionInput): Promise<PlaygroundSession> {
    const now = new Date().toISOString();
    await sql!`
    INSERT INTO playground_sessions (id, game_id, status, participants, transcript, current_round, current_round_prompt, round_deadline, max_rounds, created_at, started_at, school_id)
    VALUES (
      ${input.id},
      ${input.gameId},
      ${input.status},
      ${JSON.stringify(input.participants)}::jsonb,
      '[]'::jsonb,
      ${input.currentRound},
      ${input.currentRoundPrompt || null},
      ${input.roundDeadline || null},
      ${input.maxRounds},
      ${now},
      ${input.startedAt || null},
      ${input.schoolId || 'foundation'}
    )
    `;
    const rows = await sql!`SELECT * FROM playground_sessions WHERE id = ${input.id} LIMIT 1`;
    const session = rowToPlaygroundSession(rows[0] as Record<string, unknown>);
    try {
        await recordPlaygroundSessionActivityEvent(session.id);
    } catch (error) {
        logActivityEventWriteFailure("playground_session", error);
    }
    return session;
}

export async function getPlaygroundSession(id: string): Promise<PlaygroundSession | null> {
    const rows = await sql!`SELECT * FROM playground_sessions WHERE id = ${id} LIMIT 1`;
    const r = rows[0] as Record<string, unknown> | undefined;
    return r ? rowToPlaygroundSession(r) : null;
}

export async function listPlaygroundSessions(options?: PlaygroundSessionListOptions): Promise<PlaygroundSession[]> {
    const status = options?.status;
    const limit = options?.limit ?? 20;
    const offset = options?.offset ?? 0;
    const schoolId = options?.schoolId;
    let rows;
    
    if (schoolId) {
        if (status) {
            rows = await sql!`
              SELECT * FROM playground_sessions
              WHERE status = ${status} AND (school_id = ${schoolId} OR (${schoolId} = 'foundation' AND school_id IS NULL))
              ORDER BY created_at DESC
              LIMIT ${limit} OFFSET ${offset}
            `;
        } else {
            rows = await sql!`
              SELECT * FROM playground_sessions
              WHERE (school_id = ${schoolId} OR (${schoolId} = 'foundation' AND school_id IS NULL))
              ORDER BY created_at DESC
              LIMIT ${limit} OFFSET ${offset}
            `;
        }
    } else {
        if (status) {
            rows = await sql!`
              SELECT * FROM playground_sessions
              WHERE status = ${status}
              ORDER BY created_at DESC
              LIMIT ${limit} OFFSET ${offset}
            `;
        } else {
            rows = await sql!`
              SELECT * FROM playground_sessions
              ORDER BY created_at DESC
              LIMIT ${limit} OFFSET ${offset}
            `;
        }
    }
    return (rows as Record<string, unknown>[]).map(rowToPlaygroundSession);
}

export async function updatePlaygroundSession(id: string, updates: UpdateSessionInput): Promise<boolean> {
    // Build COALESCE-based update to only update provided fields
    await sql!`
    UPDATE playground_sessions SET
      status = COALESCE(${updates.status ?? null}, status),
      participants = COALESCE(${updates.participants ? JSON.stringify(updates.participants) : null}::jsonb, participants),
      transcript = COALESCE(${updates.transcript ? JSON.stringify(updates.transcript) : null}::jsonb, transcript),
      current_round = COALESCE(${updates.currentRound ?? null}, current_round),
      current_round_prompt = (CASE WHEN ${updates.currentRoundPrompt === null} THEN NULL ELSE COALESCE(${updates.currentRoundPrompt}, current_round_prompt) END),
      round_deadline = (CASE WHEN ${updates.roundDeadline === null} THEN NULL ELSE COALESCE(${updates.roundDeadline}::timestamptz, round_deadline) END),
      summary = COALESCE(${updates.summary ?? null}, summary),
      started_at = COALESCE(${updates.startedAt ?? null}::timestamptz, started_at),
      completed_at = COALESCE(${updates.completedAt ?? null}::timestamptz, completed_at)
    WHERE id = ${id}
  `;
    if (updates.startedAt) {
        try {
            await recordPlaygroundSessionActivityEvent(id);
        } catch (error) {
            logActivityEventWriteFailure("playground_session", error);
        }
    }
    return true;
}

export async function deletePlaygroundSession(id: string): Promise<boolean> {
    await sql!`
        DELETE FROM playground_sessions
        WHERE id = ${id}
    `;
    return true;
}

export async function joinPlaygroundSession(
    sessionId: string,
    participant: SessionParticipant,
    maxPlayers: number
): Promise<{ success: boolean; session?: PlaygroundSession; reason?: string }> {
    // 1. Check if already joined (idempotency)
    const existing = await sql!`
        SELECT * FROM playground_sessions 
        WHERE id = ${sessionId}
        AND participants @> ${JSON.stringify([{ agentId: participant.agentId }])}::jsonb
    `;
    if (existing.length > 0) {
        return { success: true, session: rowToPlaygroundSession(existing[0] as Record<string, unknown>) };
    }

    // 2. Atomic append with capacity check
    // We only join if status is 'pending' AND count < maxPlayers
    const rows = await sql!`
        UPDATE playground_sessions
        SET participants = participants || ${JSON.stringify([participant])}::jsonb
        WHERE id = ${sessionId}
          AND status = 'pending'
          AND jsonb_array_length(participants) < ${maxPlayers}
        RETURNING *
    `;

    if (rows.length === 0) {
        // Did not update. Find out why.
        const check = await getPlaygroundSession(sessionId);
        if (!check) return { success: false, reason: 'Session not found' };
        if (check.status !== 'pending') return { success: false, reason: 'Session not pending' };
        if (check.participants.length >= maxPlayers) return { success: false, reason: 'Session full' };
        return { success: false, reason: 'Unknown error' };
    }

    return { success: true, session: rowToPlaygroundSession(rows[0] as Record<string, unknown>) };
}

export async function createPlaygroundAction(input: CreateActionInput): Promise<SessionAction> {
    const now = new Date().toISOString();
    await sql!`
    INSERT INTO playground_actions (id, session_id, agent_id, round, content, created_at)
    VALUES (${input.id}, ${input.sessionId}, ${input.agentId}, ${input.round}, ${input.content}, ${now})
  `;
    try {
        await recordPlaygroundActionActivityEvent(input.id);
    } catch (error) {
        logActivityEventWriteFailure("playground_action", error);
    }
    return {
        ...input,
        createdAt: now,
    };
}

export async function getPlaygroundActions(sessionId: string, round: number): Promise<SessionAction[]> {
    const rows = await sql!`
    SELECT * FROM playground_actions
    WHERE session_id = ${sessionId} AND round = ${round}
    ORDER BY created_at ASC
  `;
    return (rows as Record<string, unknown>[]).map(rowToSessionAction);
}

export async function activatePlaygroundSession(
    sessionId: string,
    initialRound: number,
    roundDeadline: string,
    startedAt: string
): Promise<boolean> {
    const rows = await sql!`
        UPDATE playground_sessions
        SET status = 'active', 
            current_round = ${initialRound}, 
            round_deadline = ${roundDeadline}, 
            started_at = ${startedAt}
        WHERE id = ${sessionId} AND status = 'pending'
        RETURNING id
    `;
    if (rows.length > 0) {
        try {
            await recordPlaygroundSessionActivityEvent(sessionId);
        } catch (error) {
            logActivityEventWriteFailure("playground_session", error);
        }
    }
    return rows.length > 0;
}
