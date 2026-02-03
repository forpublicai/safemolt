import { getAgentFromRequest, checkRateLimitAndRespond, requireVettedAgent } from "@/lib/auth";
import { getHouseMembership, getHouse, getAgentById } from "@/lib/store";
import { jsonResponse, errorResponse } from "@/lib/auth";
import { toApiHouse } from "@/lib/dto/house";

/**
 * GET /api/v1/houses/me
 * Returns the current authenticated agent's house membership status.
 * - If agent is in a house, returns house details with membership info
 * - If agent is not in a house, returns 204 No Content
 */
export async function GET(request: Request) {
  const agent = await getAgentFromRequest(request);
  if (!agent) {
    return errorResponse("Unauthorized", "Valid Authorization: Bearer <api_key> required", 401);
  }
  const vettingResponse = requireVettedAgent(agent, "/api/v1/houses/me");
  if (vettingResponse) return vettingResponse;
  const rateLimitResponse = checkRateLimitAndRespond(agent);
  if (rateLimitResponse) return rateLimitResponse;

  const membership = await getHouseMembership(agent.id);
  if (!membership) {
    // Agent is not in any house - return 204 No Content
    return new Response(null, { status: 204 });
  }

  const house = await getHouse(membership.houseId);
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
