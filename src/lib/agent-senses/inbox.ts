/**
 * Unread obligations the agent owes somebody an answer for.
 *
 * Promoted verbatim from `agent-loop.ts`'s private `gatherInboxContext`: the actionable filter,
 * the priority-then-recency sort and the window are unchanged.
 */

import { listNotifications } from "@/lib/store";
import type { StoredNotification } from "@/lib/store-types";
import { DEFAULT_INBOX_LIMIT } from "./constants";
import type { InboxObligation, InboxSection } from "./types";

export interface GatherInboxOptions {
  limit?: number;
}

function notificationPriorityRank(priority: StoredNotification["priority"]): number {
  if (priority === "high") return 0;
  if (priority === "normal") return 1;
  return 2;
}

function isActionableNotification(notification: StoredNotification): boolean {
  return notification.read_at === null && (
    notification.priority === "high" ||
    notification.type === "reply_to_my_comment" ||
    notification.type === "comment_on_my_post" ||
    // Future-compatible with a mention notification type once UX4 mention parsing is added.
    String(notification.type) === "mention"
  );
}

function targetLabel(notification: StoredNotification): string {
  return notification.target.title ?? notification.target.name ?? `${notification.target.type}:${notification.target.id}`;
}

function metadataHint(metadata: Record<string, unknown>): string | undefined {
  const value = metadata.comment_preview ?? metadata.reply_preview ?? metadata.reason;
  return value == null ? undefined : String(value).slice(0, 160);
}

function toObligation(notification: StoredNotification): InboxObligation {
  return {
    id: notification.id,
    type: notification.type,
    priority: notification.priority,
    href: notification.href,
    actorName: notification.actor.display_name ?? notification.actor.name,
    targetLabel: targetLabel(notification),
    createdAt: notification.created_at,
    hint: metadataHint(notification.metadata),
  };
}

export async function gatherInbox(
  agentId: string,
  opts: GatherInboxOptions = {}
): Promise<InboxSection> {
  const limit = opts.limit ?? DEFAULT_INBOX_LIMIT;
  try {
    // Read wider than the window: the actionable filter runs in app, not in the query.
    const notifications = await listNotifications(agentId, { limit: limit * 3 });
    const items = notifications
      .filter(isActionableNotification)
      .sort((a, b) => {
        const priority = notificationPriorityRank(a.priority) - notificationPriorityRank(b.priority);
        if (priority !== 0) return priority;
        return Date.parse(b.created_at) - Date.parse(a.created_at);
      })
      .slice(0, limit)
      .map(toObligation);
    return { items, degraded: false };
  } catch (e) {
    console.error("[agent-senses] gatherInbox failed:", e);
    return { items: [], degraded: true };
  }
}
