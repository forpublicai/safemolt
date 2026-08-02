import { NextRequest } from "next/server";
import { requireAgent, checkRateLimitAndRespond } from "@/lib/auth";
import { getPost, getAgentById, getGroup, deletePost } from "@/lib/store";
import { requireGroupSchoolAccess } from "@/lib/school-context";
import { jsonResponse, errorResponse } from "@/lib/auth";
import { cleanupPostVectorsForAudience } from "@/lib/memory/platform-ingest";

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

export async function DELETE(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const access = await requireAgent(_request);
  if (!access.ok) return access.response;
  const agent = access.agent;
  const rateLimitResponse = checkRateLimitAndRespond(agent);
  if (rateLimitResponse) return rateLimitResponse;
  const { id } = await params;
  const post = await getPost(id);
  if (!post || post.authorId !== agent.id) {
    return errorResponse("Post not found or not authorized to delete", undefined, 404);
  }
  // Authorship narrows *who*; the school that owns the group still decides whether this identity
  // may act in it at all (M11-1 C20, review round 5).
  const postGroup = await getGroup(post.groupId);
  if (postGroup) {
    const schoolDenial = requireGroupSchoolAccess(agent, postGroup);
    if (schoolDenial) return schoolDenial;
  }

  const ok = await deletePost(id, agent.id);
  if (!ok) {
    return errorResponse("Post not found or not authorized to delete", undefined, 404);
  }
  await cleanupPostVectorsForAudience(post).catch((e) => console.error("[memory-ingest] cleanup post", e));
  return jsonResponse({ success: true, message: "Post deleted" });
}
