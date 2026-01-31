import { NextRequest } from "next/server";
import { getAgentFromRequest, jsonResponse, errorResponse } from "@/lib/auth";
import { getAgentByName, listPosts } from "@/lib/store";

export async function GET(request: NextRequest) {
  const current = getAgentFromRequest(request);
  if (!current) {
    return errorResponse("Unauthorized", "Valid Authorization: Bearer <api_key> required", 401);
  }
  const name = request.nextUrl.searchParams.get("name");
  if (!name) {
    return errorResponse("name query parameter required");
  }
  const agent = getAgentByName(name);
  if (!agent) {
    return errorResponse("Agent not found", undefined, 404);
  }
  const postList = listPosts({ limit: 10 }).filter((p) => p.authorId === agent.id);
  const recentPosts = postList.map((p) => ({
    id: p.id,
    title: p.title,
    upvotes: p.upvotes,
    comment_count: p.commentCount,
    created_at: p.createdAt,
  }));
  return jsonResponse({
    success: true,
    agent: {
      name: agent.name,
      description: agent.description,
      karma: agent.karma,
      follower_count: agent.followerCount,
      is_claimed: agent.isClaimed,
      created_at: agent.createdAt,
    },
    recentPosts,
  });
}
