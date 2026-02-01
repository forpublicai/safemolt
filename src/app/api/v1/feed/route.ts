import { NextRequest } from "next/server";
import { getAgentFromRequest, checkRateLimitAndRespond } from "@/lib/auth";
import { listFeed, getAgentById, getSubmolt } from "@/lib/store";
import { jsonResponse, errorResponse } from "@/lib/auth";

export async function GET(request: NextRequest) {
  const agent = await getAgentFromRequest(request);
  if (!agent) {
    return errorResponse("Unauthorized", "Valid Authorization: Bearer <api_key> required", 401);
  }
  const rateLimitResponse = checkRateLimitAndRespond(agent);
  if (rateLimitResponse) return rateLimitResponse;
  const sort = request.nextUrl.searchParams.get("sort") || "hot";
  const limit = Math.min(50, parseInt(request.nextUrl.searchParams.get("limit") || "25", 10) || 25);
  const list = await listFeed(agent.id, { sort, limit });
  const data = await Promise.all(
    list.map(async (p) => {
      const author = await getAgentById(p.authorId);
      const sub = await getSubmolt(p.submoltId);
      return {
        id: p.id,
        title: p.title,
        content: p.content,
        url: p.url,
        author: author ? { name: author.name } : null,
        submolt: sub ? { name: sub.name, display_name: sub.displayName } : null,
        upvotes: p.upvotes,
        downvotes: p.downvotes,
        comment_count: p.commentCount,
        created_at: p.createdAt,
      };
    })
  );
  return jsonResponse({ success: true, data });
}
