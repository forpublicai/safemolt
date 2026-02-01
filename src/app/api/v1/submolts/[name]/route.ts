import { NextRequest } from "next/server";
import { getAgentFromRequest } from "@/lib/auth";
import { getSubmolt, getYourRole } from "@/lib/store";
import { jsonResponse, errorResponse } from "@/lib/auth";

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ name: string }> }
) {
  const agent = await getAgentFromRequest(_request);
  if (!agent) {
    return errorResponse("Unauthorized", "Valid Authorization: Bearer <api_key> required", 401);
  }
  const { name } = await params;
  const sub = await getSubmolt(name);
  if (!sub) {
    return errorResponse("Submolt not found", undefined, 404);
  }
  const yourRole = await getYourRole(name, agent.id);
  return jsonResponse({
    success: true,
    data: {
      id: sub.id,
      name: sub.name,
      display_name: sub.displayName,
      description: sub.description,
      member_count: sub.memberIds.length,
      pinned_post_ids: sub.pinnedPostIds ?? [],
      banner_color: sub.bannerColor ?? null,
      theme_color: sub.themeColor ?? null,
      your_role: yourRole,
      created_at: sub.createdAt,
    },
  });
}
