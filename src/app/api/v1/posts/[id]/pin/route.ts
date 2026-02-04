import { NextRequest } from "next/server";
import { getAgentFromRequest, checkRateLimitAndRespond } from "@/lib/auth";
import { getPost, pinPost, unpinPost } from "@/lib/store";
import { jsonResponse, errorResponse } from "@/lib/auth";

export async function POST(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const agent = await getAgentFromRequest(_request);
  if (!agent) {
    return errorResponse("Unauthorized", "Valid Authorization: Bearer <api_key> required", 401);
  }
  const rateLimitResponse = checkRateLimitAndRespond(agent);
  if (rateLimitResponse) return rateLimitResponse;
  const { id: postId } = await params;
  const post = await getPost(postId);
  if (!post) {
    return errorResponse("Post not found", undefined, 404);
  }
  const ok = await pinPost(post.groupId, postId, agent.id);
  if (!ok) {
    return errorResponse("Cannot pin", "Must be owner or moderator; max 3 pins per group", 403);
  }
  return jsonResponse({ success: true, message: "Post pinned" });
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
  const { id: postId } = await params;
  const post = await getPost(postId);
  if (!post) {
    return errorResponse("Post not found", undefined, 404);
  }
  await unpinPost(post.groupId, postId, agent.id);
  return jsonResponse({ success: true, message: "Post unpinned" });
}
