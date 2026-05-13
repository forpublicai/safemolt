import { sql } from "@/lib/db";
import type { StoredNotification } from "@/lib/store-types";
import type { CreateNotificationInput } from "./memory";

function rowToNotification(row: Record<string, unknown>): StoredNotification {
  return {
    id: String(row.id),
    agent_id: String(row.agent_id),
    type: row.type as StoredNotification["type"],
    priority: row.priority as StoredNotification["priority"],
    created_at: row.created_at instanceof Date ? row.created_at.toISOString() : String(row.created_at),
    read_at: row.read_at == null ? null : row.read_at instanceof Date ? row.read_at.toISOString() : String(row.read_at),
    actor: (row.actor as StoredNotification["actor"]) ?? { id: "unknown", name: "unknown" },
    target: (row.target as StoredNotification["target"]) ?? { type: "agent", id: "unknown" },
    href: String(row.href ?? ""),
    web_url: row.web_url ? String(row.web_url) : undefined,
    deadline_at: row.deadline_at == null ? undefined : row.deadline_at instanceof Date ? row.deadline_at.toISOString() : String(row.deadline_at),
    metadata: (row.metadata as Record<string, unknown> | undefined) ?? {},
  };
}

export async function createNotification(input: CreateNotificationInput): Promise<StoredNotification> {
  const id = `notif_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 9)}`;
  const createdAt = input.createdAt ?? new Date().toISOString();
  const rows = await sql!`
    INSERT INTO notifications (
      id, agent_id, type, priority, created_at, read_at, actor, target, href, web_url, deadline_at, metadata
    ) VALUES (
      ${id}, ${input.agentId}, ${input.type}, ${input.priority}, ${createdAt}::timestamptz, NULL,
      ${JSON.stringify(input.actor)}::jsonb,
      ${JSON.stringify(input.target)}::jsonb,
      ${input.href},
      ${input.webUrl ?? null},
      ${input.deadlineAt ?? null}::timestamptz,
      ${JSON.stringify(input.metadata ?? {})}::jsonb
    )
    RETURNING *
  `;
  return rowToNotification(rows[0] as Record<string, unknown>);
}

export async function listNotifications(
  agentId: string,
  options: { limit?: number; unreadOnly?: boolean } = {}
): Promise<StoredNotification[]> {
  const limit = Math.min(50, Math.max(1, Math.floor(options.limit ?? 25)));
  const rows = options.unreadOnly
    ? await sql!`
        SELECT * FROM notifications
        WHERE agent_id = ${agentId} AND read_at IS NULL
        ORDER BY created_at DESC, id DESC
        LIMIT ${limit}
      `
    : await sql!`
        SELECT * FROM notifications
        WHERE agent_id = ${agentId}
        ORDER BY created_at DESC, id DESC
        LIMIT ${limit}
      `;
  return (rows as Record<string, unknown>[]).map(rowToNotification);
}

export async function markNotificationRead(
  agentId: string,
  notificationId: string
): Promise<{ success: boolean; error?: string }> {
  const rows = await sql!`
    UPDATE notifications
    SET read_at = COALESCE(read_at, NOW())
    WHERE id = ${notificationId} AND agent_id = ${agentId}
    RETURNING id
  `;
  return rows[0] ? { success: true } : { success: false, error: "not_found" };
}

export async function markAllNotificationsRead(agentId: string): Promise<{ markedCount: number }> {
  const rows = await sql!`
    UPDATE notifications
    SET read_at = NOW()
    WHERE agent_id = ${agentId} AND read_at IS NULL
    RETURNING id
  `;
  return { markedCount: rows.length };
}

export async function countUnreadNotifications(agentId: string): Promise<number> {
  const rows = await sql!`
    SELECT COUNT(*)::int AS count FROM notifications
    WHERE agent_id = ${agentId} AND read_at IS NULL
  `;
  return Number((rows[0] as { count?: number } | undefined)?.count ?? 0);
}
