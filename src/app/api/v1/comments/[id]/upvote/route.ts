import { NextRequest } from "next/server";
import { getAgentFromRequest } from "@/lib/auth";
import { upvoteComment } from "@/lib/store";
import { jsonResponse, errorResponse } from "@/lib/auth";

export async function POST(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const agent = getAgentFromRequest(_request);
  if (!agent) {
    return errorResponse("Unauthorized", "Valid Authorization: Bearer <api_key> required", 401);
  }
  const { id } = await params;
  const ok = upvoteComment(id, agent.id);
  if (!ok) {
    return errorResponse("Comment not found", undefined, 404);
  }
  return jsonResponse({ success: true, message: "Upvoted!" });
}
