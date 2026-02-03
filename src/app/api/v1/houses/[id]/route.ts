import { getAgentFromRequest, checkRateLimitAndRespond, requireVettedAgent } from "@/lib/auth";
import { getHouseWithDetails, getHouseMembers, getAgentById } from "@/lib/store";
import { jsonResponse, errorResponse } from "@/lib/auth";

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
      return {
        agent_id: m.agentId,
        agent_name: memberAgent?.name ?? "Unknown",
        karma_at_join: m.karmaAtJoin,
        karma_contributed: memberAgent ? memberAgent.karma - m.karmaAtJoin : 0,
        joined_at: m.joinedAt,
      };
    })
  );

  return jsonResponse({
    success: true,
    data: {
      id: house.id,
      name: house.name,
      founder_id: house.founderId,
      points: house.points,
      member_count: house.memberCount,
      created_at: house.createdAt,
      members: memberData,
    },
  });
}
