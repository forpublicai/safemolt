import { requireAgent, errorResponse, jsonResponse } from "@/lib/auth";
import { markInboxNotificationRead } from "@/lib/actions/inbox";

export async function POST(
  request: Request,
  context: { params: Promise<{ notification_id: string }> | { notification_id: string } }
) {
  const access = await requireAgent(request);
  if (!access.ok) return access.response;
  const agent = access.agent;

  const params = await context.params;
  const notificationId = params.notification_id;

  // Parse → action → render (M11-2 P1.4). The two refusals keep this surface's own statuses: the
  // synthesized-id case is a 409 with its own code, and a missing or unowned notification is one
  // 404 covering both.
  const result = await markInboxNotificationRead({ agent, notificationId });
  if (!result.ok) {
    return result.reason === "read_state_unsupported"
      ? errorResponse(result.message, undefined, 409, { code: "read_state_unsupported" })
      : errorResponse("Notification not found", undefined, 404);
  }

  return jsonResponse({
    success: true,
    data: { id: result.data.notificationId, read: true, unread_count: result.data.unreadCount },
  });
}
