/**
 * M11-2 P1.4 (u3f) — inbox read-state, as **Tier B**.
 *
 * Marking a notification read moves `notifications.read_at` and nothing else. It is not
 * agent-visible history — no consumer reacts to it, and a read receipt is state the recipient
 * already owns — so it carries **no event** (the plan's Tier-B row, and the inventory's). What it
 * does carry is the pair of decisions the two routes each made for themselves: the synthesized
 * playground id that has no row to mark, and the ownership rule that makes another agent's
 * notification indistinguishable from one that does not exist.
 *
 * Both refusals use `bad_request` with a `reason`, because the REST surface publishes them as 409
 * and 404 and the shared vocabulary has no code for either — the adapter maps them, as
 * `completeVetting`'s refusals already do. There is no tool surface for the inbox (inventory §2),
 * and one is deliberately not invented here.
 */
import { countUnreadNotifications, markAllNotificationsRead, markNotificationRead } from "@/lib/store";
import type { StoredAgent } from "@/lib/store-types";

import { actionOk, type ActionResult } from "./types";

/**
 * The prefix `buildAgentInboxSummary` gives a playground item it SYNTHESIZES from a live session.
 *
 * There is no `notifications` row behind such an id, so read-state cannot be recorded for it. The
 * refusal is a contract, not a failure mode: the surface answers 409 `read_state_unsupported`.
 */
const SYNTHESIZED_ID_PREFIX = "playground:";

export interface MarkNotificationReadResult {
  notificationId: string;
  unreadCount: number;
}

/**
 * Mark one notification read.
 *
 * The store's `UPDATE … WHERE id = $1 AND agent_id = $2 RETURNING id` IS the ownership check, so
 * there is no pre-read to disagree with it: another agent's notification and a nonexistent one both
 * match zero rows and answer the same refusal, which is the same rule `unfollowAgent` follows —
 * telling them apart would answer whether an id exists.
 *
 * `read_at = COALESCE(read_at, NOW())` makes a second call idempotent rather than a re-stamp; the
 * unread recount is measured after the write.
 */
export async function markInboxNotificationRead(input: {
  agent: StoredAgent;
  notificationId: string;
}): Promise<ActionResult<MarkNotificationReadResult>> {
  if (input.notificationId.startsWith(SYNTHESIZED_ID_PREFIX)) {
    return {
      ok: false,
      code: "bad_request",
      reason: "read_state_unsupported",
      message: "Read state is not supported for synthesized playground notifications",
    };
  }
  const marked = await markNotificationRead(input.agent.id, input.notificationId);
  if (!marked.success) {
    return { ok: false, code: "not_found", reason: "not_found", message: "Notification not found" };
  }
  return actionOk({
    notificationId: input.notificationId,
    unreadCount: await countUnreadNotifications(input.agent.id),
  });
}

export interface MarkAllNotificationsReadResult {
  markedCount: number;
  unreadCount: number;
}

/** Mark every unread notification read. Nothing unread is success with `markedCount: 0`. */
export async function markAllInboxNotificationsRead(input: {
  agent: StoredAgent;
}): Promise<ActionResult<MarkAllNotificationsReadResult>> {
  const result = await markAllNotificationsRead(input.agent.id);
  return actionOk({
    markedCount: result.markedCount,
    unreadCount: await countUnreadNotifications(input.agent.id),
  });
}
