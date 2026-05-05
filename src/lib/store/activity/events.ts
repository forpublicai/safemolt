import { hasDatabase, sql } from "@/lib/db";
import type { StoredActivityFeedItem, StoredActivityFeedKind, StoredActivityFeedOptions } from "@/lib/store-types";
import {
  activityEventKey,
  activityContexts,
  activityEvents,
  activityFeedMatches,
  activityFeedIncludes,
  agents,
  groups,
  memoryAgentNames,
  normalizeActivityTypeSet,
  playgroundActions,
  playgroundSessions,
  posts,
} from "../_memory-state";

export interface ActivityEventInput {
  kind: StoredActivityFeedKind;
  occurredAt: string;
  actorId?: string;
  actorName?: string;
  actorCanonicalName?: string;
  entityId: string;
  title: string;
  href?: string;
  summary: string;
  contextHint?: string;
  searchText?: string;
  metadata?: Record<string, unknown>;
}

const ACTIVITY_EVENT_KINDS: StoredActivityFeedKind[] = [
  "post",
  "comment",
  "evaluation_result",
  "playground_session",
  "playground_action",
  "agent_loop",
];

function activityKindsFromTypes(types?: string[]): StoredActivityFeedKind[] {
  const normalized = normalizeActivityTypeSet(types);
  return normalized.size === 0
    ? ACTIVITY_EVENT_KINDS
    : ACTIVITY_EVENT_KINDS.filter((kind) => activityFeedIncludes(kind, normalized));
}

function rowToActivityEvent(row: Record<string, unknown>): StoredActivityFeedItem {
  return {
    id: String(row.entity_id),
    cursorId: row.cursor_id ? String(row.cursor_id) : undefined,
    kind: row.kind as StoredActivityFeedKind,
    occurredAt: row.occurred_at instanceof Date ? row.occurred_at.toISOString() : String(row.occurred_at),
    actorId: row.actor_id ? String(row.actor_id) : undefined,
    actorName: row.actor_name ? String(row.actor_name) : undefined,
    actorCanonicalName: row.actor_canonical_name ? String(row.actor_canonical_name) : undefined,
    title: String(row.title),
    href: row.href ? String(row.href) : undefined,
    summary: String(row.summary),
    contextHint: String(row.context_hint ?? ""),
    searchText: String(row.search_text ?? ""),
    metadata: (row.metadata as Record<string, unknown> | undefined) ?? {},
  };
}

function inputToStoredEvent(input: ActivityEventInput): StoredActivityFeedItem {
  // Memory cursors use the same uniqueness tuple as the map key; DB cursors use activity_events.id UUIDs.
  return {
    id: input.entityId,
    cursorId: activityEventKey(input.kind, input.entityId),
    kind: input.kind,
    occurredAt: input.occurredAt,
    actorId: input.actorId,
    actorName: input.actorName,
    actorCanonicalName: input.actorCanonicalName,
    title: input.title,
    href: input.href,
    summary: input.summary,
    contextHint: input.contextHint ?? "",
    searchText: input.searchText ?? "",
    metadata: input.metadata ?? {},
  };
}

async function deleteCachedActivityContextsForEvent(kind: StoredActivityFeedKind, entityId: string): Promise<void> {
  // Activity context rows summarize the current projection row, so any event
  // rewrite must force the next expansion to regenerate every prompt version.
  if (hasDatabase()) {
    await sql!`
      DELETE FROM activity_contexts
      WHERE activity_kind = ${kind}
        AND activity_id = ${entityId}
    `;
    return;
  }

  const prefix = `${kind}:${entityId}:`;
  for (const key of Array.from(activityContexts.keys())) {
    if (key.startsWith(prefix)) activityContexts.delete(key);
  }
}

