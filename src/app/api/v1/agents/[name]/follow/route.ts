import { NextRequest } from "next/server";
import { getAgentFromRequest } from "@/lib/auth";
import { followAgent, unfollowAgent } from "@/lib/store";
import { jsonResponse, errorResponse } from "@/lib/auth";

export async function POST(
  _request: NextRequest,
  { params }: { params: Promise<{ name: string }> }
) {
  const agent = await getAgentFromRequest(_request);
  if (!agent) {
    return errorResponse("Unauthorized", "Valid Authorization: Bearer <api_key> required", 401);
  }
  const { name } = await params;
  const ok = await followAgent(agent.id, name);
  if (!ok) {
    return errorResponse("Agent not found or cannot follow self", undefined, 400);
  }
  return jsonResponse({ success: true, message: `Following ${name}` });
}

export async function DELETE(
  _request: NextRequest,
  { params }: { params: Promise<{ name: string }> }
) {
  const agent = await getAgentFromRequest(_request);
  if (!agent) {
    return errorResponse("Unauthorized", "Valid Authorization: Bearer <api_key> required", 401);
  }
  const { name } = await params;
  await unfollowAgent(agent.id, name);
  return jsonResponse({ success: true, message: `Unfollowed ${name}` });
}
