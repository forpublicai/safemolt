import type { StoredNotification } from "@/lib/store-types";
import { generateId, notifications } from "../_memory-state";

export interface CreateNotificationInput {
  agentId: string;
  type: StoredNotification["type"];
  priority: StoredNotification["priority"];
  actor: StoredNotification["actor"];
  target: StoredNotification["target"];
  href: string;
  webUrl?: string;
  deadlineAt?: string;
  metadata?: Record<string, unknown>;
  createdAt?: string;
}

export async function createNotification(input: CreateNotificationInput): Promise<StoredNotification> {
  const row: StoredNotification = {
    id: generateId("notif"),
    agent_id: input.agentId,
    type: input.type,
    priority: input.priority,
    created_at: input.createdAt ?? new Date().toISOString(),
    read_at: null,
    actor: input.actor,
    target: input.target,
    href: input.href,
    web_url: input.webUrl,
    deadline_at: input.deadlineAt,
    metadata: input.metadata ?? {},
  };
  notifications.set(row.id, row);
  return row;
}

export async function listNotifications(
  agentId: string,
  options: { limit?: number; unreadOnly?: boolean } = {}
): Promise<StoredNotification[]> {
  const limit = Math.min(50, Math.max(1, Math.floor(options.limit ?? 25)));
  return Array.from(notifications.values())
    .filter((n) => n.agent_id === agentId)
    .filter((n) => !options.unreadOnly || n.read_at === null)
    .sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at) || b.id.localeCompare(a.id))
    .slice(0, limit);
}

export async function markNotificationRead(
  agentId: string,
  notificationId: string
): Promise<{ success: boolean; error?: string }> {
  const row = notifications.get(notificationId);
  if (!row || row.agent_id !== agentId) return { success: false, error: "not_found" };
  if (!row.read_at) notifications.set(notificationId, { ...row, read_at: new Date().toISOString() });
  return { success: true };
}

export async function markAllNotificationsRead(agentId: string): Promise<{ markedCount: number }> {
  const now = new Date().toISOString();
  let markedCount = 0;
  for (const [id, row] of Array.from(notifications.entries())) {
    if (row.agent_id === agentId && row.read_at === null) {
      notifications.set(id, { ...row, read_at: now });
      markedCount += 1;
    }
  }
  return { markedCount };
}

export async function countUnreadNotifications(agentId: string): Promise<number> {
  return Array.from(notifications.values()).filter((n) => n.agent_id === agentId && n.read_at === null).length;
}

export function __resetNotificationsForTests(): void {
  notifications.clear();
}
