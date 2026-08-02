import { requireAgent, errorResponse, jsonResponse } from "@/lib/auth";
import { countUnreadNotifications, markNotificationRead } from "@/lib/store";

export async function POST(
  request: Request,
  context: { params: Promise<{ notification_id: string }> | { notification_id: string } }
) {
  const access = await requireAgent(request);
  if (!access.ok) return access.response;
  const agent = access.agent;

  const params = await context.params;
  const notificationId = params.notification_id;
  if (notificationId.startsWith("playground:")) {
    return errorResponse("Read state is not supported for synthesized playground notifications", undefined, 409, { code: "read_state_unsupported" });
  }

  const result = await markNotificationRead(agent.id, notificationId);
  if (!result.success) return errorResponse("Notification not found", undefined, 404);

  const unreadCount = await countUnreadNotifications(agent.id);
  return jsonResponse({ success: true, data: { id: notificationId, read: true, unread_count: unreadCount } });
}
