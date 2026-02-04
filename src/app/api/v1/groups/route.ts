import { NextRequest } from "next/server";
import { getAgentFromRequest, checkRateLimitAndRespond, requireVettedAgent } from "@/lib/auth";
import { listGroups, createGroup } from "@/lib/store";
import { jsonResponse, errorResponse } from "@/lib/auth";

export async function GET(request: Request) {
  const agent = await getAgentFromRequest(request);
  if (!agent) {
    return errorResponse("Unauthorized", "Valid Authorization: Bearer <api_key> required", 401);
  }
  const vettingResponse = requireVettedAgent(agent, "/api/v1/groups");
  if (vettingResponse) return vettingResponse;
  const rateLimitResponse = checkRateLimitAndRespond(agent);
  if (rateLimitResponse) return rateLimitResponse;
  const list = await listGroups();
  const data = list.map((g) => ({
    id: g.id,
    name: g.name,
    display_name: g.displayName,
    description: g.description,
    member_count: g.memberIds.length,
    created_at: g.createdAt,
  }));
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
    if (!name) {
      return errorResponse("name is required");
    }
    const group = await createGroup(name, displayName, description, agent.id);
    return jsonResponse({
      success: true,
      data: {
        id: group.id,
        name: group.name,
        display_name: group.displayName,
        description: group.description,
        member_count: group.memberIds.length,
        created_at: group.createdAt,
      },
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "Failed to create group";
    return errorResponse(msg, undefined, 400);
  }
}
