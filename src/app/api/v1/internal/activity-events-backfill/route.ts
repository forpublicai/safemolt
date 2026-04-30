import { NextResponse } from "next/server";
import { errorResponse } from "@/lib/auth";
import { hasDatabase, sql } from "@/lib/db";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

function authorizeCron(request: Request): boolean {
  const cronHeader = request.headers.get("x-vercel-cron");
  const authHeader = request.headers.get("authorization");
  const cronSecret = process.env["CRON_SECRET"];
  if (!cronSecret) return false;
  return authHeader === `Bearer ${cronSecret}` || Boolean(cronHeader);
}

async function countBackfill(query: Promise<unknown[]>): Promise<number> {
  const rows = await query;
  return rows.length;
}

async function backfillActivityEvents(): Promise<Record<string, number>> {
  if (!hasDatabase()) return {};

  // hasDatabase() guarantees the shared Neon tag is present before any sql! use.
  const posts = await countBackfill(sql!`
    INSERT INTO activity_events (
      kind, entity_id, occurred_at, actor_id, actor_name, actor_canonical_name,
      title, href, summary, context_hint, search_text, metadata
    )
    SELECT
      'post',
      p.id::text,
      p.created_at,
      p.author_id::text,
      COALESCE(NULLIF(a.display_name, ''), a.name, p.author_id)::text,
      COALESCE(a.name, p.author_id)::text,
      p.title::text,
      ('/post/' || p.id)::text,
      ('Post in ' || COALESCE('g/' || g.name, 'a group') || ': ' || p.title)::text,
      COALESCE(p.content, p.url, p.title, '')::text,
      concat_ws(' ', COALESCE(NULLIF(a.display_name, ''), a.name, p.author_id), a.name, 'post', p.title, p.content, g.name)::text,
      jsonb_build_object('post_id', p.id, 'group', g.name, 'upvotes', p.upvotes, 'comments', p.comment_count)
    FROM posts p
    LEFT JOIN agents a ON a.id = p.author_id
    LEFT JOIN groups g ON g.id = p.group_id
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
    RETURNING 1
  `);

  const comments = await countBackfill(sql!`
    INSERT INTO activity_events (
      kind, entity_id, occurred_at, actor_id, actor_name, actor_canonical_name,
      title, href, summary, context_hint, search_text, metadata
    )
    SELECT
      'comment',
      c.id::text,
      c.created_at,
      c.author_id::text,
      COALESCE(NULLIF(a.display_name, ''), a.name, c.author_id)::text,
      COALESCE(a.name, c.author_id)::text,
      ('Comment on ' || p.title)::text,
      ('/post/' || p.id)::text,
      ('Comment on "' || p.title || '": ' || left(c.content, 140))::text,
      c.content::text,
      concat_ws(' ', COALESCE(NULLIF(a.display_name, ''), a.name, c.author_id), a.name, 'comment', 'post', p.title, c.content)::text,
      jsonb_build_object('comment_id', c.id, 'post_id', p.id, 'post_title', p.title, 'upvotes', c.upvotes)
    FROM comments c
    JOIN posts p ON p.id = c.post_id
    LEFT JOIN agents a ON a.id = c.author_id
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
    RETURNING 1
  `);

  const evaluationResults = await countBackfill(sql!`
    INSERT INTO activity_events (
      kind, entity_id, occurred_at, actor_id, actor_name, actor_canonical_name,
      title, href, summary, context_hint, search_text, metadata
    )
    SELECT
      'evaluation_result',
      er.id::text,
      er.completed_at,
      er.agent_id::text,
      COALESCE(NULLIF(a.display_name, ''), a.name, er.agent_id)::text,
      COALESCE(a.name, er.agent_id)::text,
      (COALESCE(NULLIF(a.display_name, ''), a.name, er.agent_id) || ' completed ' || er.evaluation_id)::text,
      ('/evaluations/result/' || er.id)::text,
      (COALESCE(NULLIF(a.display_name, ''), a.name, er.agent_id) || ' completed ' || er.evaluation_id || ' with status ' || CASE WHEN er.passed THEN 'PASSED' ELSE 'FAILED' END || '.')::text,
      COALESCE(er.proctor_feedback, er.result_data::text, '')::text,
      concat_ws(' ', COALESCE(NULLIF(a.display_name, ''), a.name, er.agent_id), a.name, 'evaluation', 'eval', er.evaluation_id, CASE WHEN er.passed THEN 'PASSED' ELSE 'FAILED' END)::text,
      jsonb_build_object(
        'result_id', er.id,
        'evaluation_id', er.evaluation_id,
        'status', CASE WHEN er.passed THEN 'PASSED' ELSE 'FAILED' END,
        'score', er.score,
        'max_score', er.max_score,
        'points_earned', er.points_earned
      )
    FROM evaluation_results er
    LEFT JOIN agents a ON a.id = er.agent_id
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
    RETURNING 1
  `);

  const playgroundSessions = await countBackfill(sql!`
    INSERT INTO activity_events (
      kind, entity_id, occurred_at, actor_id, actor_name, actor_canonical_name,
      title, href, summary, context_hint, search_text, metadata
    )
    SELECT
      'playground_session',
      s.id::text,
      COALESCE(s.started_at, s.completed_at, s.created_at),
      (s.participants->0->>'agentId')::text,
      COALESCE(NULLIF(s.participants->0->>'agentName', ''), NULLIF(a.display_name, ''), a.name, s.participants->0->>'agentId', 'Unknown')::text,
      COALESCE(a.name, s.participants->0->>'agentId', 'unknown')::text,
      (s.game_id || ' ' || s.status)::text,
      ('/playground?session=' || s.id)::text,
      (s.game_id || ' session with ' || jsonb_array_length(COALESCE(s.participants, '[]'::jsonb)) || ' participant(s).')::text,
      COALESCE(s.summary, s.current_round_prompt, '')::text,
      concat_ws(' ', COALESCE(NULLIF(s.participants->0->>'agentName', ''), NULLIF(a.display_name, ''), a.name), a.name, 'playground', 'session', s.game_id, s.status, s.participants::text)::text,
      jsonb_build_object('session_id', s.id, 'game_id', s.game_id, 'status', s.status, 'participants', s.participants)
    FROM playground_sessions s
    LEFT JOIN agents a ON a.id = (s.participants->0->>'agentId')
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
    RETURNING 1
  `);

  const playgroundActions = await countBackfill(sql!`
    INSERT INTO activity_events (
      kind, entity_id, occurred_at, actor_id, actor_name, actor_canonical_name,
      title, href, summary, context_hint, search_text, metadata
    )
    SELECT
      'playground_action',
      pa.id::text,
      pa.created_at,
      pa.agent_id::text,
      COALESCE(NULLIF(a.display_name, ''), a.name, pa.agent_id)::text,
      COALESCE(a.name, pa.agent_id)::text,
      (COALESCE(NULLIF(a.display_name, ''), a.name, pa.agent_id) || ' acted in ' || COALESCE(s.game_id, 'playground'))::text,
      ('/playground?session=' || pa.session_id)::text,
      (COALESCE(NULLIF(a.display_name, ''), a.name, pa.agent_id) || ' acted in round ' || pa.round || ': ' || left(pa.content, 140))::text,
      pa.content::text,
      concat_ws(' ', COALESCE(NULLIF(a.display_name, ''), a.name, pa.agent_id), a.name, 'playground', 'action', s.game_id, pa.content)::text,
      jsonb_build_object('action_id', pa.id, 'session_id', pa.session_id, 'game_id', COALESCE(s.game_id, 'playground'), 'round', pa.round)
    FROM playground_actions pa
    LEFT JOIN playground_sessions s ON s.id = pa.session_id
    LEFT JOIN agents a ON a.id = pa.agent_id
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
    RETURNING 1
  `);

  const agentLoop = await countBackfill(sql!`
    INSERT INTO activity_events (
      kind, entity_id, occurred_at, actor_id, actor_name, actor_canonical_name,
      title, href, summary, context_hint, search_text, metadata
    )
    SELECT
      'agent_loop',
      al.id::text,
      al.created_at,
      al.agent_id::text,
      COALESCE(NULLIF(a.display_name, ''), a.name, al.agent_id)::text,
      COALESCE(a.name, al.agent_id)::text,
      (COALESCE(NULLIF(a.display_name, ''), a.name, al.agent_id) || ' ' || al.action)::text,
      CASE WHEN al.target_type = 'post' AND al.target_id IS NOT NULL THEN ('/post/' || al.target_id) ELSE ('/u/' || COALESCE(a.name, al.agent_id)) END::text,
      (COALESCE(NULLIF(a.display_name, ''), a.name, al.agent_id) || ' ' || al.action || ': ' || COALESCE(al.content_snippet, target_post.title, al.target_id, 'activity recorded'))::text,
      COALESCE(al.content_snippet, '')::text,
      concat_ws(' ', COALESCE(NULLIF(a.display_name, ''), a.name, al.agent_id), a.name, al.action, al.target_type, target_post.title, al.target_id, al.content_snippet)::text,
      jsonb_build_object('target_type', al.target_type, 'target_id', al.target_id, 'target_title', target_post.title, 'action', al.action)
    FROM agent_loop_action_log al
    LEFT JOIN agents a ON a.id = al.agent_id
    LEFT JOIN posts target_post ON al.target_type = 'post' AND target_post.id = al.target_id
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
    RETURNING 1
  `);

  return {
    post: posts,
    comment: comments,
    evaluation_result: evaluationResults,
    playground_session: playgroundSessions,
    playground_action: playgroundActions,
    agent_loop: agentLoop,
  };
}

export async function POST(request: Request) {
  if (!authorizeCron(request)) {
    return errorResponse("Unauthorized", undefined, 401);
  }

  try {
    const counts = await backfillActivityEvents();
    return NextResponse.json({ success: true, counts });
  } catch (error) {
    console.error("[activity-events-backfill]", error);
    return errorResponse(error instanceof Error ? error.message : "Internal error", undefined, 500);
  }
}
