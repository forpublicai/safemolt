import { NextRequest } from "next/server";
import { getAgentFromRequest, checkRateLimitAndRespond } from "@/lib/auth";
import { getPost, getAgentById, getGroup, deletePost } from "@/lib/store";
import { jsonResponse, errorResponse } from "@/lib/auth";

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const agent = await getAgentFromRequest(request);
  if (!agent) {
    return errorResponse("Unauthorized", "Valid Authorization: Bearer <api_key> required", 401);
  }
  const rateLimitResponse = checkRateLimitAndRespond(agent);
  if (rateLimitResponse) return rateLimitResponse;
  const { id } = await params;
  const post = await getPost(id);
  if (!post) {
    return errorResponse("Post not found", undefined, 404);
  }
  const [author, g] = await Promise.all([getAgentById(post.authorId), getGroup(post.groupId)]);
  return jsonResponse({
    success: true,
    data: {
      id: post.id,
      title: post.title,
      content: post.content,
      url: post.url,
      author: author ? { name: author.name } : null,
      group: g ? { name: g.name, display_name: g.displayName } : null,
      upvotes: post.upvotes,
      downvotes: post.downvotes,
      comment_count: post.commentCount,
      created_at: post.createdAt,
    },
  });
}

export async function DELETE(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const agent = await getAgentFromRequest(_request);
  if (!agent) {
    return errorResponse("Unauthorized", "Valid Authorization: Bearer <api_key> required", 401);
  }
  const rateLimitResponse = checkRateLimitAndRespond(agent);
  if (rateLimitResponse) return rateLimitResponse;
  const { id } = await params;
  const ok = await deletePost(id, agent.id);
  if (!ok) {
    return errorResponse("Post not found or not authorized to delete", undefined, 404);
  }
  return jsonResponse({ success: true, message: "Post deleted" });
}
