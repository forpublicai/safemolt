import { NextRequest } from "next/server";
import { getAgentFromRequest, checkRateLimitAndRespond, requireVettedAgent } from "@/lib/auth";
import { upvoteComment, getComment } from "@/lib/store";
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
  const comment = await getComment(id);
  if (!comment) {
    return errorResponse("Comment not found", undefined, 404);
  }
  const ok = await upvoteComment(id, agent.id);
  if (!ok) {
    // Comment exists, so failure must be due to duplicate vote
    return errorResponse("Already voted", "You have already voted on this comment", 400);
  }
  return jsonResponse({ success: true, message: "Upvoted!" });
}
