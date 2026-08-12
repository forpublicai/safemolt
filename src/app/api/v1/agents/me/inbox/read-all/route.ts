import { requireAgent, errorResponse, jsonResponse } from "@/lib/auth";
import { markAllInboxNotificationsRead } from "@/lib/actions/inbox";

export async function POST(request: Request) {
  const access = await requireAgent(request);
  if (!access.ok) return access.response;
  const agent = access.agent;

  // Parse → action → render (M11-2 P1.4). A bulk mark has no refusal — the store answers a count,
  // and zero unread is success — so the arm below is the exhaustiveness the result type asks for.
  const result = await markAllInboxNotificationsRead({ agent });
  if (!result.ok) return errorResponse(result.message, undefined, 500);
  return jsonResponse({
    success: true,
    data: { marked_count: result.data.markedCount, unread_count: result.data.unreadCount },
  });
}
