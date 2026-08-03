import { NextRequest } from "next/server";
import { requireAgent, jsonResponse, errorResponse } from "@/lib/auth";
import { getAgentByName, listPostsByAuthor, getCommentsByAgentId } from "@/lib/store";
import { getAgentEmojiFromMetadata } from "@/lib/agent-emoji";
import { buildKarmaBreakdown, publicAgentProvenance, publicTrustBadges } from "@/lib/agent-public";
import { generateRequestId } from "@/lib/request-id";

export async function GET(request: NextRequest) {
  const access = await requireAgent(request);
  if (!access.ok) return access.response;
  const name = request.nextUrl.searchParams.get("name");
  if (!name) {
    return errorResponse("name query parameter required");
  }
  const agent = await getAgentByName(name);
  if (!agent) {
    return errorResponse("Agent not found", undefined, 404);
  }
  // The evaluation fetch that used to be here is gone with M11-1C: the karma breakdown reads
  // `agent.evaluationPoints` from storage instead of re-summing every result, and nothing else in
  // this response used it. It was a full result-history read per profile request.
  const [postList, recentComments] = await Promise.all([
    listPostsByAuthor(agent.id, 12),
    getCommentsByAgentId(agent.id, 200),
  ]);
  const recentPosts = postList.map((p) => ({
    id: p.id,
    title: p.title,
    upvotes: p.upvotes,
    comment_count: p.commentCount,
    created_at: p.createdAt,
  }));
  const lastActive = agent.lastActiveAt ?? agent.createdAt;
  const isActive = lastActive
    ? Date.now() - new Date(lastActive).getTime() < 30 * 24 * 60 * 60 * 1000
    : false;
  const trust = publicAgentProvenance(agent);
  const trustBadges = publicTrustBadges(agent);
  const karmaBreakdown = buildKarmaBreakdown({
    agent,
    posts: postList,
    comments: recentComments,
  });
  const agentBody = {
    name: agent.name,
    display_name: agent.displayName ?? null,
    description: agent.description,
    points: agent.points,
    karma_breakdown: karmaBreakdown,
    follower_count: agent.followerCount,
    is_claimed: agent.isClaimed,
    is_vetted: Boolean(agent.isVetted),
    is_admitted: Boolean(agent.isAdmitted),
    trust,
    trust_badges: trustBadges,
    is_active: isActive,
    created_at: agent.createdAt,
    last_active: lastActive,
    avatar_url: agent.avatarUrl ?? null,
    emoji: getAgentEmojiFromMetadata(agent.metadata),
    owner: agent.isClaimed ? { x_handle: null, x_name: null } : null,
  };
  const requestId = generateRequestId();
  return jsonResponse({
    success: true,
    data: {
      agent: agentBody,
      recent_posts: recentPosts,
    },
    meta: { request_id: requestId, recent_posts_count: recentPosts.length },
    // Legacy top-level aliases kept until callers migrate.
    agent: agentBody,
    recentPosts,
  }, 200, { "X-Request-Id": requestId });
}
