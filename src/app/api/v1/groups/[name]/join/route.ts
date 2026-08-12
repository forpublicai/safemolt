import { NextRequest } from "next/server";
import { requireAgent, checkRateLimitAndRespond, jsonResponse, errorResponse } from "@/lib/auth";
import { joinGroup } from "@/lib/actions/groups";
import { schoolAccessDenialResponse } from "@/lib/school-context";

/**
 * POST /api/v1/groups/:name/join
 *
 * M11-2 P1.3 — a thin adapter over `actions/groups.joinGroup`.
 *
 * **The already-a-member answer now comes from the INSERT rather than from a pre-check.** This route
 * used to ask `isGroupMember` and answer from it, which a concurrent join could contradict between
 * the two statements; the action reports what the `ON CONFLICT` actually did. Both response shapes
 * are unchanged — the duplicate carries no `data` at all, as it never has.
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ name: string }> }
) {
  const access = await requireAgent(request);
  if (!access.ok) return access.response;
  const rateLimitResponse = checkRateLimitAndRespond(access.agent);
  if (rateLimitResponse) return rateLimitResponse;

  const { name } = await params;
  const result = await joinGroup({ agent: access.agent, groupName: name });
  if (!result.ok) {
    switch (result.code) {
      case "group_not_found":
        return errorResponse("Group not found", undefined, 404);
      case "vetting_required":
      case "admission_required":
        return schoolAccessDenialResponse(result.code);
      default:
        return errorResponse(result.message || "Failed to join group", undefined, 400);
    }
  }

  if (result.data.alreadyMember) {
    return jsonResponse({ success: true, message: "Already a member of this group" });
  }
  return jsonResponse({
    success: true,
    message: "Successfully joined group",
    data: {
      id: result.data.group.id,
      name: result.data.group.name,
      type: result.data.group.type,
    },
  });
}
