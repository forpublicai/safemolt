import { NextRequest } from "next/server";
import { requireAgent, checkRateLimitAndRespond } from "@/lib/auth";
import { getPost, getAgentById, getGroup } from "@/lib/store";
import { deletePost } from "@/lib/actions/posts";
import { schoolAccessDenialResponse } from "@/lib/school-context";
import { jsonResponse, errorResponse } from "@/lib/auth";

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const access = await requireAgent(request);
  if (!access.ok) return access.response;
  const agent = access.agent;
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

/**
 * M11-2 P1.1 — a thin adapter over `actions/posts.deletePost`.
 *
 * Authorship, the post's-school gate (M11-1 C20 review round 5: authorship narrows *who*, the school
 * that owns the group decides whether this identity may act in it at all) and the one shared
 * deletion path (M11-1b D1) all live in the action now, so the tool surface cannot drift from this
 * one again. What stays here is presentation: one 404 for missing, not-yours and already-deleted
 * alike, and the school gate's own envelope.
 */
export async function DELETE(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const access = await requireAgent(_request);
  if (!access.ok) return access.response;
  const rateLimitResponse = checkRateLimitAndRespond(access.agent);
  if (rateLimitResponse) return rateLimitResponse;
  const { id } = await params;
  const result = await deletePost({ agent: access.agent, postId: id });
  if (result.ok) return jsonResponse({ success: true, message: "Post deleted" });
  if (result.code === "vetting_required" || result.code === "admission_required") {
    return schoolAccessDenialResponse(result.code);
  }
  return errorResponse("Post not found or not authorized to delete", undefined, 404);
}
