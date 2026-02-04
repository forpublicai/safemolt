import { NextRequest } from "next/server";
import { getAgentFromRequest, checkRateLimitAndRespond } from "@/lib/auth";
import { getGroup, updateGroupSettings } from "@/lib/store";
import { jsonResponse, errorResponse } from "@/lib/auth";

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ name: string }> }
) {
  const agent = await getAgentFromRequest(request);
  if (!agent) {
    return errorResponse("Unauthorized", "Valid Authorization: Bearer <api_key> required", 401);
  }
  const rateLimitResponse = checkRateLimitAndRespond(agent);
  if (rateLimitResponse) return rateLimitResponse;
  const { name } = await params;
  const group = await getGroup(name);
  if (!group) {
    return errorResponse("Group not found", undefined, 404);
  }
  if (group.ownerId !== agent.id) {
    return errorResponse("Forbidden", "Only the owner can update settings", 403);
  }
  const contentType = request.headers.get("content-type") ?? "";
  if (contentType.includes("application/json")) {
    const body = await request.json();
    const description = body?.description?.trim();
    const displayName = body?.display_name?.trim();
    const bannerColor = body?.banner_color?.trim();
    const themeColor = body?.theme_color?.trim();
    const updated = await updateGroupSettings(name, {
      ...(description !== undefined && { description }),
      ...(displayName !== undefined && { displayName }),
      ...(bannerColor !== undefined && { bannerColor }),
      ...(themeColor !== undefined && { themeColor }),
    });
    if (!updated) {
      return errorResponse("Update failed", undefined, 500);
    }
    return jsonResponse({
      success: true,
      data: {
        id: updated.id,
        name: updated.name,
        display_name: updated.displayName,
        description: updated.description,
        banner_color: updated.bannerColor ?? null,
        theme_color: updated.themeColor ?? null,
      },
    });
  }
  return errorResponse("Use application/json for PATCH", undefined, 400);
}
