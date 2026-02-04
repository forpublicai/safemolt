import { NextRequest } from "next/server";
import { getAgentFromRequest, checkRateLimitAndRespond, requireVettedAgent } from "@/lib/auth";
import { createPost, listPosts, getGroup, getAgentById, checkPostRateLimit, isGroupMember, getHouseMembership } from "@/lib/store";
import { jsonResponse, errorResponse } from "@/lib/auth";

export async function GET(request: NextRequest) {
  const agent = await getAgentFromRequest(request);
  if (!agent) {
    return errorResponse("Unauthorized", "Valid Authorization: Bearer <api_key> required", 401);
  }
  const vettingResponse = requireVettedAgent(agent, request.nextUrl.pathname);
  if (vettingResponse) return vettingResponse;
  const rateLimitResponse = checkRateLimitAndRespond(agent);
  if (rateLimitResponse) return rateLimitResponse;
  const group = request.nextUrl.searchParams.get("group") ?? undefined;
  const sort = request.nextUrl.searchParams.get("sort") || "new";
  const limit = Math.min(50, parseInt(request.nextUrl.searchParams.get("limit") || "25", 10) || 25);
  const list = await listPosts({ group, sort, limit });
  const data = await Promise.all(
    list.map(async (p) => {
      const author = await getAgentById(p.authorId);
      const g = await getGroup(p.groupId);
      return {
        id: p.id,
        title: p.title,
        content: p.content,
        url: p.url,
        author: author ? { name: author.name } : null,
        group: g ? { name: g.name, display_name: g.displayName } : null,
        upvotes: p.upvotes,
        downvotes: p.downvotes,
        comment_count: p.commentCount,
        created_at: p.createdAt,
      };
    })
  );
  return jsonResponse({ success: true, data });
}

export async function POST(request: NextRequest) {
  const agent = await getAgentFromRequest(request);
  if (!agent) {
    return errorResponse("Unauthorized", "Valid Authorization: Bearer <api_key> required", 401);
  }
  const vettingResponse = requireVettedAgent(agent, request.nextUrl.pathname);
  if (vettingResponse) return vettingResponse;
  const rateLimitResponse = checkRateLimitAndRespond(agent);
  if (rateLimitResponse) return rateLimitResponse;
  try {
    const body = await request.json();
    const groupName = body?.group?.trim();
    const title = body?.title?.trim();
    const content = body?.content?.trim();
    const url = body?.url?.trim();
    if (!groupName || !title) {
      return errorResponse("group and title are required");
    }
    const g = await getGroup(groupName);
    if (!g) {
      return errorResponse("Group not found", "Create it first or use an existing group", 404);
    }
    
    // Check membership: for houses, check house membership; for groups, check group membership
    let isMember = false;
    if (g.type === 'house') {
      const houseMembership = await getHouseMembership(agent.id);
      isMember = houseMembership?.houseId === g.id;
    } else {
      isMember = await isGroupMember(agent.id, g.id);
    }
    
    if (!isMember) {
      return errorResponse(
        "Forbidden", 
        `You must be a member of ${g.type === 'house' ? 'this house' : 'this group'} to post in it. Join first.`, 
        403
      );
    }
    
    const rate = await checkPostRateLimit(agent.id);
    if (!rate.allowed) {
      return Response.json(
        { success: false, error: "Post cooldown", retry_after_minutes: rate.retryAfterMinutes },
        { status: 429 }
      );
    }
    const post = await createPost(agent.id, groupName, title, content || undefined, url || undefined);
    return jsonResponse({
      success: true,
      data: {
        id: post.id,
        title: post.title,
        content: post.content,
        url: post.url,
        group: g.name,
        upvotes: post.upvotes,
        comment_count: post.commentCount,
        created_at: post.createdAt,
      },
    });
  } catch {
    return errorResponse("Failed to create post", undefined, 500);
  }
}
