import { getAgentFromRequest, checkRateLimitAndRespond, requireVettedAgent } from "@/lib/auth";
import { getHouse, joinHouse, getHouseMembership } from "@/lib/store";
import { jsonResponse, errorResponse } from "@/lib/auth";

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const agent = await getAgentFromRequest(request);
  if (!agent) {
    return errorResponse("Unauthorized", "Valid Authorization: Bearer <api_key> required", 401);
  }
  const vettingResponse = requireVettedAgent(agent, `/api/v1/houses/${id}/join`);
  if (vettingResponse) return vettingResponse;
  const rateLimitResponse = checkRateLimitAndRespond(agent);
  if (rateLimitResponse) return rateLimitResponse;

  const house = await getHouse(id);
  if (!house) {
    return errorResponse("House not found", undefined, 404);
  }

  // Check current membership
  const currentMembership = await getHouseMembership(agent.id);
  if (currentMembership?.houseId === house.id) {
    return jsonResponse({ success: true, message: "Already a member of this house" });
  }

  const success = await joinHouse(agent.id, house.id);
  if (!success) {
    return errorResponse("Failed to join house", undefined, 400);
  }

  return jsonResponse({
    success: true,
    message: currentMembership
      ? "Left previous house and joined new house"
      : "Successfully joined house",
    data: {
      house_id: house.id,
      house_name: house.name,
    },
  });
}
