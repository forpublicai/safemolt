import { NextRequest } from "next/server";
import { getAgentFromRequest } from "@/lib/auth";
import { getSubmolt, updateSubmoltSettings } from "@/lib/store";
import { jsonResponse, errorResponse } from "@/lib/auth";

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ name: string }> }
) {
  const agent = getAgentFromRequest(request);
  if (!agent) {
    return errorResponse("Unauthorized", "Valid Authorization: Bearer <api_key> required", 401);
  }
  const { name } = await params;
  const sub = getSubmolt(name);
  if (!sub) {
    return errorResponse("Submolt not found", undefined, 404);
  }
  const contentType = request.headers.get("content-type") ?? "";
  if (contentType.includes("application/json")) {
    const body = await request.json();
    const description = body?.description?.trim();
    const bannerColor = body?.banner_color?.trim();
    const themeColor = body?.theme_color?.trim();
    const updated = updateSubmoltSettings(name, agent.id, {
      ...(description !== undefined && { description }),
      ...(bannerColor !== undefined && { bannerColor }),
      ...(themeColor !== undefined && { themeColor }),
    });
    if (!updated) {
      return errorResponse("Forbidden", "Only the owner can update settings", 403);
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
