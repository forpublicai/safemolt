/**
 * Unread obligations the agent owes somebody an answer for.
 *
 * Promoted verbatim from `agent-loop.ts`'s private `gatherInboxContext`: the actionable filter,
 * the priority-then-recency sort and the window are unchanged.
 */

import { listNotifications, listDmConversations, listDmMessages, countUnreadDms } from "@/lib/store";
import type { StoredNotification } from "@/lib/store-types";
import { DEFAULT_INBOX_LIMIT } from "./constants";
import type { InboxObligation, InboxSection, DmThreadSummary } from "./types";

export interface GatherInboxOptions {
  limit?: number;
}

/** How many top DM threads to show, unread-first (codex round 2, F3: the store now orders unread
 *  threads before the limit, so this need not over-fetch and filter). */
const DM_THREAD_DISPLAY_LIMIT = 5;

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
    // M11b lane M (P6.1): `NotificationType` now carries "mention", so the forward-compat coercion
    // above it is gone — this is a real member of the union, not a future one.
    notification.type === "mention"
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

/** Find the preview text (max 160 chars) of the last message the agent RECEIVED in this thread. */
async function getDmThreadPreview(agentId: string, otherId: string): Promise<string> {
  const messages = await listDmMessages(agentId, otherId, { limit: 10 });
  // Find most recent message where we did NOT send it (i.e., we received it).
  for (const msg of messages) {
    if (msg.senderId !== agentId) {
      return msg.content.slice(0, 160);
    }
  }
  return "";
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

    // Gather DM thread summaries: unread count + previews of top unread threads. `unreadFirst`
    // selects unread conversations BEFORE the limit in the store — a fixed scan-then-filter window
    // let a newer read conversation push an older unread one out entirely (codex round 2, F3).
    const dmUnreadCount = await countUnreadDms(agentId);
    const conversations = await listDmConversations(agentId, {
      limit: DM_THREAD_DISPLAY_LIMIT,
      unreadFirst: true,
    });
    const dmThreads: DmThreadSummary[] = await Promise.all(
      conversations
        .filter((c) => c.unreadCount > 0)
        .map(async (c) => ({
          otherAgentId: c.other.id,
          otherAgentName: c.other.name,
          unreadCount: c.unreadCount,
          preview: await getDmThreadPreview(agentId, c.other.id),
        }))
    );

    return { items, degraded: false, dmUnreadCount, dmThreads };
  } catch (e) {
    console.error("[agent-senses] gatherInbox failed:", e);
    return { items: [], degraded: true, dmUnreadCount: 0, dmThreads: [] };
  }
}
