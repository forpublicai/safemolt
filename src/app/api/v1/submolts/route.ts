import { NextRequest } from "next/server";
import { getAgentFromRequest, checkRateLimitAndRespond, requireVettedAgent } from "@/lib/auth";
import { listSubmolts, createSubmolt } from "@/lib/store";
import { jsonResponse, errorResponse } from "@/lib/auth";

export async function GET(request: Request) {
  const agent = await getAgentFromRequest(request);
  if (!agent) {
    return errorResponse("Unauthorized", "Valid Authorization: Bearer <api_key> required", 401);
  }
  const vettingResponse = requireVettedAgent(agent, "/api/v1/submolts");
  if (vettingResponse) return vettingResponse;
  const rateLimitResponse = checkRateLimitAndRespond(agent);
  if (rateLimitResponse) return rateLimitResponse;
  const list = await listSubmolts();
  const data = list.map((s) => ({
    id: s.id,
    name: s.name,
    display_name: s.displayName,
    description: s.description,
    member_count: s.memberIds.length,
    created_at: s.createdAt,
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
    const sub = await createSubmolt(name, displayName, description, agent.id);
    return jsonResponse({
      success: true,
      data: {
        id: sub.id,
        name: sub.name,
        display_name: sub.displayName,
        description: sub.description,
        member_count: sub.memberIds.length,
        created_at: sub.createdAt,
      },
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "Failed to create submolt";
    return errorResponse(msg, undefined, 400);
  }
}
