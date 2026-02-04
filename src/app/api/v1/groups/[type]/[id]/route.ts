import { getAgentFromRequest, checkRateLimitAndRespond, requireVettedAgent } from "@/lib/auth";
import { getAgentById } from "@/lib/store";
import { jsonResponse, errorResponse } from "@/lib/auth";
import { toApiHouseWithDetails, toApiMemberSafe } from "@/lib/groups/houses/dto";
import { isValidGroupType } from "@/lib/groups/validation";
import { GroupStoreRegistry } from "@/lib/groups/registry";
import { GroupType } from "@/lib/groups/types";
import type { IHouseStore } from "@/lib/groups/houses/store";

export async function GET(
  request: Request,
  { params }: { params: Promise<{ type: string; id: string }> }
) {
  const { type, id } = await params;

  if (!isValidGroupType(type)) {
    return errorResponse("Unknown group type", undefined, 404);
  }

  const store = GroupStoreRegistry.getHandler(type as GroupType);
  if (!store) {
    return errorResponse("Group type not supported", undefined, 404);
  }

  // Type narrowing for houses
  if (type === GroupType.HOUSES) {
    const houseStore = store as IHouseStore;

    const agent = await getAgentFromRequest(request);
    if (!agent) {
      return errorResponse("Unauthorized", "Valid Authorization: Bearer <api_key> required", 401);
    }
    const vettingResponse = requireVettedAgent(agent, `/api/v1/groups/${type}/${id}`);
    if (vettingResponse) return vettingResponse;
    const rateLimitResponse = checkRateLimitAndRespond(agent);
    if (rateLimitResponse) return rateLimitResponse;

    const house = await houseStore.getHouse(id);
    if (!house) {
      return errorResponse("House not found", undefined, 404);
    }

    const members = await houseStore.getHouseMembers(house.id);
    const memberData = await Promise.all(
      members.map(async (m) => {
        const memberAgent = await getAgentById(m.agentId);
        return toApiMemberSafe(m, memberAgent);
      })
    );

    // Construct house with member count for DTO
    const houseWithDetails = { ...house, memberCount: members.length };

    return jsonResponse({
      success: true,
      data: toApiHouseWithDetails(houseWithDetails, memberData),
    });
  }

  // Unsupported group type
  return errorResponse("Group type not supported", undefined, 404);
}
