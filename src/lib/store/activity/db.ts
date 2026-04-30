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

function normalizeActivityTypeSet(types?: string[]): Set<string> {
    return new Set((types ?? []).map((type) => type.trim().toLowerCase()).filter(Boolean));
}

function rowToActivityFeedItem(r: Record<string, unknown>): StoredActivityFeedItem {
    return {
        id: r.id as string,
        kind: r.kind as StoredActivityFeedItem["kind"],
        occurredAt: r.occurred_at instanceof Date ? r.occurred_at.toISOString() : String(r.occurred_at),
        actorId: r.actor_id as string | undefined,
        actorName: r.actor_name as string | undefined,
        actorCanonicalName: r.actor_canonical_name as string | undefined,
        title: r.title as string,
        href: r.href as string | undefined,
        summary: r.summary as string,
        contextHint: (r.context_hint as string | null | undefined) ?? "",
        searchText: (r.search_text as string | null | undefined) ?? "",
        metadata: (r.metadata as Record<string, unknown> | undefined) ?? {},
    };
}

export async function listActivityFeedFromUnion(options: StoredActivityFeedOptions = {}): Promise<StoredActivityFeedItem[]> {
    const limit = Math.min(501, Math.max(1, Math.floor(options.limit ?? 30)));
    const q = options.query?.trim().toLowerCase() ?? "";
    const like = `%${q}%`;
    const before = options.before ?? null;
    const types = normalizeActivityTypeSet(options.types);
    const allTypes = types.size === 0;
    const includePosts = allTypes || types.has("post") || types.has("posts");
    const includeComments = allTypes || types.has("comment") || types.has("comments");
    const includeEvaluations = allTypes || types.has("evaluation") || types.has("evaluations") || types.has("evaluation_result");
    const includePlayground = allTypes || types.has("playground") || types.has("playground_session") || types.has("playground_action");
    const includeLoops = allTypes || types.has("agent_loop") || types.has("loop") || types.has("loops");

    const rows = await sql!`
    WITH activity AS (
      (
        SELECT
        'post'::text AS kind,
        p.id::text AS id,
        p.created_at AS occurred_at,
        p.author_id::text AS actor_id,
        COALESCE(NULLIF(a.display_name, ''), a.name, p.author_id)::text AS actor_name,
        COALESCE(a.name, p.author_id)::text AS actor_canonical_name,
        p.title::text AS title,
        ('/post/' || p.id)::text AS href,
        ('Post in ' || COALESCE('g/' || g.name, 'a group') || ': ' || p.title)::text AS summary,
        COALESCE(p.content, p.url, p.title, '')::text AS context_hint,
        concat_ws(' ', COALESCE(NULLIF(a.display_name, ''), a.name, p.author_id), a.name, 'post', p.title, p.content, g.name)::text AS search_text,
        jsonb_build_object(
          'post_id', p.id,
          'group', g.name,
          'upvotes', p.upvotes,
          'comments', p.comment_count
        ) AS metadata
      FROM posts p
      LEFT JOIN agents a ON a.id = p.author_id
      LEFT JOIN groups g ON g.id = p.group_id
      WHERE ${includePosts}
        AND (${before}::timestamptz IS NULL OR p.created_at < ${before}::timestamptz)
        AND (${q} = '' OR LOWER(concat_ws(' ', p.title, p.content, p.url, COALESCE(NULLIF(a.display_name, ''), a.name, p.author_id), a.name, g.name)) LIKE ${like})
      ORDER BY p.created_at DESC
      LIMIT ${limit}
      )

      UNION ALL

      (
        SELECT
        'comment'::text AS kind,
        c.id::text AS id,
        c.created_at AS occurred_at,
        c.author_id::text AS actor_id,
        COALESCE(NULLIF(a.display_name, ''), a.name, c.author_id)::text AS actor_name,
        COALESCE(a.name, c.author_id)::text AS actor_canonical_name,
        ('Comment on ' || p.title)::text AS title,
        ('/post/' || p.id)::text AS href,
        ('Comment on "' || p.title || '": ' || left(c.content, 140))::text AS summary,
        c.content::text AS context_hint,
        concat_ws(' ', COALESCE(NULLIF(a.display_name, ''), a.name, c.author_id), a.name, 'comment', 'post', p.title, c.content)::text AS search_text,
        jsonb_build_object(
          'comment_id', c.id,
          'post_id', p.id,
          'post_title', p.title,
          'upvotes', c.upvotes
        ) AS metadata
      FROM comments c
      JOIN posts p ON p.id = c.post_id
      LEFT JOIN agents a ON a.id = c.author_id
      WHERE ${includeComments}
        AND (${before}::timestamptz IS NULL OR c.created_at < ${before}::timestamptz)
        AND (${q} = '' OR LOWER(concat_ws(' ', p.title, c.content, COALESCE(NULLIF(a.display_name, ''), a.name, c.author_id), a.name)) LIKE ${like})
      ORDER BY c.created_at DESC
      LIMIT ${limit}
      )

      UNION ALL

      (
        SELECT
        'evaluation_result'::text AS kind,
        er.id::text AS id,
        er.completed_at AS occurred_at,
        er.agent_id::text AS actor_id,
        COALESCE(NULLIF(a.display_name, ''), a.name, er.agent_id)::text AS actor_name,
        COALESCE(a.name, er.agent_id)::text AS actor_canonical_name,
        (COALESCE(NULLIF(a.display_name, ''), a.name, er.agent_id) || ' completed ' || er.evaluation_id)::text AS title,
        ('/evaluations/result/' || er.id)::text AS href,
        (COALESCE(NULLIF(a.display_name, ''), a.name, er.agent_id) || ' completed ' || er.evaluation_id || ' with status ' || CASE WHEN er.passed THEN 'PASSED' ELSE 'FAILED' END || '.')::text AS summary,
        COALESCE(er.proctor_feedback, er.result_data::text, '')::text AS context_hint,
        concat_ws(' ', COALESCE(NULLIF(a.display_name, ''), a.name, er.agent_id), a.name, 'evaluation', 'eval', er.evaluation_id, CASE WHEN er.passed THEN 'PASSED' ELSE 'FAILED' END)::text AS search_text,
        jsonb_build_object(
          'result_id', er.id,
          'evaluation_id', er.evaluation_id,
          'status', CASE WHEN er.passed THEN 'PASSED' ELSE 'FAILED' END,
          'score', er.score,
          'max_score', er.max_score,
          'points_earned', er.points_earned
        ) AS metadata
      FROM evaluation_results er
      LEFT JOIN agents a ON a.id = er.agent_id
      WHERE ${includeEvaluations}
        AND (${before}::timestamptz IS NULL OR er.completed_at < ${before}::timestamptz)
        AND (${q} = '' OR LOWER(concat_ws(' ', er.evaluation_id, er.proctor_feedback, er.result_data::text, COALESCE(NULLIF(a.display_name, ''), a.name, er.agent_id), a.name, CASE WHEN er.passed THEN 'PASSED' ELSE 'FAILED' END)) LIKE ${like})
      ORDER BY er.completed_at DESC
      LIMIT ${limit}
      )

      UNION ALL

      (
        SELECT
        'playground_session'::text AS kind,
        s.id::text AS id,
        COALESCE(s.started_at, s.completed_at, s.created_at) AS occurred_at,
        (s.participants->0->>'agentId')::text AS actor_id,
        COALESCE(NULLIF(s.participants->0->>'agentName', ''), NULLIF(a.display_name, ''), a.name, s.participants->0->>'agentId', 'Unknown')::text AS actor_name,
        COALESCE(a.name, s.participants->0->>'agentId', 'unknown')::text AS actor_canonical_name,
        (s.game_id || ' ' || s.status)::text AS title,
        ('/playground?session=' || s.id)::text AS href,
        (s.game_id || ' session with ' || jsonb_array_length(COALESCE(s.participants, '[]'::jsonb)) || ' participant(s).')::text AS summary,
        COALESCE(s.summary, s.current_round_prompt, '')::text AS context_hint,
        concat_ws(' ', COALESCE(NULLIF(s.participants->0->>'agentName', ''), NULLIF(a.display_name, ''), a.name), a.name, 'playground', 'session', s.game_id, s.status, s.participants::text)::text AS search_text,
        jsonb_build_object(
          'session_id', s.id,
          'game_id', s.game_id,
          'status', s.status,
          'participants', s.participants
        ) AS metadata
      FROM playground_sessions s
      LEFT JOIN agents a ON a.id = (s.participants->0->>'agentId')
      WHERE ${includePlayground}
        AND (${before}::timestamptz IS NULL OR COALESCE(s.started_at, s.completed_at, s.created_at) < ${before}::timestamptz)
        AND (${q} = '' OR LOWER(concat_ws(' ', s.game_id, s.status, s.summary, s.current_round_prompt, s.participants::text, COALESCE(NULLIF(s.participants->0->>'agentName', ''), NULLIF(a.display_name, ''), a.name), a.name)) LIKE ${like})
      ORDER BY COALESCE(s.started_at, s.completed_at, s.created_at) DESC
      LIMIT ${limit}
      )

      UNION ALL

      (
        SELECT
        'playground_action'::text AS kind,
        pa.id::text AS id,
        pa.created_at AS occurred_at,
        pa.agent_id::text AS actor_id,
        COALESCE(NULLIF(a.display_name, ''), a.name, pa.agent_id)::text AS actor_name,
        COALESCE(a.name, pa.agent_id)::text AS actor_canonical_name,
        (COALESCE(NULLIF(a.display_name, ''), a.name, pa.agent_id) || ' acted in ' || COALESCE(s.game_id, 'playground'))::text AS title,
        ('/playground?session=' || pa.session_id)::text AS href,
        (COALESCE(NULLIF(a.display_name, ''), a.name, pa.agent_id) || ' acted in round ' || pa.round || ': ' || left(pa.content, 140))::text AS summary,
        pa.content::text AS context_hint,
        concat_ws(' ', COALESCE(NULLIF(a.display_name, ''), a.name, pa.agent_id), a.name, 'playground', 'action', s.game_id, pa.content)::text AS search_text,
        jsonb_build_object(
          'action_id', pa.id,
          'session_id', pa.session_id,
          'game_id', COALESCE(s.game_id, 'playground'),
          'round', pa.round
        ) AS metadata
      FROM playground_actions pa
      LEFT JOIN playground_sessions s ON s.id = pa.session_id
      LEFT JOIN agents a ON a.id = pa.agent_id
      WHERE ${includePlayground}
        AND (${before}::timestamptz IS NULL OR pa.created_at < ${before}::timestamptz)
        AND (${q} = '' OR LOWER(concat_ws(' ', pa.content, s.game_id, COALESCE(NULLIF(a.display_name, ''), a.name, pa.agent_id), a.name)) LIKE ${like})
      ORDER BY pa.created_at DESC
      LIMIT ${limit}
      )

      UNION ALL

      (
        SELECT
        'agent_loop'::text AS kind,
        al.id::text AS id,
        al.created_at AS occurred_at,
        al.agent_id::text AS actor_id,
        COALESCE(NULLIF(a.display_name, ''), a.name, al.agent_id)::text AS actor_name,
        COALESCE(a.name, al.agent_id)::text AS actor_canonical_name,
        (COALESCE(NULLIF(a.display_name, ''), a.name, al.agent_id) || ' ' || al.action)::text AS title,
        CASE WHEN al.target_type = 'post' AND al.target_id IS NOT NULL THEN ('/post/' || al.target_id) ELSE ('/u/' || COALESCE(a.name, al.agent_id)) END::text AS href,
        (COALESCE(NULLIF(a.display_name, ''), a.name, al.agent_id) || ' ' || al.action || ': ' || COALESCE(al.content_snippet, target_post.title, al.target_id, 'activity recorded'))::text AS summary,
        COALESCE(al.content_snippet, '')::text AS context_hint,
        concat_ws(' ', COALESCE(NULLIF(a.display_name, ''), a.name, al.agent_id), a.name, al.action, al.target_type, target_post.title, al.target_id, al.content_snippet)::text AS search_text,
        jsonb_build_object(
          'target_type', al.target_type,
          'target_id', al.target_id,
          'target_title', target_post.title,
          'action', al.action
        ) AS metadata
      FROM agent_loop_action_log al
      LEFT JOIN agents a ON a.id = al.agent_id
      LEFT JOIN posts target_post ON al.target_type = 'post' AND target_post.id = al.target_id
      WHERE ${includeLoops}
        AND (${before}::timestamptz IS NULL OR al.created_at < ${before}::timestamptz)
        AND (${q} = '' OR LOWER(concat_ws(' ', al.action, al.target_type, target_post.title, al.target_id, al.content_snippet, COALESCE(NULLIF(a.display_name, ''), a.name, al.agent_id), a.name)) LIKE ${like})
      ORDER BY al.created_at DESC
      LIMIT ${limit}
      )
    )
    SELECT kind, id, occurred_at, actor_id, actor_name, actor_canonical_name, title, href, summary, context_hint, search_text, metadata
    FROM activity
    ORDER BY occurred_at DESC
    LIMIT ${limit}
  `;

    return (rows as Record<string, unknown>[]).map(rowToActivityFeedItem);
}

export async function listActivityFeedFromEvents(options: StoredActivityFeedOptions = {}): Promise<StoredActivityFeedItem[]> {
    return listActivityEvents(options);
}

export async function listActivityFeed(options: StoredActivityFeedOptions = {}): Promise<StoredActivityFeedItem[]> {
    const source = process.env.ACTIVITY_FEED_SOURCE ?? "events";
    return source === "union"
        ? listActivityFeedFromUnion(options)
        : listActivityFeedFromEvents(options);
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
