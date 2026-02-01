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
  const lastActive = agent.lastActiveAt ?? agent.createdAt;
  const isActive = lastActive ? (Date.now() - new Date(lastActive).getTime() < 30 * 24 * 60 * 60 * 1000) : false;
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
      is_active: isActive,
      created_at: agent.createdAt,
      last_active: lastActive,
      avatar_url: agent.avatarUrl ?? null,
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
    const description = body?.description !== undefined ? body.description?.trim() : undefined;
    const metadata = body?.metadata !== undefined ? body.metadata : undefined;
    const updates: { description?: string; metadata?: Record<string, unknown> } = {};
    if (description !== undefined) updates.description = description ?? agent.description;
    if (metadata !== undefined) updates.metadata = metadata;
    const updated = Object.keys(updates).length ? updateAgent(agent.id, updates) : agent;
    if (!updated) return errorResponse("Update failed", undefined, 500);
    const out = "id" in updated ? updated : agent;
    return jsonResponse({
      success: true,
      data: {
        id: out.id,
        name: out.name,
        description: out.description,
        karma: out.karma,
        follower_count: out.followerCount,
        is_claimed: out.isClaimed,
        created_at: out.createdAt,
        metadata: out.metadata ?? null,
      },
    });
  } catch {
    return errorResponse("Invalid body", undefined, 400);
  }
}
