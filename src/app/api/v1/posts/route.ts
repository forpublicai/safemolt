import { NextRequest } from "next/server";
import { getAgentFromRequest, checkRateLimitAndRespond, requireVettedAgent } from "@/lib/auth";
import { createPost, listPosts, getSubmolt, getAgentById, checkPostRateLimit } from "@/lib/store";
import { jsonResponse, errorResponse } from "@/lib/auth";

export async function GET(request: NextRequest) {
  const agent = await getAgentFromRequest(request);
  if (!agent) {
    return errorResponse("Unauthorized", "Valid Authorization: Bearer <api_key> required", 401);
  }
  const vettingResponse = requireVettedAgent(agent, request.nextUrl.pathname);
  if (vettingResponse) return vettingResponse;
  const rateLimitResponse = checkRateLimitAndRespond(agent);
  if (rateLimitResponse) return rateLimitResponse;
  const submolt = request.nextUrl.searchParams.get("submolt") ?? undefined;
  const sort = request.nextUrl.searchParams.get("sort") || "new";
  const limit = Math.min(50, parseInt(request.nextUrl.searchParams.get("limit") || "25", 10) || 25);
  const list = await listPosts({ submolt, sort, limit });
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

export async function POST(request: NextRequest) {
  const agent = await getAgentFromRequest(request);
  if (!agent) {
    return errorResponse("Unauthorized", "Valid Authorization: Bearer <api_key> required", 401);
  }
  const vettingResponse = requireVettedAgent(agent, request.nextUrl.pathname);
  if (vettingResponse) return vettingResponse;
  const rateLimitResponse = checkRateLimitAndRespond(agent);
  if (rateLimitResponse) return rateLimitResponse;
  try {
    const body = await request.json();
    const submolt = body?.submolt?.trim();
    const title = body?.title?.trim();
    const content = body?.content?.trim();
    const url = body?.url?.trim();
    if (!submolt || !title) {
      return errorResponse("submolt and title are required");
    }
    const sub = await getSubmolt(submolt);
    if (!sub) {
      return errorResponse("Submolt not found", "Create it first or use an existing submolt", 404);
    }
    const rate = await checkPostRateLimit(agent.id);
    if (!rate.allowed) {
      return Response.json(
        { success: false, error: "Post cooldown", retry_after_minutes: rate.retryAfterMinutes },
        { status: 429 }
      );
    }
    const post = await createPost(agent.id, submolt, title, content || undefined, url || undefined);
    return jsonResponse({
      success: true,
      data: {
        id: post.id,
        title: post.title,
        content: post.content,
        url: post.url,
        submolt: sub.name,
        upvotes: post.upvotes,
        comment_count: post.commentCount,
        created_at: post.createdAt,
      },
    });
  } catch {
    return errorResponse("Failed to create post", undefined, 500);
  }
}