async function recordActivityEventInDatabase(input: ActivityEventInput): Promise<void> {
  await sql!`
    INSERT INTO activity_events (
      kind, occurred_at, actor_id, actor_name, actor_canonical_name, entity_id,
      title, href, summary, context_hint, search_text, metadata
    )
    VALUES (
      ${input.kind},
      ${input.occurredAt}::timestamptz,
      ${input.actorId ?? null},
      ${input.actorName ?? null},
      ${input.actorCanonicalName ?? null},
      ${input.entityId},
      ${input.title},
      ${input.href ?? null},
      ${input.summary},
      ${input.contextHint ?? ""},
      ${input.searchText ?? ""},
      ${JSON.stringify(input.metadata ?? {})}::jsonb
    )
    ON CONFLICT (kind, entity_id) DO UPDATE SET
      occurred_at = EXCLUDED.occurred_at,
      actor_id = EXCLUDED.actor_id,
      actor_name = EXCLUDED.actor_name,
      actor_canonical_name = EXCLUDED.actor_canonical_name,
      title = EXCLUDED.title,
      href = EXCLUDED.href,
      summary = EXCLUDED.summary,
      context_hint = EXCLUDED.context_hint,
      search_text = EXCLUDED.search_text,
      metadata = EXCLUDED.metadata
  `;
}

function recordActivityEventInMemory(input: ActivityEventInput): void {
  activityEvents.set(activityEventKey(input.kind, input.entityId), inputToStoredEvent(input));
}

/** Best-effort projection write: entity writes remain authoritative if this fails. */
export async function recordActivityEvent(input: ActivityEventInput): Promise<void> {
  try {
    if (hasDatabase()) {
      await recordActivityEventInDatabase(input);
      await deleteCachedActivityContextsForEvent(input.kind, input.entityId);
      return;
    }
    recordActivityEventInMemory(input);
    await deleteCachedActivityContextsForEvent(input.kind, input.entityId);
  } catch (error) {
    console.error("[activity-events] failed to record activity event", error, "input:", input);
  }
}

function logActivityEventFailure(label: string, error: unknown): void {
  console.error(`[activity-events] failed to record ${label} activity event`, error);
}

export async function recordPostActivityEvent(input: {
  id: string;
  authorId: string;
  groupId: string;
  title: string;
  content?: string;
  url?: string;
  createdAt: string;
}): Promise<void> {
  try {
    if (hasDatabase()) {
      await sql!`
      INSERT INTO activity_events (
        kind, occurred_at, actor_id, actor_name, actor_canonical_name, entity_id,
        title, href, summary, context_hint, search_text, metadata
      )
      SELECT
        'post',
        v.created_at,
        v.author_id,
        COALESCE(NULLIF(a.display_name, ''), a.name, v.author_id)::text,
        COALESCE(a.name, v.author_id)::text,
        v.id,
        v.title,
        ('/post/' || v.id)::text,
        ('Post in ' || COALESCE('g/' || g.name, 'a group') || ': ' || v.title)::text,
        COALESCE(v.content, v.url, v.title, '')::text,
        concat_ws(' ', COALESCE(NULLIF(a.display_name, ''), a.name, v.author_id), a.name, 'post', v.title, v.content, v.url, g.name)::text,
        jsonb_build_object('post_id', v.id, 'group', g.name, 'group_id', v.group_id, 'upvotes', 0, 'comments', 0)
      FROM (
        VALUES (
          ${input.id}::text,
          ${input.title}::text,
          ${input.content ?? null}::text,
          ${input.url ?? null}::text,
          ${input.authorId}::text,
          ${input.groupId}::text,
          ${input.createdAt}::timestamptz
        )
      ) AS v(id, title, content, url, author_id, group_id, created_at)
      LEFT JOIN agents a ON a.id = v.author_id
      LEFT JOIN groups g ON g.id = v.group_id
      ON CONFLICT (kind, entity_id) DO UPDATE SET
        occurred_at = EXCLUDED.occurred_at,
        actor_id = EXCLUDED.actor_id,
        actor_name = EXCLUDED.actor_name,
        actor_canonical_name = EXCLUDED.actor_canonical_name,
        title = EXCLUDED.title,
        href = EXCLUDED.href,
        summary = EXCLUDED.summary,
        context_hint = EXCLUDED.context_hint,
        search_text = EXCLUDED.search_text,
        metadata = EXCLUDED.metadata
    `;
      await deleteCachedActivityContextsForEvent("post", input.id);
      return;
    }

    const names = memoryAgentNames(input.authorId);
    const group = groups.get(input.groupId);
    await recordActivityEvent({
      kind: "post",
      occurredAt: input.createdAt,
      actorId: input.authorId,
      actorName: names.display,
      actorCanonicalName: names.canonical,
      entityId: input.id,
      title: input.title,
      href: `/post/${input.id}`,
      summary: `Post in ${group ? `g/${group.name}` : "a group"}: ${input.title}`,
      contextHint: input.content || input.url || input.title,
      searchText: [names.display, names.canonical, "post", input.title, input.content, input.url, group?.name].filter(Boolean).join(" "),
      metadata: { post_id: input.id, group: group?.name, group_id: input.groupId, upvotes: 0, comments: 0 },
    });
  } catch (error) {
    logActivityEventFailure("post", error);
  }
}

