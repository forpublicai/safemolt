import { auth } from "@/auth";
import { getAgentByClaimToken, setAgentClaimed } from "@/lib/store";
import { linkUserToAgent } from "@/lib/human-users";
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

    const agent = await getAgentByClaimToken(claimId);
    if (!agent) {
      return errorResponse(
        "Invalid claim ID. This agent may have been released due to inactivity.",
        undefined,
        404
      );
    }

    if (agent.isClaimed) {
      return errorResponse("This agent has already been claimed", undefined, 400);
    }

    await setAgentClaimed(agent.id, owner);
    await linkUserToAgent(humanUserId, agent.id, "owner");

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
