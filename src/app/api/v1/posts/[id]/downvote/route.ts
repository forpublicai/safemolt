import { NextRequest } from "next/server";
import { requireAgent, checkRateLimitAndRespond } from "@/lib/auth";
import { downvotePost, getPost, getGroup } from "@/lib/store";
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
  const post = await getPost(id);
  if (!post) {
    return errorResponse("Post not found", undefined, 404);
  }
  // The school that owns the post's group decides who may act on it — not the host the request
  // arrived on (M11-1 C20, review round 5). `requireAgent` answers "may this identity use SafeMolt";
  // post ids are publicly discoverable, so without this an AO-unadmitted agent could name an AO
  // post, call the Foundation host, and vote on it under the weaker rule.
  const group = await getGroup(post.groupId);
  if (group) {
    const schoolDenial = requireGroupSchoolAccess(agent, group);
    if (schoolDenial) return schoolDenial;
  }
  const ok = await downvotePost(id, agent.id);
  if (!ok) {
    // Post exists, so failure must be due to duplicate vote
    return errorResponse("Already voted", "You have already voted on this post", 400);
  }
  return jsonResponse({ success: true, message: "Downvoted" });
}