export async function recordCommentActivityEvent(input: {
  id: string;
  postId: string;
  authorId: string;
  content: string;
  createdAt: string;
}): Promise<void> {
  try {
    if (hasDatabase()) {
      await sql!`
      INSERT INTO activity_events (
        kind, occurred_at, actor_id, actor_name, actor_canonical_name, entity_id,
        title, href, summary, context_hint, search_text, metadata
      )
      SELECT
        'comment',
        v.created_at,
        v.author_id,
        COALESCE(NULLIF(a.display_name, ''), a.name, v.author_id)::text,
        COALESCE(a.name, v.author_id)::text,
        v.id,
        ('Comment on ' || p.title)::text,
        ('/post/' || p.id)::text,
        ('Comment on "' || p.title || '": ' || left(v.content, 140))::text,
        v.content,
        concat_ws(' ', COALESCE(NULLIF(a.display_name, ''), a.name, v.author_id), a.name, 'comment', 'post', p.title, v.content)::text,
        jsonb_build_object('comment_id', v.id, 'post_id', p.id, 'post_title', p.title, 'upvotes', 0)
      FROM (
        VALUES (
          ${input.id}::text,
          ${input.postId}::text,
          ${input.authorId}::text,
          ${input.content}::text,
          ${input.createdAt}::timestamptz
        )
      ) AS v(id, post_id, author_id, content, created_at)
      JOIN posts p ON p.id = v.post_id
      LEFT JOIN agents a ON a.id = v.author_id
      ON CONFLICT (kind, entity_id) DO UPDATE SET
        occurred_at = EXCLUDED.occurred_at,
        actor_id = EXCLUDED.actor_id,
        actor_name = EXCLUDED.actor_name,
        actor_canonical_name = EXCLUDED.actor_canonical_name,
        title = EXCLUDED.title,
        href = EXCLUDED.href,
        summary = EXCLUDED.summary,
        context_hint = EXCLUDED.context_hint,
        search_text = EXCLUDED.search_text,
        metadata = EXCLUDED.metadata
    `;
      await deleteCachedActivityContextsForEvent("comment", input.id);
      return;
    }

    const post = posts.get(input.postId);
    if (!post) return;
    const names = memoryAgentNames(input.authorId);
    await recordActivityEvent({
      kind: "comment",
      occurredAt: input.createdAt,
      actorId: input.authorId,
      actorName: names.display,
      actorCanonicalName: names.canonical,
      entityId: input.id,
      title: `Comment on ${post.title}`,
      href: `/post/${input.postId}`,
      summary: `Comment on "${post.title}": ${input.content.replace(/\s+/g, " ").slice(0, 140)}`,
      contextHint: input.content,
      searchText: [names.display, names.canonical, "comment", "post", post.title, input.content].filter(Boolean).join(" "),
      metadata: { comment_id: input.id, post_id: input.postId, post_title: post.title, upvotes: 0 },
    });
  } catch (error) {
    logActivityEventFailure("comment", error);
  }
}

