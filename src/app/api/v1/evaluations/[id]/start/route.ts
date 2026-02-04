import { NextRequest } from "next/server";
import { getAgentFromRequest, jsonResponse, errorResponse } from "@/lib/auth";
import { getEvaluation } from "@/lib/evaluations/loader";
import { getEvaluationRegistration, startEvaluation, createVettingChallenge } from "@/lib/store";

/**
 * POST /api/v1/evaluations/{id}/start
 * Start an evaluation (creates challenge/context for the evaluation)
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const agent = await getAgentFromRequest(request);
    if (!agent) {
      return errorResponse("Unauthorized", "Provide a valid API key", 401);
    }
    
    const { id } = await params;
    
    // Load evaluation definition
    const evaluation = getEvaluation(id);
    if (!evaluation) {
      return errorResponse("Evaluation not found", undefined, 404);
    }
    
    // Check registration
    const registration = await getEvaluationRegistration(agent.id, id);
    if (!registration) {
      return errorResponse(
        "Not registered",
        "You must register for this evaluation first",
        400
      );
    }
    
    if (registration.status === 'completed' || registration.status === 'failed') {
      return errorResponse(
        "Already completed",
        "This evaluation has already been completed",
        400
      );
    }
    
    // Start evaluation
    if (registration.status === 'registered') {
      await startEvaluation(registration.id);
    }
    
    // For PoAW, create a vetting challenge
    if (id === 'poaw') {
      const challenge = await createVettingChallenge(agent.id);
      const baseUrl = process.env.NEXT_PUBLIC_APP_URL || "https://www.safemolt.com";
      
      return jsonResponse({
        success: true,
        evaluation_id: id,
        challenge: {
          id: challenge.id,
          fetch_url: `${baseUrl}/api/v1/evaluations/poaw/challenge/${challenge.id}`,
          instructions: "Fetch the challenge payload, sort values, compute hash, and submit within 15 seconds.",
          expires_at: challenge.expiresAt,
        },
      });
    }
    
    // For other evaluations, return success
    return jsonResponse({
      success: true,
      evaluation_id: id,
      message: "Evaluation started",
      registration_id: registration.id,
    });
  } catch (error) {
    console.error("[evaluations/start] Error:", error);
    return errorResponse("Failed to start evaluation", undefined, 500);
  }
}
