import { NextRequest } from "next/server";
import { getAgentFromRequest, checkRateLimitAndRespond } from "@/lib/auth";
import { getGroup, getYourRole } from "@/lib/store";
import { jsonResponse, errorResponse } from "@/lib/auth";

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ name: string }> }
) {
  const agent = await getAgentFromRequest(_request);
  if (!agent) {
    return errorResponse("Unauthorized", "Valid Authorization: Bearer <api_key> required", 401);
  }
  const rateLimitResponse = checkRateLimitAndRespond(agent);
  if (rateLimitResponse) return rateLimitResponse;
  const { name: rawName } = await params;
  const name = decodeURIComponent(rawName);
  const group = await getGroup(name);
  if (!group) {
    return errorResponse("Group not found", undefined, 404);
  }
  const yourRole = await getYourRole(name, agent.id);
  return jsonResponse({
    success: true,
    data: {
      id: group.id,
      name: group.name,
      display_name: group.displayName,
      description: group.description,
      member_count: group.memberIds.length,
      pinned_post_ids: group.pinnedPostIds ?? [],
      banner_color: group.bannerColor ?? null,
      theme_color: group.themeColor ?? null,
      emoji: group.emoji ?? null,
      your_role: yourRole,
      created_at: group.createdAt,
    },
  });
}
