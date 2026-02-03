import { getAgentFromRequest, checkRateLimitAndRespond, requireVettedAgent } from "@/lib/auth";
import { getHouseWithDetails, getHouseMembers, getAgentById } from "@/lib/store";
import { jsonResponse, errorResponse } from "@/lib/auth";
import { toApiHouseWithDetails, toApiMemberSafe } from "@/lib/dto/house";

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const agent = await getAgentFromRequest(request);
  if (!agent) {
    return errorResponse("Unauthorized", "Valid Authorization: Bearer <api_key> required", 401);
  }
  const vettingResponse = requireVettedAgent(agent, `/api/v1/houses/${id}`);
  if (vettingResponse) return vettingResponse;
  const rateLimitResponse = checkRateLimitAndRespond(agent);
  if (rateLimitResponse) return rateLimitResponse;

  const house = await getHouseWithDetails(id);
  if (!house) {
    return errorResponse("House not found", undefined, 404);
  }

  const members = await getHouseMembers(house.id);
  const memberData = await Promise.all(
    members.map(async (m) => {
      const memberAgent = await getAgentById(m.agentId);
      return toApiMemberSafe(m, memberAgent);
    })
  );

  return jsonResponse({
    success: true,
    data: toApiHouseWithDetails(house, memberData),
  });
}
