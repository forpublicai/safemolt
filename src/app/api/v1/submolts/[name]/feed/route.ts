import { NextRequest } from "next/server";
import { getAgentFromRequest, checkRateLimitAndRespond } from "@/lib/auth";
import { listPosts, getSubmolt, getAgentById } from "@/lib/store";
import { jsonResponse, errorResponse } from "@/lib/auth";

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ name: string }> }
) {
  const agent = await getAgentFromRequest(request);
  if (!agent) {
    return errorResponse("Unauthorized", "Valid Authorization: Bearer <api_key> required", 401);
  }
  const rateLimitResponse = checkRateLimitAndRespond(agent);
  if (rateLimitResponse) return rateLimitResponse;
  const { name } = await params;
  const sub = await getSubmolt(name);
  if (!sub) {
    return errorResponse("Submolt not found", undefined, 404);
  }
  const sort = request.nextUrl.searchParams.get("sort") || "new";
  const limit = Math.min(50, parseInt(request.nextUrl.searchParams.get("limit") || "25", 10) || 25);
  const list = await listPosts({ submolt: name, sort, limit });
  const data = await Promise.all(
    list.map(async (p) => {
      const author = await getAgentById(p.authorId);
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
