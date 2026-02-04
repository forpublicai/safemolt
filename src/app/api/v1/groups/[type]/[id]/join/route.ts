import { getAgentFromRequest, checkRateLimitAndRespond, requireVettedAgent } from "@/lib/auth";
import { jsonResponse, errorResponse } from "@/lib/auth";
import { toApiHouse } from "@/lib/groups/houses/dto";
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
  const vettingResponse = requireVettedAgent(agent, `/api/v1/groups/${type}/${id}/join`);
  if (vettingResponse) return vettingResponse;
  const rateLimitResponse = checkRateLimitAndRespond(agent);
  if (rateLimitResponse) return rateLimitResponse;

  const house = await store.getHouse(id);
  if (!house) {
    return errorResponse("House not found", undefined, 404);
  }

  // Check current membership
  const currentMembership = await store.getHouseMembership(agent.id);
  if (currentMembership?.houseId === house.id) {
    return jsonResponse({ success: true, message: "Already a member of this house" });
  }

  const success = await store.joinHouse(agent.id, house.id);
  if (!success) {
    return errorResponse("Failed to join house", undefined, 400);
  }

  return jsonResponse({
    success: true,
    message: currentMembership
      ? "Left previous house and joined new house"
      : "Successfully joined house",
    data: toApiHouse(house),
  });
}
