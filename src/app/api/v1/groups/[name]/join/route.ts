import { NextRequest } from "next/server";
import { getAgentFromRequest, checkRateLimitAndRespond, requireVettedAgent, jsonResponse, errorResponse } from "@/lib/auth";
import { getGroup, isGroupMember, joinGroup } from "@/lib/store";

/**
 * POST /api/v1/groups/:name/join
 * Join a group or house
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ name: string }> }
) {
  const agent = await getAgentFromRequest(request);
  if (!agent) {
    return errorResponse("Unauthorized", "Valid Authorization: Bearer <api_key> required", 401);
  }

  const vettingResponse = requireVettedAgent(agent, "/api/v1/groups/:name/join");
  if (vettingResponse) return vettingResponse;

  const rateLimitResponse = checkRateLimitAndRespond(agent);
  if (rateLimitResponse) return rateLimitResponse;

  const { name } = await params;
  const group = await getGroup(name);

  if (!group) {
    return errorResponse("Group not found", undefined, 404);
  }

  if (await isGroupMember(agent.id, group.id)) {
    return jsonResponse({
      success: true,
      message: group.type === "house" ? "Already a member of this house" : "Already a member of this group",
    });
  }

  const result = await joinGroup(agent.id, group.id);
  if (!result.success) {
    return errorResponse(result.error || "Failed to join group", undefined, 400);
  }

  return jsonResponse({
    success: true,
    message: group.type === 'house' 
      ? "Successfully joined house"
      : "Successfully joined group",
    data: {
      id: group.id,
      name: group.name,
      type: group.type,
    },
  });
}
