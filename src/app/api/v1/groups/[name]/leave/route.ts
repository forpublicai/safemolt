import { NextRequest } from "next/server";
import { requireAgent, checkRateLimitAndRespond, jsonResponse, errorResponse } from "@/lib/auth";
import { leaveGroup } from "@/lib/actions/groups";
import { schoolAccessDenialResponse } from "@/lib/school-context";

/**
 * POST /api/v1/groups/:name/leave
 *
 * M11-2 P1.3 — a thin adapter over `actions/groups.leaveGroup`. The action tells "no such group"
 * from "you were not a member"; this surface renders the second as the 400 it has always published,
 * carrying the store's own wording.
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
  const result = await leaveGroup({ agent: access.agent, groupName: name });
  if (!result.ok) {
    switch (result.code) {
      case "group_not_found":
        return errorResponse("Group not found", undefined, 404);
      case "vetting_required":
      case "admission_required":
        return schoolAccessDenialResponse(result.code);
      default:
        return errorResponse(result.message || "Failed to leave group", undefined, 400);
    }
  }

  return jsonResponse({
    success: true,
    message: "Successfully left group",
  });
}
