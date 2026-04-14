/**
 * Persistent dashboard chat sessions (30-day TTL).
 */
import { sql } from "@/lib/db";
import type { StoredChatSession, ChatSessionSummary, DashboardChatMessage } from "./store-types";

function generateSessionId(): string {
  return `cs_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

function rowToSession(r: Record<string, unknown>): StoredChatSession {
  return {
    id: r.id as string,
    userId: r.user_id as string,
    agentId: r.agent_id as string,
    messages: r.messages as DashboardChatMessage[],
    createdAt: r.created_at instanceof Date ? r.created_at.toISOString() : String(r.created_at),
    lastMessageAt:
      r.last_message_at instanceof Date
        ? r.last_message_at.toISOString()
        : String(r.last_message_at),
    expiresAt:
      r.expires_at instanceof Date ? r.expires_at.toISOString() : String(r.expires_at),
  };
}

/** Create a new empty chat session and return it */
export async function createChatSession(
  userId: string,
  agentId: string
): Promise<StoredChatSession> {
  const id = generateSessionId();
  const rows = await sql!`
    INSERT INTO dashboard_chat_sessions (id, user_id, agent_id, messages)
    VALUES (${id}, ${userId}, ${agentId}, '[]'::jsonb)
    RETURNING *
  `;
  return rowToSession(rows[0] as Record<string, unknown>);
}

/** Replace the full messages array; enforces ownership and non-expiry */
export async function saveChatSession(
  sessionId: string,
  userId: string,
  messages: DashboardChatMessage[]
): Promise<boolean> {
  const rows = await sql!`
    UPDATE dashboard_chat_sessions
    SET
      messages = ${JSON.stringify(messages)}::jsonb,
      last_message_at = NOW()
    WHERE id = ${sessionId} AND user_id = ${userId} AND expires_at > NOW()
    RETURNING id
  `;
  return rows.length > 0;
}

/** Load a single session (ownership enforced via user_id) */
export async function getChatSession(
  sessionId: string,
  userId: string
): Promise<StoredChatSession | null> {
  const rows = await sql!`
    SELECT * FROM dashboard_chat_sessions
    WHERE id = ${sessionId} AND user_id = ${userId} AND expires_at > NOW()
    LIMIT 1
  `;
  const r = rows[0] as Record<string, unknown> | undefined;
  return r ? rowToSession(r) : null;
}

/** List all non-expired sessions for a user, newest first, joined with agent name */
export async function listChatSessions(userId: string): Promise<ChatSessionSummary[]> {
  const rows = await sql!`
    SELECT
      s.id,
      s.agent_id,
      a.name          AS agent_name,
      a.display_name  AS agent_display_name,
      s.messages,
      s.last_message_at,
      s.expires_at,
      jsonb_array_length(s.messages) AS message_count
    FROM dashboard_chat_sessions s
    INNER JOIN agents a ON a.id = s.agent_id
    WHERE s.user_id = ${userId} AND s.expires_at > NOW()
    ORDER BY s.last_message_at DESC
    LIMIT 100
  `;

  return (rows as Record<string, unknown>[]).map((r) => {
    const msgs = r.messages as DashboardChatMessage[];
    const first = msgs[0]?.content ?? "";
    return {
      id: r.id as string,
      agentId: r.agent_id as string,
      agentName: r.agent_name as string,
      agentDisplayName: (r.agent_display_name as string | null) ?? null,
      firstMessage: first.length > 120 ? first.slice(0, 117) + "…" : first,
      lastMessageAt:
        r.last_message_at instanceof Date
          ? r.last_message_at.toISOString()
          : String(r.last_message_at),
      expiresAt:
        r.expires_at instanceof Date ? r.expires_at.toISOString() : String(r.expires_at),
      messageCount: Number(r.message_count),
    };
  });
}

/** Delete a session (user must own it) */
export async function deleteChatSession(
  sessionId: string,
  userId: string
): Promise<boolean> {
  const rows = await sql!`
    DELETE FROM dashboard_chat_sessions
    WHERE id = ${sessionId} AND user_id = ${userId}
    RETURNING id
  `;
  return rows.length > 0;
}
