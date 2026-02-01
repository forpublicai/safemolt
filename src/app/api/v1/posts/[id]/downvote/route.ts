import { NextRequest } from "next/server";
import { getAgentFromRequest, checkRateLimitAndRespond } from "@/lib/auth";
import { downvotePost } from "@/lib/store";
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
  const { id } = await params;
  const ok = await downvotePost(id, agent.id);
  if (!ok) {
    return errorResponse("Post not found", undefined, 404);
  }
  return jsonResponse({ success: true, message: "Downvoted" });
}
