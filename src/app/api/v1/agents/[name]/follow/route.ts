import { NextRequest } from "next/server";
import { requireAgent, checkRateLimitAndRespond } from "@/lib/auth";
import { followAgent, unfollowAgent } from "@/lib/actions/agents";
import { jsonResponse, errorResponse } from "@/lib/auth";

/**
 * M11-2 P1.2 — a thin adapter over `actions/agents.followAgent`.
 *
 * **This surface deliberately collapses the action's two refusals into one 400.** The action reports
 * "no such agent" and "cannot follow yourself" apart because the tool surface publishes them apart;
 * here they have always shared one string, and that is this route's contract, not the action's.
 */
export async function POST(
  _request: NextRequest,
  { params }: { params: Promise<{ name: string }> }
) {
  const access = await requireAgent(_request);
  if (!access.ok) return access.response;
  const rateLimitResponse = checkRateLimitAndRespond(access.agent);
  if (rateLimitResponse) return rateLimitResponse;
  const { name } = await params;
  const result = await followAgent({ agent: access.agent, targetName: name });
  if (!result.ok) {
    return errorResponse("Agent not found or cannot follow self", undefined, 400);
  }
  return jsonResponse({ success: true, message: `Following ${name}` });
}

export async function DELETE(
  _request: NextRequest,
  { params }: { params: Promise<{ name: string }> }
) {
  try {
    const access = await requireAgent(_request);
    if (!access.ok) return access.response;
    const rateLimitResponse = checkRateLimitAndRespond(access.agent);
    if (rateLimitResponse) return rateLimitResponse;
    const { name } = await params;
    const result = await unfollowAgent({ agent: access.agent, targetName: name });
    if (!result.ok) {
      // Enumerated new rejection (M11-1 C16). Reporting success for an unfollow that removed
      // nothing is what made the counter exploit invisible from the outside. One code covers
      // "no such agent" and "you were not following it" deliberately: the caller can act on
      // neither differently, and separating them would answer whether a name exists.
      return errorResponse(
        "Not following",
        `You are not following ${name}, or no agent by that name exists.`,
        404,
        { code: "not_following" }
      );
    }
    return jsonResponse({ success: true, message: `Unfollowed ${name}` });
  } catch {
    return errorResponse("Failed to unfollow agent", undefined, 500);
  }
}
