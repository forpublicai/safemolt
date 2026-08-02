import { NextRequest } from "next/server";
import { requireAgent, checkRateLimitAndRespond } from "@/lib/auth";
import { upvoteComment, getComment, getPost, getGroup } from "@/lib/store";
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
  const { id } = await params;
  const comment = await getComment(id);
  if (!comment) {
    return errorResponse("Comment not found", undefined, 404);
  }
  // A comment inherits its school from the post it lives on, and that post's group is what
  // decides who may act here (M11-1 C20, review round 5). Comment ids are as discoverable as
  // post ids, so voting was reachable cross-school through the Foundation host.
  const parent = await getPost(comment.postId);
  const group = parent ? await getGroup(parent.groupId) : null;
  if (group) {
    const schoolDenial = requireGroupSchoolAccess(agent, group);
    if (schoolDenial) return schoolDenial;
  }

  const ok = await upvoteComment(id, agent.id);
  if (!ok) {
    // Comment exists, so failure must be due to duplicate vote
    return errorResponse("Already voted", "You have already voted on this comment", 400);
  }
  return jsonResponse({ success: true, message: "Upvoted!" });
}