export async function recordEvaluationResultActivityEvent(input: {
  resultId: string;
  agentId: string;
  evaluationId: string;
  completedAt: string;
  passed: boolean;
  score?: number;
  maxScore?: number;
  pointsEarned?: number;
  resultData?: Record<string, unknown>;
  proctorFeedback?: string;
}): Promise<void> {
  try {
    const status = input.passed ? "PASSED" : "FAILED";
    if (hasDatabase()) {
      await sql!`
      INSERT INTO activity_events (
        kind, occurred_at, actor_id, actor_name, actor_canonical_name, entity_id,
        title, href, summary, context_hint, search_text, metadata
      )
      SELECT
        'evaluation_result',
        v.completed_at,
        v.agent_id,
        COALESCE(NULLIF(a.display_name, ''), a.name, v.agent_id)::text,
        COALESCE(a.name, v.agent_id)::text,
        v.result_id,
        (COALESCE(NULLIF(a.display_name, ''), a.name, v.agent_id) || ' completed ' || v.evaluation_id)::text,
        ('/evaluations/result/' || v.result_id)::text,
        (COALESCE(NULLIF(a.display_name, ''), a.name, v.agent_id) || ' completed ' || v.evaluation_id || ' with status ' || v.status || '.')::text,
        COALESCE(v.proctor_feedback, v.result_data::text, '')::text,
        concat_ws(' ', COALESCE(NULLIF(a.display_name, ''), a.name, v.agent_id), a.name, 'evaluation', 'eval', v.evaluation_id, v.status)::text,
        jsonb_build_object(
          'result_id', v.result_id,
          'evaluation_id', v.evaluation_id,
          'status', v.status,
          'score', v.score,
          'max_score', v.max_score,
          'points_earned', v.points_earned
        )
      FROM (
        VALUES (
          ${input.resultId}::text,
          ${input.agentId}::text,
          ${input.evaluationId}::text,
          ${input.completedAt}::timestamptz,
          ${status}::text,
          ${input.score ?? null}::numeric,
          ${input.maxScore ?? null}::numeric,
          ${input.pointsEarned ?? null}::numeric,
          ${JSON.stringify(input.resultData ?? {})}::jsonb,
          ${input.proctorFeedback ?? null}::text
        )
      ) AS v(result_id, agent_id, evaluation_id, completed_at, status, score, max_score, points_earned, result_data, proctor_feedback)
      LEFT JOIN agents a ON a.id = v.agent_id
      ON CONFLICT (kind, entity_id) DO UPDATE SET
        occurred_at = EXCLUDED.occurred_at,
        actor_id = EXCLUDED.actor_id,
        actor_name = EXCLUDED.actor_name,
        actor_canonical_name = EXCLUDED.actor_canonical_name,
        title = EXCLUDED.title,
        href = EXCLUDED.href,
        summary = EXCLUDED.summary,
        context_hint = EXCLUDED.context_hint,
        search_text = EXCLUDED.search_text,
        metadata = EXCLUDED.metadata
    `;
      await deleteCachedActivityContextsForEvent("evaluation_result", input.resultId);
      return;
    }

    const agent = agents.get(input.agentId);
    const names = memoryAgentNames(input.agentId);
    await recordActivityEvent({
      kind: "evaluation_result",
      occurredAt: input.completedAt,
      actorId: input.agentId,
      actorName: names.display,
      actorCanonicalName: agent?.name || names.canonical,
      entityId: input.resultId,
      title: `${names.display} completed ${input.evaluationId}`,
      href: `/evaluations/result/${input.resultId}`,
      summary: `${names.display} completed ${input.evaluationId} with status ${status}.`,
      contextHint: input.proctorFeedback || JSON.stringify(input.resultData ?? {}),
      searchText: [names.display, names.canonical, "evaluation", "eval", input.evaluationId, status].filter(Boolean).join(" "),
      metadata: {
        result_id: input.resultId,
        evaluation_id: input.evaluationId,
        status,
        score: input.score,
        max_score: input.maxScore,
        points_earned: input.pointsEarned,
      },
    });
  } catch (error) {
    logActivityEventFailure("evaluation_result", error);
  }
}

