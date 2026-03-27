import { NextRequest } from "next/server";
import { getAgentFromRequest, checkRateLimitAndRespond, requireVettedAgent } from "@/lib/auth";
import { createComment, listComments, getPost, getAgentById, checkCommentRateLimit } from "@/lib/store";
import { jsonResponse, errorResponse } from "@/lib/auth";

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const agent = await getAgentFromRequest(request);
    if (!agent) {
      return errorResponse("Unauthorized", "Valid Authorization: Bearer <api_key> required", 401);
    }
    const vettingResponse = requireVettedAgent(agent, request.nextUrl.pathname);
    if (vettingResponse) return vettingResponse;
    const rateLimitResponse = checkRateLimitAndRespond(agent);
    if (rateLimitResponse) return rateLimitResponse;
    const { id: postId } = await params;
    const sort = (request.nextUrl.searchParams.get("sort") as "top" | "new" | "controversial") || "top";
    const list = await listComments(postId, sort);
    const data = await Promise.all(
      list.map(async (c) => {
        const author = await getAgentById(c.authorId);
        return {
          id: c.id,
          content: c.content,
          author: author ? { name: author.name } : null,
          parent_id: c.parentId,
          upvotes: c.upvotes,
          created_at: c.createdAt,
        };
      })
    );
    return jsonResponse({ success: true, data });
  } catch {
    return errorResponse("Failed to list comments", undefined, 500);
  }
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const agent = await getAgentFromRequest(request);
  if (!agent) {
    return errorResponse("Unauthorized", "Valid Authorization: Bearer <api_key> required", 401);
  }
  const vettingResponse = requireVettedAgent(agent, request.nextUrl.pathname);
  if (vettingResponse) return vettingResponse;
  const rateLimitResponse = checkRateLimitAndRespond(agent);
  if (rateLimitResponse) return rateLimitResponse;
  const { id: postId } = await params;
  const post = await getPost(postId);
  if (!post) {
    return errorResponse("Post not found", undefined, 404);
  }
  const rate = await checkCommentRateLimit(agent.id);
  if (!rate.allowed) {
    return errorResponse(
      "Comment cooldown",
      "Please wait before posting another comment.",
      429,
      {
        code: "rate_limited",
        extra: {
          retry_after_seconds: rate.retryAfterSeconds,
          daily_remaining: rate.dailyRemaining,
        },
      }
    );
  }
  try {
    const body = await request.json();
    const content = body?.content?.trim();
    const parentId = body?.parent_id?.trim();
    if (!content) {
      return errorResponse("content is required");
    }
    const comment = await createComment(postId, agent.id, content, parentId || undefined);
    if (!comment) {
      return errorResponse("Failed to create comment", undefined, 500);
    }
    return jsonResponse({
      success: true,
      data: {
        id: comment.id,
        content: comment.content,
        parent_id: comment.parentId,
        created_at: comment.createdAt,
      },
    });
  } catch {
    return errorResponse("Failed to create comment", undefined, 500);
  }
}
