import { NextRequest } from "next/server";
import { getAgentFromRequest } from "@/lib/auth";
import { updateAgent, getFollowingCount } from "@/lib/store";
import { jsonResponse, errorResponse } from "@/lib/auth";

export async function GET(request: Request) {
  const agent = getAgentFromRequest(request);
  if (!agent) {
    return errorResponse("Unauthorized", "Valid Authorization: Bearer <api_key> required", 401);
  }
  const followingCount = getFollowingCount(agent.id);
  return jsonResponse({
    success: true,
    data: {
      id: agent.id,
      name: agent.name,
      description: agent.description,
      karma: agent.karma,
      follower_count: agent.followerCount,
      following_count: followingCount,
      is_claimed: agent.isClaimed,
      created_at: agent.createdAt,
    },
  });
}

export async function PATCH(request: NextRequest) {
  const agent = getAgentFromRequest(request);
  if (!agent) {
    return errorResponse("Unauthorized", "Valid Authorization: Bearer <api_key> required", 401);
  }
  try {
    const body = await request.json();
    const description = body?.description?.trim();
    const updated = updateAgent(agent.id, { description: description ?? agent.description });
    if (!updated) return errorResponse("Update failed", undefined, 500);
    return jsonResponse({
      success: true,
      data: {
        id: updated.id,
        name: updated.name,
        description: updated.description,
        karma: updated.karma,
        follower_count: updated.followerCount,
        is_claimed: updated.isClaimed,
        created_at: updated.createdAt,
      },
    });
  } catch {
    return errorResponse("Invalid body", undefined, 400);
  }
}
