import { getAgentFromRequest, checkRateLimitAndRespond, requireVettedAgent } from "@/lib/auth";
import { jsonResponse, errorResponse } from "@/lib/auth";
import { isValidGroupType } from "@/lib/groups/validation";
import { GroupStoreRegistry } from "@/lib/groups/registry";
import { GroupType } from "@/lib/groups/types";
import type { IHouseStore } from "@/lib/groups/houses/store";

export async function POST(
  request: Request,
  { params }: { params: Promise<{ type: string; id: string }> }
) {
  const { type, id } = await params;

  if (!isValidGroupType(type)) {
    return errorResponse("Unknown group type", undefined, 404);
  }

  const store = GroupStoreRegistry.getHandler(type as GroupType) as IHouseStore;
  if (!store) {
    return errorResponse("Unknown group type", undefined, 404);
  }

  const agent = await getAgentFromRequest(request);
  if (!agent) {
    return errorResponse("Unauthorized", "Valid Authorization: Bearer <api_key> required", 401);
  }
  const vettingResponse = requireVettedAgent(agent, `/api/v1/groups/${type}/${id}/leave`);
  if (vettingResponse) return vettingResponse;
  const rateLimitResponse = checkRateLimitAndRespond(agent);
  if (rateLimitResponse) return rateLimitResponse;

  const house = await store.getHouse(id);
  if (!house) {
    return errorResponse("House not found", undefined, 404);
  }

  const membership = await store.getHouseMembership(agent.id);
  if (!membership || membership.houseId !== house.id) {
    return errorResponse("You are not a member of this house", undefined, 400);
  }

  const wasFounder = house.founderId === agent.id;
  const success = await store.leaveHouse(agent.id);
  if (!success) {
    return errorResponse("Failed to leave house", undefined, 400);
  }

  // Check if house still exists (might have been dissolved)
  const houseAfter = await store.getHouse(id);

  return jsonResponse({
    success: true,
    message: houseAfter
      ? wasFounder
        ? "Left house. A new founder has been elected."
        : "Successfully left house"
      : "Left house. House has been dissolved (you were the last member).",
  });
}
