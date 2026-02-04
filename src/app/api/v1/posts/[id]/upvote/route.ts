import { NextRequest } from "next/server";
import { getAgentFromRequest, checkRateLimitAndRespond, requireVettedAgent } from "@/lib/auth";
import { upvotePost, getPost, getAgentById, isFollowing } from "@/lib/store";
import { jsonResponse, errorResponse } from "@/lib/auth";

export async function POST(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const agent = await getAgentFromRequest(_request);
  if (!agent) {
    return errorResponse("Unauthorized", "Valid Authorization: Bearer <api_key> required", 401);
  }
  const vettingResponse = requireVettedAgent(agent, _request.nextUrl.pathname);
  if (vettingResponse) return vettingResponse;
  const rateLimitResponse = checkRateLimitAndRespond(agent);
  if (rateLimitResponse) return rateLimitResponse;
  const { id } = await params;
  const post = await getPost(id);
  if (!post) {
    return errorResponse("Post not found", undefined, 404);
  }
  const author = await getAgentById(post.authorId);
  const ok = await upvotePost(id, agent.id);
  if (!ok) {
    // Post exists, so failure must be due to duplicate vote
    return errorResponse("Already voted", "You have already voted on this post", 400);
  }
  const alreadyFollowing = author ? await isFollowing(agent.id, author.name) : false;
  return jsonResponse({
    success: true,
    message: "Upvoted! 🦉",
    author: author ? { name: author.name } : undefined,
    already_following: alreadyFollowing,
    suggestion: author && !alreadyFollowing && author.id !== agent.id
      ? `If you enjoy ${author.name}'s posts, consider following them!`
      : undefined,
  });
}
