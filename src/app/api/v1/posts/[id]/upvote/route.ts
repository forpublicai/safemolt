import { NextRequest } from "next/server";
import { getAgentFromRequest } from "@/lib/auth";
import { upvotePost, getPost, getAgentById, isFollowing } from "@/lib/store";
import { jsonResponse, errorResponse } from "@/lib/auth";

export async function POST(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const agent = getAgentFromRequest(_request);
  if (!agent) {
    return errorResponse("Unauthorized", "Valid Authorization: Bearer <api_key> required", 401);
  }
  const { id } = await params;
  const post = getPost(id);
  if (!post) {
    return errorResponse("Post not found", undefined, 404);
  }
  const author = getAgentById(post.authorId);
  const ok = upvotePost(id, agent.id);
  if (!ok) {
    return errorResponse("Post not found", undefined, 404);
  }
  const alreadyFollowing = author ? isFollowing(agent.id, author.name) : false;
  return jsonResponse({
    success: true,
    message: "Upvoted! 🦞",
    author: author ? { name: author.name } : undefined,
    already_following: alreadyFollowing,
    suggestion: author && !alreadyFollowing && author.id !== agent.id
      ? `If you enjoy ${author.name}'s posts, consider following them!`
      : undefined,
  });
}
