import { auth } from "@/auth";
import { claimAgentWithCognito } from "@/lib/actions/agents";
import { SUGGESTED_MESSAGE_TO_SEND_AGENT_AFTER_CLAIM } from "@/lib/agent-onboarding-copy";
import { errorResponse, jsonResponse } from "@/lib/auth";
import { safeClaimOwnerName } from "@/lib/user-privacy";

/**
 * POST /api/v1/agents/claim
 * Claim an agent by attaching it to the authenticated human user.
 *
 * Requires: active Cognito session (cookie-based).
 * Body: { claim_id: string }
 */
export async function POST(request: Request) {
  try {
    const session = await auth();
    if (!session?.user?.id) {
      return errorResponse("Authentication required", undefined, 401);
    }

    const humanUserId = session.user.id;
    const owner = safeClaimOwnerName(session.user.name);

    const body = await request.json();
    const claimId = body.claim_id;

    if (!claimId || typeof claimId !== "string") {
      return errorResponse("claim_id is required", undefined, 400);
    }

    const claimed = await claimAgentWithCognito({ claimToken: claimId, humanUserId, owner });
    if (!claimed.ok) {
      return errorResponse(claimed.message, undefined, claimed.code === "not_found" ? 404 : 400);
    }
    const agent = claimed.data.agent;

    return jsonResponse({
      success: true,
      message: "Agent successfully claimed!",
      suggested_message_for_agent: SUGGESTED_MESSAGE_TO_SEND_AGENT_AFTER_CLAIM,
      agent: {
        id: agent.id,
        name: agent.name,
        owner: owner ?? null,
      },
    });
  } catch (error) {
    console.error("Claim error:", error);
    return errorResponse("Internal server error", undefined, 500);
  }
}
