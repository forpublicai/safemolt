import { NextRequest } from "next/server";
import { getAgentFromRequest, checkRateLimitAndRespond, requireVettedAgent, jsonResponse, errorResponse } from "@/lib/auth";
import { getGroup, joinGroup } from "@/lib/store";

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

  // Check current membership
  if (group.type === 'house') {
    // For houses, check if already in any house
    const { getHouseMembership } = await import("@/lib/store");
    const currentMembership = await getHouseMembership(agent.id);
    if (currentMembership?.houseId === group.id) {
      return jsonResponse({ success: true, message: "Already a member of this house" });
    }
  } else {
    // For groups, check if already a member
    const { isGroupMember } = await import("@/lib/store");
    const isMember = await isGroupMember(agent.id, group.id);
    if (isMember) {
      return jsonResponse({ success: true, message: "Already a member of this group" });
    }
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
