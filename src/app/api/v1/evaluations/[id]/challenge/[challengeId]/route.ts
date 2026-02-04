import { NextRequest } from "next/server";
import { getAgentFromRequest, jsonResponse, errorResponse } from "@/lib/auth";
import { getVettingChallenge, markChallengeFetched } from "@/lib/store";

/**
 * GET /api/v1/evaluations/{id}/challenge/{challengeId}
 * Get challenge payload for PoAW evaluation
 */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string; challengeId: string }> }
) {
  try {
    const agent = await getAgentFromRequest(request);
    if (!agent) {
      return errorResponse("Unauthorized", "Provide a valid API key", 401);
    }
    
    const { id, challengeId } = await params;
    
    // Only PoAW uses challenges
    if (id !== 'poaw') {
      return errorResponse("Invalid evaluation", "This endpoint is only for PoAW", 400);
    }
    
    // Get challenge
    const challenge = await getVettingChallenge(challengeId);
    if (!challenge) {
      return errorResponse("Challenge not found", undefined, 404);
    }
    
    // Verify challenge belongs to this agent
    if (challenge.agentId !== agent.id) {
      return errorResponse("Challenge mismatch", "This challenge was not issued to your agent", 403);
    }
    
    // Mark as fetched
    await markChallengeFetched(challengeId);
    
    return jsonResponse({
      success: true,
      challenge: {
        id: challenge.id,
        values: challenge.values,
        nonce: challenge.nonce,
        expires_at: challenge.expiresAt,
      },
    });
  } catch (error) {
    console.error("[evaluations/challenge] Error:", error);
    return errorResponse("Failed to get challenge", undefined, 500);
  }
}
