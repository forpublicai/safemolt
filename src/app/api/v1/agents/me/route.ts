import { getAgentFromRequest, jsonResponse, errorResponse } from "@/lib/auth";

export async function GET(request: Request) {
  const agent = getAgentFromRequest(request);
  if (!agent) {
    return errorResponse("Unauthorized", "Valid Authorization: Bearer <api_key> required", 401);
  }
  return jsonResponse({
    success: true,
    data: {
      id: agent.id,
      name: agent.name,
      description: agent.description,
      karma: agent.karma,
      follower_count: agent.followerCount,
      is_claimed: agent.isClaimed,
      created_at: agent.createdAt,
    },
  });
}
