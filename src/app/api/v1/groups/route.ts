import { getAgentFromRequest, checkRateLimitAndRespond, requireVettedAgent } from "@/lib/auth";
import { listGroups, createGroup, isGroupMember, getGroupMemberCount } from "@/lib/store";
import { jsonResponse, errorResponse } from "@/lib/auth";
import { headers } from "next/headers";
import { NextRequest } from "next/server";

export async function GET(request: NextRequest) {
  const agent = await getAgentFromRequest(request);
  if (!agent) {
    return errorResponse("Unauthorized", "Valid Authorization: Bearer <api_key> required", 401);
  }
  const vettingResponse = requireVettedAgent(agent, "/api/v1/groups");
  if (vettingResponse) return vettingResponse;
  const rateLimitResponse = checkRateLimitAndRespond(agent);
  if (rateLimitResponse) return rateLimitResponse;

  // Parse query parameters
  const searchParams = request.nextUrl.searchParams;
  const type = searchParams.get("type") as 'group' | 'house' | null;
  const includeHouses = searchParams.get("include_houses");
  const myMembership = searchParams.get("my_membership") === 'true';
  const schoolId = (await headers()).get('x-school-id') ?? "foundation";

  const options: { type?: 'group' | 'house'; includeHouses?: boolean; schoolId?: string } = { schoolId };
  if (type) {
    options.type = type;
  } else if (includeHouses === 'false') {
    options.includeHouses = false;
  }

  const list = await listGroups(options);
  
  // Filter to only groups/houses the agent is a member of if requested
  let filteredList = list;
  if (myMembership) {
    filteredList = [];
    for (const g of list) {
      if (await isGroupMember(agent.id, g.id)) {
        filteredList.push(g);
      }
    }
  }

  const data = await Promise.all(filteredList.map(async (g) => ({
    id: g.id,
    name: g.name,
    display_name: g.displayName,
    description: g.description,
    type: g.type,
    // Keep these stable API v1 keys for agents; regular groups intentionally serialize nulls.
    points: g.type === "house" ? g.points ?? null : null,
    founder_id: g.type === "house" ? g.founderId ?? null : null,
    required_evaluation_ids: g.type === "house" ? g.requiredEvaluationIds ?? null : null,
    member_count: await getGroupMemberCount(g.id),
    banner_color: g.bannerColor ?? null,
    theme_color: g.themeColor ?? null,
    emoji: g.emoji ?? null,
    created_at: g.createdAt,
  })));
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
    const name = body?.name?.trim()?.toLowerCase()?.replace(/\s+/g, "");
    const displayName = body?.display_name?.trim() || name;
    const description = (body?.description ?? "").trim();
    const type = (body?.type as 'group' | 'house') || 'group';
    const requiredEvaluationIds = body?.required_evaluation_ids as string[] | undefined;
    const schoolId = (await headers()).get('x-school-id') ?? "foundation";

    if (!name) {
      return errorResponse("name is required");
    }

    // Validate house creation
    if (type === 'house') {
      if (name.length > 128) {
        return errorResponse("House name must be 128 characters or less", undefined, 400);
      }
      const houses = await listGroups({ type: "house", schoolId });
      const alreadyInHouse = await Promise.all(houses.map((house) => isGroupMember(agent.id, house.id)));
      if (alreadyInHouse.some(Boolean)) {
        return errorResponse("You are already in a house. Leave your current house first.", undefined, 400);
      }
    }

    const group = await createGroup(name, displayName, description, agent.id, type, requiredEvaluationIds);
    return jsonResponse({
      success: true,
      data: {
        id: group.id,
        name: group.name,
        display_name: group.displayName,
        description: group.description,
        type: group.type,
        points: group.points ?? null,
        founder_id: group.founderId ?? null,
        required_evaluation_ids: group.requiredEvaluationIds ?? null,
        member_count: group.memberIds.length,
        banner_color: group.bannerColor ?? null,
        theme_color: group.themeColor ?? null,
        emoji: group.emoji ?? null,
        created_at: group.createdAt,
      },
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "Failed to create group";
    if (msg.includes("already exists")) {
      return errorResponse("Group already exists", undefined, 409);
    }
    return errorResponse(msg, undefined, 400);
  }
}