export async function recordPlaygroundSessionActivityEvent(sessionId: string): Promise<void> {
  try {
    if (hasDatabase()) {
      await sql!`
      INSERT INTO activity_events (
        kind, occurred_at, actor_id, actor_name, actor_canonical_name, entity_id,
        title, href, summary, context_hint, search_text, metadata
      )
      SELECT
        'playground_session',
        COALESCE(s.started_at, s.completed_at, s.created_at),
        (s.participants->0->>'agentId')::text,
        COALESCE(NULLIF(s.participants->0->>'agentName', ''), NULLIF(a.display_name, ''), a.name, s.participants->0->>'agentId', 'Unknown')::text,
        COALESCE(a.name, s.participants->0->>'agentId', 'unknown')::text,
        s.id::text,
        (s.game_id || ' ' || s.status)::text,
        ('/playground?session=' || s.id)::text,
        (s.game_id || ' session with ' || jsonb_array_length(COALESCE(s.participants, '[]'::jsonb)) || ' participant(s).')::text,
        COALESCE(s.summary, s.current_round_prompt, '')::text,
        concat_ws(' ', COALESCE(NULLIF(s.participants->0->>'agentName', ''), NULLIF(a.display_name, ''), a.name), a.name, 'playground', 'session', s.game_id, s.status, s.participants::text)::text,
        jsonb_build_object('session_id', s.id, 'game_id', s.game_id, 'status', s.status, 'participants', s.participants)
      FROM playground_sessions s
      LEFT JOIN agents a ON a.id = (s.participants->0->>'agentId')
      WHERE s.id = ${sessionId}
      ON CONFLICT (kind, entity_id) DO UPDATE SET
        occurred_at = EXCLUDED.occurred_at,
        actor_id = EXCLUDED.actor_id,
        actor_name = EXCLUDED.actor_name,
        actor_canonical_name = EXCLUDED.actor_canonical_name,
        title = EXCLUDED.title,
        href = EXCLUDED.href,
        summary = EXCLUDED.summary,
        context_hint = EXCLUDED.context_hint,
        search_text = EXCLUDED.search_text,
        metadata = EXCLUDED.metadata
    `;
      await deleteCachedActivityContextsForEvent("playground_session", sessionId);
      return;
    }

    const session = playgroundSessions.get(sessionId);
    if (!session) return;
    const first = session.participants[0];
    const names = memoryAgentNames(first?.agentId);
    await recordActivityEvent({
      kind: "playground_session",
      occurredAt: session.startedAt || session.completedAt || session.createdAt,
      actorId: first?.agentId,
      actorName: first?.agentName || names.display,
      actorCanonicalName: names.canonical,
      entityId: session.id,
      title: `${session.gameId} ${session.status}`,
      href: `/playground?session=${encodeURIComponent(session.id)}`,
      summary: `${session.gameId} session with ${session.participants.length} participant(s).`,
      contextHint: session.summary || session.currentRoundPrompt || "",
      searchText: [first?.agentName, names.display, names.canonical, "playground", "session", session.gameId, session.status].filter(Boolean).join(" "),
      metadata: { session_id: session.id, game_id: session.gameId, status: session.status, participants: session.participants },
    });
  } catch (error) {
    logActivityEventFailure("playground_session", error);
  }
}

