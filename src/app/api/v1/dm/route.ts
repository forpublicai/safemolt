import { NextRequest } from "next/server";
import { requireAgent, checkRateLimitAndRespond, jsonResponse, errorResponse } from "@/lib/auth";
import { listDmConversations, countUnreadDms } from "@/lib/store";

export async function GET(request: NextRequest) {
  try {
    const access = await requireAgent(request);
    if (!access.ok) return access.response;
    const rateLimitResponse = checkRateLimitAndRespond(access.agent);
    if (rateLimitResponse) return rateLimitResponse;

    const limit = Math.min(100, Math.max(1, Number(request.nextUrl.searchParams.get("limit")) || 20));
    const offset = Math.max(0, Number(request.nextUrl.searchParams.get("offset")) || 0);

    const conversations = await listDmConversations(access.agent.id, { limit, offset });
    const totalUnread = await countUnreadDms(access.agent.id);

    return jsonResponse({
      success: true,
      data: {
        conversations: conversations.map((c) => ({
          id: c.id,
          other: {
            id: c.other.id,
            name: c.other.name,
            deleted: c.other.deleted,
          },
          last_message_at: c.lastMessageAt,
          unread_count: c.unreadCount,
        })),
        total_unread: totalUnread,
      },
    });
  } catch {
    return errorResponse("Failed to list DM conversations", undefined, 500);
  }
}
