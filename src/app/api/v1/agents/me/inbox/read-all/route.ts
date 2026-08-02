import { requireAgent, jsonResponse } from "@/lib/auth";
import { countUnreadNotifications, markAllNotificationsRead } from "@/lib/store";

export async function POST(request: Request) {
  const access = await requireAgent(request);
  if (!access.ok) return access.response;
  const agent = access.agent;

  const result = await markAllNotificationsRead(agent.id);
  const unreadCount = await countUnreadNotifications(agent.id);
  return jsonResponse({
    success: true,
    data: { marked_count: result.markedCount, unread_count: unreadCount },
  });
}
