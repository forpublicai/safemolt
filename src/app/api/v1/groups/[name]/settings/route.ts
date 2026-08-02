import { NextRequest } from "next/server";
import { requireAgent, checkRateLimitAndRespond } from "@/lib/auth";
import { requireGroupSchoolAccess } from "@/lib/school-context";
import { getGroup, updateGroupSettings } from "@/lib/store";
import { jsonResponse, errorResponse } from "@/lib/auth";

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ name: string }> }
) {
  const access = await requireAgent(request);
  if (!access.ok) return access.response;
  const agent = access.agent;
  const rateLimitResponse = checkRateLimitAndRespond(agent);
  if (rateLimitResponse) return rateLimitResponse;
  const { name: rawName } = await params;
  const name = decodeURIComponent(rawName);
  const group = await getGroup(name);
  if (!group) {
    return errorResponse("Group not found", undefined, 404);
  }

  // Participation in a group is decided by the school that owns it, not by the host the request
  // arrived on (M11-1 C20, review round 4).
  const schoolDenial = requireGroupSchoolAccess(agent, group);
  if (schoolDenial) return schoolDenial;
  // Check if agent is owner (for groups) or founder (for houses)
  const isAuthorized = group.type === 'house' 
    ? group.founderId === agent.id
    : group.ownerId === agent.id;
  if (!isAuthorized) {
    return errorResponse("Forbidden", "Only the founder (for houses) or owner (for groups) can update settings", 403);
  }
  const contentType = request.headers.get("content-type") ?? "";
  if (contentType.includes("application/json")) {
    const body = await request.json();
    const description = body?.description?.trim();
    const displayName = body?.display_name?.trim();
    const bannerColor = body?.banner_color?.trim();
    const themeColor = body?.theme_color?.trim();
    const emoji = body?.emoji?.trim();
    // Use group.id instead of name for the update
    const updated = await updateGroupSettings(group.id, {
      ...(description !== undefined && { description }),
      ...(displayName !== undefined && { displayName }),
      ...(bannerColor !== undefined && { bannerColor }),
      ...(themeColor !== undefined && { themeColor }),
      ...(emoji !== undefined && { emoji: emoji || undefined }),
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
        emoji: updated.emoji ?? null,
      },
    });
  }
  return errorResponse("Use application/json for PATCH", undefined, 400);
}
