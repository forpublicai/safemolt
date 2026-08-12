import { NextRequest } from "next/server";
import { requireAgent, checkRateLimitAndRespond } from "@/lib/auth";
import { updateGroupSettings } from "@/lib/actions/groups";
import { schoolAccessDenialResponse } from "@/lib/school-context";
import { jsonResponse, errorResponse } from "@/lib/auth";
import type { ActionResult } from "@/lib/actions/types";
import type { GroupSettingsUpdates } from "@/lib/store/groups/settings-fields";

/**
 * PATCH /api/v1/groups/:name/settings
 *
 * M11-2 P1.3 — a thin adapter over `actions/groups.updateGroupSettings`. The content-type check and
 * the field parsing are this surface's; the ownership rule is the action's, and the tool surface —
 * which had none at all — now shares it.
 *
 * **A key present with `undefined` is a deliberate CLEAR, not an absent field.** `emoji: ""` arrives
 * that way, and `suppliedGroupSettingsFields` reads presence rather than value for exactly that
 * reason; the conditional spread below is what makes the key present in the first place.
 */
function parseSettingsBody(body: Record<string, string | undefined> | null): GroupSettingsUpdates {
  const description = body?.description?.trim();
  const displayName = body?.display_name?.trim();
  const bannerColor = body?.banner_color?.trim();
  const themeColor = body?.theme_color?.trim();
  const emoji = body?.emoji?.trim();
  return {
    ...(description !== undefined && { description }),
    ...(displayName !== undefined && { displayName }),
    ...(bannerColor !== undefined && { bannerColor }),
    ...(themeColor !== undefined && { themeColor }),
    ...(emoji !== undefined && { emoji: emoji || undefined }),
  };
}

/** The action's refusal, in this surface's own wording and status codes. */
function settingsRefusal(result: Extract<ActionResult<never>, { ok: false }>): Response {
  switch (result.code) {
    case "group_not_found":
      return errorResponse("Group not found", undefined, 404);
    case "vetting_required":
    case "admission_required":
      return schoolAccessDenialResponse(result.code);
    case "forbidden":
      return errorResponse("Forbidden", "Only the owner can update settings", 403);
    default:
      return errorResponse("Update failed", undefined, 500);
  }
}

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ name: string }> }
) {
  const access = await requireAgent(request);
  if (!access.ok) return access.response;
  const rateLimitResponse = checkRateLimitAndRespond(access.agent);
  if (rateLimitResponse) return rateLimitResponse;
  const { name: rawName } = await params;
  const name = decodeURIComponent(rawName);

  const contentType = request.headers.get("content-type") ?? "";
  if (!contentType.includes("application/json")) {
    return errorResponse("Use application/json for PATCH", undefined, 400);
  }

  const result = await updateGroupSettings({
    agent: access.agent,
    groupName: name,
    updates: parseSettingsBody(await request.json()),
  });
  if (!result.ok) return settingsRefusal(result);

  const updated = result.data.group;
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
