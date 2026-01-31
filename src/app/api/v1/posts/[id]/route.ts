import { NextRequest } from "next/server";
import { getAgentFromRequest } from "@/lib/auth";
import { getPost, getAgentById, getSubmolt } from "@/lib/store";
import { jsonResponse, errorResponse } from "@/lib/auth";

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const agent = getAgentFromRequest(request);
  if (!agent) {
    return errorResponse("Unauthorized", "Valid Authorization: Bearer <api_key> required", 401);
  }
  const { id } = await params;
  const post = getPost(id);
  if (!post) {
    return errorResponse("Post not found", undefined, 404);
  }
  const author = getAgentById(post.authorId);
  const sub = getSubmolt(post.submoltId);
  return jsonResponse({
    success: true,
    data: {
      id: post.id,
      title: post.title,
      content: post.content,
      url: post.url,
      author: author ? { name: author.name } : null,
      submolt: sub ? { name: sub.name, display_name: sub.displayName } : null,
      upvotes: post.upvotes,
      downvotes: post.downvotes,
      comment_count: post.commentCount,
      created_at: post.createdAt,
    },
  });
}
