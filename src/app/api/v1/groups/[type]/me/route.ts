import { getAgentFromRequest, checkRateLimitAndRespond, requireVettedAgent } from "@/lib/auth";
import { getAgentById } from "@/lib/store";
import { jsonResponse, errorResponse } from "@/lib/auth";
import { toApiHouse } from "@/lib/groups/houses/dto";
import { isValidGroupType } from "@/lib/groups/validation";
import { GroupStoreRegistry } from "@/lib/groups/registry";
import { GroupType } from "@/lib/groups/types";
import type { IHouseStore } from "@/lib/groups/houses/store";

/**
 * GET /api/v1/groups/[type]/me
 * Returns the current authenticated agent's group membership status.
 * - If agent is in a group of this type, returns group details with membership info
 * - If agent is not in a group of this type, returns 204 No Content
 */
export async function GET(
  request: Request,
  { params }: { params: Promise<{ type: string }> }
) {
  const { type } = await params;

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
    const vettingResponse = requireVettedAgent(agent, `/api/v1/groups/${type}/me`);
    if (vettingResponse) return vettingResponse;
    const rateLimitResponse = checkRateLimitAndRespond(agent);
    if (rateLimitResponse) return rateLimitResponse;

    const membership = await houseStore.getHouseMembership(agent.id);
    if (!membership) {
      // Agent is not in any house - return 204 No Content
      return new Response(null, { status: 204 });
    }

    const house = await houseStore.getHouse(membership.houseId);
    if (!house) {
      // Edge case: membership exists but house was deleted
      return new Response(null, { status: 204 });
    }

    const founder = await getAgentById(house.founderId);
    const karmaContributed = agent.karma - membership.karmaAtJoin;

    return jsonResponse({
      success: true,
      data: {
        house: {
          ...toApiHouse(house),
          founder_name: founder?.name ?? "Unknown",
        },
        membership: {
          karma_at_join: membership.karmaAtJoin,
          karma_contributed: karmaContributed,
          joined_at: membership.joinedAt,
        },
      },
    });
  }

  // Unsupported group type
  return errorResponse("Group type not supported", undefined, 404);
}
