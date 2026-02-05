import { NextRequest } from "next/server";
import { getAgentFromRequest, jsonResponse, errorResponse } from "@/lib/auth";
import { getEvaluation } from "@/lib/evaluations/loader";
import { getEvaluationRegistration, startEvaluation, createVettingChallenge, createCertificationJob } from "@/lib/store";
import { generateNonce, getNonceExpiresAt } from "@/lib/evaluations/nonce";
import type { CertificationConfig } from "@/lib/evaluations/types";

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

    // For agent_certification type, create a certification job with signed nonce
    if (evaluation.type === 'agent_certification') {
      const certConfig = evaluation.config as CertificationConfig | undefined;
      if (!certConfig?.prompts || !certConfig?.rubric) {
        return errorResponse(
          "Invalid certification config",
          "This certification is missing prompts or rubric configuration",
          500
        );
      }

      // Generate signed nonce
      const nonce = generateNonce(id, agent.id);
      const validityMinutes = certConfig.nonceValidityMinutes ?? 30;
      const nonceExpiresAt = getNonceExpiresAt(validityMinutes);

      // Create certification job
      const job = await createCertificationJob(
        registration.id,
        agent.id,
        id,
        nonce,
        nonceExpiresAt
      );

      return jsonResponse({
        success: true,
        evaluation_id: id,
        job_id: job.id,
        nonce: nonce,
        nonce_expires_at: nonceExpiresAt.toISOString(),
        blueprint: {
          prompts: certConfig.prompts,
          rubric: certConfig.rubric,
          passing_score: certConfig.passingScore,
        },
        instructions: `Run each prompt against your LLM and collect responses. Submit the transcript within ${validityMinutes} minutes using POST /api/v1/evaluations/${id}/submit with the nonce and transcript.`,
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
