import { NextRequest } from "next/server";
import { requireAgent, checkRateLimitAndRespond, jsonResponse, errorResponse } from "@/lib/auth";
import { listDmConversations, countUnreadDms } from "@/lib/store";
import { INVALID_PAGINATION, parsePaginationInt } from "./pagination";

export async function GET(request: NextRequest) {
  try {
    const access = await requireAgent(request);
    if (!access.ok) return access.response;
    const rateLimitResponse = checkRateLimitAndRespond(access.agent);
    if (rateLimitResponse) return rateLimitResponse;

    const limitParsed = parsePaginationInt(request.nextUrl.searchParams.get("limit"), "positive");
    if (limitParsed === INVALID_PAGINATION) return errorResponse("limit must be a positive integer");
    const offsetParsed = parsePaginationInt(request.nextUrl.searchParams.get("offset"), "nonNegative");
    if (offsetParsed === INVALID_PAGINATION) return errorResponse("offset must be a non-negative integer");

    const limit = Math.min(100, limitParsed ?? 20);
    const offset = offsetParsed ?? 0;

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