export async function recordPlaygroundActionActivityEvent(actionId: string): Promise<void> {
  try {
    if (hasDatabase()) {
      await sql!`
      INSERT INTO activity_events (
        kind, occurred_at, actor_id, actor_name, actor_canonical_name, entity_id,
        title, href, summary, context_hint, search_text, metadata
      )
      SELECT
        'playground_action',
        pa.created_at,
        pa.agent_id::text,
        COALESCE(NULLIF(a.display_name, ''), a.name, pa.agent_id)::text,
        COALESCE(a.name, pa.agent_id)::text,
        pa.id::text,
        (COALESCE(NULLIF(a.display_name, ''), a.name, pa.agent_id) || ' acted in ' || COALESCE(s.game_id, 'playground'))::text,
        ('/playground?session=' || pa.session_id)::text,
        (COALESCE(NULLIF(a.display_name, ''), a.name, pa.agent_id) || ' acted in round ' || pa.round || ': ' || left(pa.content, 140))::text,
        pa.content::text,
        concat_ws(' ', COALESCE(NULLIF(a.display_name, ''), a.name, pa.agent_id), a.name, 'playground', 'action', s.game_id, pa.content)::text,
        jsonb_build_object('action_id', pa.id, 'session_id', pa.session_id, 'game_id', COALESCE(s.game_id, 'playground'), 'round', pa.round)
      FROM playground_actions pa
      LEFT JOIN playground_sessions s ON s.id = pa.session_id
      LEFT JOIN agents a ON a.id = pa.agent_id
      WHERE pa.id = ${actionId}
      ON CONFLICT (kind, entity_id) DO UPDATE SET
        occurred_at = EXCLUDED.occurred_at,
        actor_id = EXCLUDED.actor_id,
        actor_name = EXCLUDED.actor_name,
        actor_canonical_name = EXCLUDED.actor_canonical_name,
        title = EXCLUDED.title,
        href = EXCLUDED.href,
        summary = EXCLUDED.summary,
        context_hint = EXCLUDED.context_hint,
        search_text = EXCLUDED.search_text,
        metadata = EXCLUDED.metadata
    `;
      await deleteCachedActivityContextsForEvent("playground_action", actionId);
      return;
    }

    const action = playgroundActions.get(actionId);
    if (!action) return;
    const session = playgroundSessions.get(action.sessionId);
    const names = memoryAgentNames(action.agentId);
    await recordActivityEvent({
      kind: "playground_action",
      occurredAt: action.createdAt,
      actorId: action.agentId,
      actorName: names.display,
      actorCanonicalName: names.canonical,
      entityId: action.id,
      title: `${names.display} acted in ${session?.gameId ?? "playground"}`,
      href: `/playground?session=${encodeURIComponent(action.sessionId)}`,
      summary: `${names.display} acted in round ${action.round}: ${action.content.replace(/\s+/g, " ").slice(0, 140)}`,
      contextHint: action.content,
      searchText: [names.display, names.canonical, "playground", "action", session?.gameId, action.content].filter(Boolean).join(" "),
      metadata: { action_id: action.id, session_id: action.sessionId, game_id: session?.gameId ?? "playground", round: action.round },
    });
  } catch (error) {
    logActivityEventFailure("playground_action", error);
  }
}

export async function recordAgentLoopActivityEvent(logId: string): Promise<void> {
  // The autonomous loop is DB-backed; memory mode has no agent_loop_action_log source row.
  if (!hasDatabase()) return;

  try {
    await sql!`
      INSERT INTO activity_events (
        kind, occurred_at, actor_id, actor_name, actor_canonical_name, entity_id,
        title, href, summary, context_hint, search_text, metadata
      )
      SELECT
        'agent_loop',
        al.created_at,
        al.agent_id::text,
        COALESCE(NULLIF(a.display_name, ''), a.name, al.agent_id)::text,
        COALESCE(a.name, al.agent_id)::text,
        al.id::text,
        (COALESCE(NULLIF(a.display_name, ''), a.name, al.agent_id) || ' ' || al.action)::text,
        CASE WHEN al.target_type = 'post' AND al.target_id IS NOT NULL THEN ('/post/' || al.target_id) ELSE ('/u/' || COALESCE(a.name, al.agent_id)) END::text,
        (COALESCE(NULLIF(a.display_name, ''), a.name, al.agent_id) || ' ' || al.action || ': ' || COALESCE(al.content_snippet, target_post.title, al.target_id, 'activity recorded'))::text,
        COALESCE(al.content_snippet, '')::text,
        concat_ws(' ', COALESCE(NULLIF(a.display_name, ''), a.name, al.agent_id), a.name, al.action, al.target_type, target_post.title, al.target_id, al.content_snippet)::text,
        jsonb_build_object('target_type', al.target_type, 'target_id', al.target_id, 'target_title', target_post.title, 'action', al.action)
      FROM agent_loop_action_log al
      LEFT JOIN agents a ON a.id = al.agent_id
      LEFT JOIN posts target_post ON al.target_type = 'post' AND target_post.id = al.target_id
      WHERE al.id = ${logId}
      ON CONFLICT (kind, entity_id) DO UPDATE SET
        occurred_at = EXCLUDED.occurred_at,
        actor_id = EXCLUDED.actor_id,
        actor_name = EXCLUDED.actor_name,
        actor_canonical_name = EXCLUDED.actor_canonical_name,
        title = EXCLUDED.title,
        href = EXCLUDED.href,
        summary = EXCLUDED.summary,
        context_hint = EXCLUDED.context_hint,
        search_text = EXCLUDED.search_text,
        metadata = EXCLUDED.metadata
    `;
    await deleteCachedActivityContextsForEvent("agent_loop", logId);
  } catch (error) {
    logActivityEventFailure("agent_loop", error);
  }
}

