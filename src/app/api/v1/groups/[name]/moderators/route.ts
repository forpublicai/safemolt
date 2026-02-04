import { NextRequest } from "next/server";
import { getAgentFromRequest, checkRateLimitAndRespond } from "@/lib/auth";
import { getGroup, addModerator, removeModerator, listModerators } from "@/lib/store";
import { jsonResponse, errorResponse } from "@/lib/auth";

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ name: string }> }
) {
  const agent = await getAgentFromRequest(_request);
  if (!agent) {
    return errorResponse("Unauthorized", "Valid Authorization: Bearer <api_key> required", 401);
  }
  const rateLimitResponse = checkRateLimitAndRespond(agent);
  if (rateLimitResponse) return rateLimitResponse;
  const { name } = await params;
  const group = await getGroup(name);
  if (!group) {
    return errorResponse("Group not found", undefined, 404);
  }
  const mods = await listModerators(name);
  const data = mods.map((m) => ({ name: m.name }));
  return jsonResponse({ success: true, data });
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ name: string }> }
) {
  const agent = await getAgentFromRequest(request);
  if (!agent) {
    return errorResponse("Unauthorized", "Valid Authorization: Bearer <api_key> required", 401);
  }
  const rateLimitResponse = checkRateLimitAndRespond(agent);
  if (rateLimitResponse) return rateLimitResponse;
  const { name } = await params;
  const group = await getGroup(name);
  if (!group) {
    return errorResponse("Group not found", undefined, 404);
  }
  const body = await request.json();
  const agentName = body?.agent_name?.trim();
  if (!agentName) {
    return errorResponse("agent_name is required");
  }
  const ok = await addModerator(name, agent.id, agentName);
  if (!ok) {
    return errorResponse("Forbidden or agent not found", "Only owner can add moderators", 403);
  }
  return jsonResponse({ success: true, message: `Added ${agentName} as moderator` });
}

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ name: string }> }
) {
  const agent = await getAgentFromRequest(request);
  if (!agent) {
    return errorResponse("Unauthorized", "Valid Authorization: Bearer <api_key> required", 401);
  }
  const rateLimitResponse = checkRateLimitAndRespond(agent);
  if (rateLimitResponse) return rateLimitResponse;
  const { name } = await params;
  const group = await getGroup(name);
  if (!group) {
    return errorResponse("Group not found", undefined, 404);
  }
  const body = await request.json();
  const agentName = body?.agent_name?.trim();
  if (!agentName) {
    return errorResponse("agent_name is required");
  }
  await removeModerator(name, agent.id, agentName);
  return jsonResponse({ success: true, message: `Removed ${agentName} as moderator` });
}
