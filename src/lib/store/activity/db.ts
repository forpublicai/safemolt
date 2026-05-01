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
import { listActivityEvents } from "./events";


export async function listRecentAgentLoopActions(limit = 25): Promise<StoredAgentLoopAction[]> {
    try {
        const rows = await sql!`
      SELECT id, agent_id, action, target_type, target_id, content_snippet, created_at
      FROM agent_loop_action_log
      ORDER BY created_at DESC
      LIMIT ${limit}
    `;
        return (rows as Record<string, unknown>[]).map((r) => ({
            id: r.id as string,
            agentId: r.agent_id as string,
            action: r.action as string,
            targetType: r.target_type as string | undefined,
            targetId: r.target_id as string | undefined,
            contentSnippet: r.content_snippet as string | undefined,
            createdAt: r.created_at instanceof Date ? r.created_at.toISOString() : String(r.created_at),
        }));
    } catch {
        return [];
    }
}

export async function listActivityFeed(options: StoredActivityFeedOptions = {}): Promise<StoredActivityFeedItem[]> {
    return listActivityEvents(options);
}

export async function getCachedActivityContext(
    activityKind: string,
    activityId: string,
    promptVersion: string
): Promise<StoredActivityContext | null> {
    const rows = await sql!`
    SELECT activity_kind, activity_id, prompt_version, content, created_at, updated_at
    FROM activity_contexts
    WHERE activity_kind = ${activityKind}
      AND activity_id = ${activityId}
      AND prompt_version = ${promptVersion}
    LIMIT 1
  `;
    const r = rows[0] as Record<string, unknown> | undefined;
    if (!r) return null;
    return {
        activityKind: r.activity_kind as string,
        activityId: r.activity_id as string,
        promptVersion: r.prompt_version as string,
        content: r.content as string,
        createdAt: r.created_at instanceof Date ? r.created_at.toISOString() : String(r.created_at),
        updatedAt: r.updated_at instanceof Date ? r.updated_at.toISOString() : String(r.updated_at),
    };
}

export async function upsertActivityContext(
    activityKind: string,
    activityId: string,
    promptVersion: string,
    content: string
): Promise<StoredActivityContext> {
    const rows = await sql!`
    INSERT INTO activity_contexts (activity_kind, activity_id, prompt_version, content)
    VALUES (${activityKind}, ${activityId}, ${promptVersion}, ${content})
    ON CONFLICT (activity_kind, activity_id, prompt_version)
    DO UPDATE SET content = EXCLUDED.content, updated_at = NOW()
    RETURNING activity_kind, activity_id, prompt_version, content, created_at, updated_at
  `;
    const r = rows[0] as Record<string, unknown>;
    return {
        activityKind: r.activity_kind as string,
        activityId: r.activity_id as string,
        promptVersion: r.prompt_version as string,
        content: r.content as string,
        createdAt: r.created_at instanceof Date ? r.created_at.toISOString() : String(r.created_at),
        updatedAt: r.updated_at instanceof Date ? r.updated_at.toISOString() : String(r.updated_at),
    };
}

export async function claimActivityContextEnrichment(
    activityKind: string,
    activityId: string,
    promptVersion: string
): Promise<boolean> {
    // Empty rows are lock sentinels; callers must always read contexts by prompt_version.
    const rows = await sql!`
    INSERT INTO activity_contexts (activity_kind, activity_id, prompt_version, content)
    VALUES (${activityKind}, ${activityId}, ${promptVersion}, '')
    ON CONFLICT (activity_kind, activity_id, prompt_version) DO NOTHING
    RETURNING 1 AS claimed
  `;
    return rows.length > 0;
}

export async function clearActivityContextEnrichmentClaim(
    activityKind: string,
    activityId: string,
    promptVersion: string
): Promise<void> {
    await sql!`
    DELETE FROM activity_contexts
    WHERE activity_kind = ${activityKind}
      AND activity_id = ${activityId}
      AND prompt_version = ${promptVersion}
  `;
}

const MEMORY_INGEST_WATERMARK_ID = "global";

export async function getMemoryIngestWatermark(): Promise<string> {
    const rows = await sql!`SELECT cursor_at FROM memory_ingestion_watermark WHERE id = ${MEMORY_INGEST_WATERMARK_ID} LIMIT 1`;
    const r = rows[0] as { cursor_at: Date | string } | undefined;
    if (!r) return "1970-01-01T00:00:00.000Z";
    const v = r.cursor_at;
    return v instanceof Date ? v.toISOString() : String(v);
}

export async function setMemoryIngestWatermark(iso: string): Promise<void> {
    await sql!`
    INSERT INTO memory_ingestion_watermark (id, cursor_at)
    VALUES (${MEMORY_INGEST_WATERMARK_ID}, ${iso}::timestamptz)
    ON CONFLICT (id) DO UPDATE SET cursor_at = EXCLUDED.cursor_at
  `;
}

// ============================================
// Announcements (single active announcement)
// ============================================

export async function setAnnouncement(content: string): Promise<StoredAnnouncement> {
    const rows = await sql!`
        INSERT INTO announcements (id, content, created_at)
        VALUES ('current', ${content}, NOW())
        ON CONFLICT (id) DO UPDATE SET content = ${content}, created_at = NOW()
        RETURNING *
    `;
    const row = rows[0] as Record<string, unknown>;
    return {
        id: String(row.id),
        content: String(row.content),
        createdAt: String(row.created_at),
    };
}

export async function getAnnouncement(): Promise<StoredAnnouncement | null> {
    const rows = await sql!`
        SELECT * FROM announcements WHERE id = 'current' LIMIT 1
    `;
    if (rows.length === 0) return null;
    const row = rows[0] as Record<string, unknown>;
    return {
        id: String(row.id),
        content: String(row.content),
        createdAt: String(row.created_at),
    };
}

export async function clearAnnouncement(): Promise<boolean> {
    await sql!`DELETE FROM announcements WHERE id = 'current'`;
    return true;
}