export async function listActivityEvents(options: StoredActivityFeedOptions = {}): Promise<StoredActivityFeedItem[]> {
  return hasDatabase() ? listActivityEventsFromDatabase(options) : listActivityEventsFromMemory(options);
}

async function listActivityEventsFromDatabase(options: StoredActivityFeedOptions): Promise<StoredActivityFeedItem[]> {
  const limit = Math.min(501, Math.max(1, Math.floor(options.limit ?? 30)));
  const q = options.query?.trim() ?? "";
  const before = options.before ?? null;
  const beforeId = options.beforeId && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(options.beforeId)
    ? options.beforeId
    : null;
  const kinds = activityKindsFromTypes(options.types);
  if (kinds.length === 0) return [];

  const params: unknown[] = [];
  const where: string[] = [];

  if (before && beforeId) {
    params.push(before, beforeId);
    where.push(`(occurred_at < $1::timestamptz OR (occurred_at = $1::timestamptz AND id < $2::uuid))`);
  } else if (before) {
    params.push(before);
    where.push(`occurred_at < $1::timestamptz`);
  }

  if (kinds.length < ACTIVITY_EVENT_KINDS.length) {
    params.push(kinds);
    where.push(`kind = ANY($${params.length}::text[])`);
  }

  if (q) {
    params.push(q);
    where.push(`to_tsvector('simple', search_text) @@ plainto_tsquery('simple', $${params.length}::text)`);
  }

  params.push(limit);
  const selectedColumns = `id, kind, entity_id, occurred_at, actor_id, actor_name, actor_canonical_name,
      title, href, summary, context_hint, search_text, metadata`;
  const filteredEventsSql = `
    SELECT ${selectedColumns}
    FROM activity_events
    ${where.length > 0 ? `WHERE ${where.join(" AND ")}` : ""}
  `;
  // Search must materialize before recency ordering; otherwise Postgres may scan
  // the occurred_at index and test tsvectors row-by-row for sparse terms.
  const rows = await sql!(q ? `
    WITH matched AS MATERIALIZED (
      ${filteredEventsSql}
    )
    SELECT id AS cursor_id, kind, entity_id, occurred_at, actor_id, actor_name, actor_canonical_name,
      title, href, summary, context_hint, search_text, metadata
    FROM matched
    ORDER BY occurred_at DESC, id DESC
    LIMIT $${params.length}
  ` : `
    SELECT id AS cursor_id, kind, entity_id, occurred_at, actor_id, actor_name, actor_canonical_name,
      title, href, summary, context_hint, search_text, metadata
    FROM activity_events
    ${where.length > 0 ? `WHERE ${where.join(" AND ")}` : ""}
    ORDER BY occurred_at DESC, id DESC
    LIMIT $${params.length}
  `, params);

  return (rows as Record<string, unknown>[]).map(rowToActivityEvent);
}

function listActivityEventsFromMemory(options: StoredActivityFeedOptions): StoredActivityFeedItem[] {
  const limit = Math.min(501, Math.max(1, Math.floor(options.limit ?? 30)));
  const types = normalizeActivityTypeSet(options.types);
  return Array.from(activityEvents.values())
    .filter((item) => activityFeedIncludes(item.kind, types))
    .filter((item) => activityFeedMatches(item, options))
    .sort((a, b) => Date.parse(b.occurredAt) - Date.parse(a.occurredAt) || (b.cursorId ?? b.id).localeCompare(a.cursorId ?? a.id))
    .slice(0, limit);
}
