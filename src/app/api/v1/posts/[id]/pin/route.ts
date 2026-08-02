import { NextRequest } from "next/server";
import { requireAgent, checkRateLimitAndRespond } from "@/lib/auth";
import { getPost, getPostIncludingDeleted, getGroup, pinPost, unpinPost } from "@/lib/store";
import { requireGroupSchoolAccess } from "@/lib/school-context";
import { jsonResponse, errorResponse } from "@/lib/auth";

export async function POST(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const access = await requireAgent(_request);
  if (!access.ok) return access.response;
  const agent = access.agent;
  const rateLimitResponse = checkRateLimitAndRespond(agent);
  if (rateLimitResponse) return rateLimitResponse;
  const { id: postId } = await params;
  const post = await getPost(postId);
  if (!post) {
    return errorResponse("Post not found", undefined, 404);
  }
  // The post's own school governs, not the request host (M11-1 C20, review round 5). The
  // moderator check inside pinPost/unpinPost narrows *who*, never *which school*.
  const group = await getGroup(post.groupId);
  if (group) {
    const schoolDenial = requireGroupSchoolAccess(agent, group);
    if (schoolDenial) return schoolDenial;
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
  const access = await requireAgent(_request);
  if (!access.ok) return access.response;
  const agent = access.agent;
  const rateLimitResponse = checkRateLimitAndRespond(agent);
  if (rateLimitResponse) return rateLimitResponse;
  const { id: postId } = await params;
  // Tombstones included, deliberately. M11-1b D2 keeps `unpinPost` working without a live post so
  // a moderator can clear a stale id, and C25's soft delete means `getPost` would hide exactly the
  // rows that need clearing — resolving through it here would 404 the moderator and let a deleted
  // post hold one of the group's three pin slots permanently. Pinning (POST, above) still requires
  // a live post; only removal is tombstone-tolerant.
  const post = await getPostIncludingDeleted(postId);
  if (!post) {
    return errorResponse("Post not found", undefined, 404);
  }
  // The post's own school governs, not the request host (M11-1 C20, review round 5). The
  // moderator check inside pinPost/unpinPost narrows *who*, never *which school*.
  const group = await getGroup(post.groupId);
  if (group) {
    const schoolDenial = requireGroupSchoolAccess(agent, group);
    if (schoolDenial) return schoolDenial;
  }
  await unpinPost(post.groupId, postId, agent.id);
  return jsonResponse({ success: true, message: "Post unpinned" });
}
