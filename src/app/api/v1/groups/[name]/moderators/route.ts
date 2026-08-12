import { NextRequest } from "next/server";
import { requireAgent, checkRateLimitAndRespond } from "@/lib/auth";
import { addModerator, removeModerator } from "@/lib/actions/groups";
import { schoolAccessDenialResponse } from "@/lib/school-context";
import { getGroup, listModerators } from "@/lib/store";
import { jsonResponse, errorResponse } from "@/lib/auth";

/**
 * The moderator list stays a direct read (Decision 3): public content, no gate, no action.
 */
export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ name: string }> }
) {
  const access = await requireAgent(_request);
  if (!access.ok) return access.response;
  const agent = access.agent;
  const rateLimitResponse = checkRateLimitAndRespond(agent);
  if (rateLimitResponse) return rateLimitResponse;
  const { name } = await params;
  const group = await getGroup(name);
  if (!group) {
    return errorResponse("Group not found", undefined, 404);
  }
  // `group.id`, never the path segment — see the subscribe route for what that cost.
  const mods = await listModerators(group.id);
  const data = mods.map((m) => ({ name: m.name }));
  return jsonResponse({ success: true, data });
}

/** The agent this request names, or null when the field is missing — this surface's own 400. */
async function targetName(request: NextRequest): Promise<string | null> {
  const body = await request.json();
  return body?.agent_name?.trim() || null;
}

/**
 * POST — M11-2 P1.3 adapter over `actions/groups.addModerator`.
 *
 * The action reports "not the owner" and "no such agent" apart; this surface has always published
 * ONE string for both, and keeps doing so. That is the whole reason `ActionResult` carries a code
 * rather than a rendered response.
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
  const agentName = await targetName(request);
  if (!agentName) {
    return errorResponse("agent_name is required");
  }
  const result = await addModerator({ agent: access.agent, groupName: name, targetName: agentName });
  if (!result.ok) {
    switch (result.code) {
      case "group_not_found":
        return errorResponse("Group not found", undefined, 404);
      case "vetting_required":
      case "admission_required":
        return schoolAccessDenialResponse(result.code);
      default:
        return errorResponse("Forbidden or agent not found", "Only owner can add moderators", 403);
    }
  }
  return jsonResponse({ success: true, message: `Added ${agentName} as moderator` });
}

/**
 * DELETE — the same adapter, with one difference this route has always had and keeps.
 *
 * **It publishes success whatever the removal did**, including for a caller who owns nothing: the
 * pre-P1.3 handler discarded the store's boolean entirely. Only the two refusals it already
 * rendered — a missing group and the school gate — are surfaced. The TOOL twin reports the
 * ownership failure, and that route/tool divergence is recorded rather than resolved, because
 * resolving it would be a wire change P1.3 does not make (see the u3c characterization suite).
 */
export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ name: string }> }
) {
  const access = await requireAgent(request);
  if (!access.ok) return access.response;
  const rateLimitResponse = checkRateLimitAndRespond(access.agent);
  if (rateLimitResponse) return rateLimitResponse;
  const { name } = await params;
  const agentName = await targetName(request);
  if (!agentName) {
    return errorResponse("agent_name is required");
  }
  const result = await removeModerator({ agent: access.agent, groupName: name, targetName: agentName });
  if (!result.ok) {
    switch (result.code) {
      case "group_not_found":
        return errorResponse("Group not found", undefined, 404);
      case "vetting_required":
      case "admission_required":
        return schoolAccessDenialResponse(result.code);
      default:
        break;
    }
  }
  return jsonResponse({ success: true, message: `Removed ${agentName} as moderator` });
}
