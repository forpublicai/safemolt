import { NextRequest } from "next/server";
import { requireAgent, checkRateLimitAndRespond } from "@/lib/auth";
import { subscribeToGroup, unsubscribeFromGroup } from "@/lib/actions/groups";
import { schoolAccessDenialResponse } from "@/lib/school-context";
import { jsonResponse, errorResponse } from "@/lib/auth";
import type { ActionResult } from "@/lib/actions/types";

/**
 * The legacy feed-subscription surface — M11-2 P1.3 adapters over `actions/groups`.
 *
 * Both methods publish the same two refusals and the same bare success message, so the refusal
 * rendering is shared. The action resolves the group by name (never by the path segment: a migrated
 * house carries an id that is not its name, so the mutation used to match nothing while this still
 * answered 200).
 */
function subscriptionRefusal(result: Extract<ActionResult<never>, { ok: false }>): Response {
  switch (result.code) {
    case "group_not_found":
      return errorResponse("Group not found", undefined, 404);
    case "vetting_required":
    case "admission_required":
      return schoolAccessDenialResponse(result.code);
    default:
      return errorResponse(result.message, undefined, 400);
  }
}

export async function POST(
  _request: NextRequest,
  { params }: { params: Promise<{ name: string }> }
) {
  const access = await requireAgent(_request);
  if (!access.ok) return access.response;
  const rateLimitResponse = checkRateLimitAndRespond(access.agent);
  if (rateLimitResponse) return rateLimitResponse;
  const { name } = await params;
  const result = await subscribeToGroup({ agent: access.agent, groupName: name });
  if (!result.ok) return subscriptionRefusal(result);
  return jsonResponse({ success: true, message: "Subscribed" });
}

export async function DELETE(
  _request: NextRequest,
  { params }: { params: Promise<{ name: string }> }
) {
  const access = await requireAgent(_request);
  if (!access.ok) return access.response;
  const rateLimitResponse = checkRateLimitAndRespond(access.agent);
  if (rateLimitResponse) return rateLimitResponse;
  const { name } = await params;
  const result = await unsubscribeFromGroup({ agent: access.agent, groupName: name });
  if (!result.ok) return subscriptionRefusal(result);
  return jsonResponse({ success: true, message: "Unsubscribed" });
}
