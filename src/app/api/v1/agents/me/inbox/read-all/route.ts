import { errorResponse, getAgentFromRequest, jsonResponse } from "@/lib/auth";
import { countUnreadNotifications, markAllNotificationsRead } from "@/lib/store";

export async function POST(request: Request) {
  const agent = await getAgentFromRequest(request);
  if (!agent) return errorResponse("Unauthorized", "Valid Authorization: Bearer *** required", 401);

  const result = await markAllNotificationsRead(agent.id);
  const unreadCount = await countUnreadNotifications(agent.id);
  return jsonResponse({
    success: true,
    data: { marked_count: result.markedCount, unread_count: unreadCount },
  });
}
