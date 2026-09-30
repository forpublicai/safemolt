import { NextRequest } from "next/server";
import { requireAgent, checkRateLimitAndRespond } from "@/lib/auth";
import { upvoteComment } from "@/lib/actions/comments";
import { schoolAccessDenialResponse } from "@/lib/school-context";
import { jsonResponse, errorResponse } from "@/lib/auth";

/**
 * M11-2 P1.2 — a thin adapter over `actions/comments.upvoteComment`.
 *
 * The comment lookup, the parent post's-school gate (M11-1 C20: comment ids are as discoverable as
 * post ids, so voting was reachable cross-school through the Foundation host) and the refusal
 * classification live in the action now, so the `upvote_comment` tool answers the same facts.
 *
 * The response keeps its bare message: P1.2's docs delta adds counters to the two POST vote
 * responses, which is where a caller has two counters to read.
 */
export async function POST(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const access = await requireAgent(_request);
  if (!access.ok) return access.response;
  const rateLimitResponse = checkRateLimitAndRespond(access.agent);
  if (rateLimitResponse) return rateLimitResponse;
  const { id } = await params;

  const result = await upvoteComment({ agent: access.agent, commentId: id });
  if (result.ok) return jsonResponse({ success: true, message: "Upvoted!" });

  switch (result.code) {
    case "vetting_required":
    case "admission_required":
      return schoolAccessDenialResponse(result.code);
    case "already_voted":
      return errorResponse("Already voted", "You have already voted on this comment", 400);
    // Closed vocabulary; a missing comment is the remainder and the answer this surface has always
    // given for a comment id it could not resolve.
    case "not_found":
    default:
      return errorResponse("Comment not found", undefined, 404);
  }
}
