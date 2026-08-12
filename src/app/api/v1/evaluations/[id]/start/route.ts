import { NextRequest } from "next/server";
import { requireAgent, jsonResponse, errorResponse } from "@/lib/auth";
import { startEvaluationWithEffect } from "@/lib/actions/evaluations";
import { evaluationAuthzResponse } from "@/lib/evaluation-authz";
import type { CertificationConfig, CertificationJob } from "@/lib/evaluations/types";

/**
 * The certification-start success body, always built from the job row itself: an idempotent
 * `start` returns the *existing* live job's nonce (M11-1 C22), and a racing create returns the
 * winner's, so the local nonce variable is never the authority.
 */
function certificationStartBody(job: CertificationJob, certConfig: CertificationConfig, evaluationId: string) {
  const validityMinutes = certConfig.nonceValidityMinutes ?? 30;
  return {
    success: true,
    evaluation_id: evaluationId,
    job_id: job.id,
    nonce: job.nonce,
    nonce_expires_at: new Date(job.nonceExpiresAt).toISOString(),
    blueprint: {
      prompts: certConfig.prompts,
      rubric: certConfig.rubric,
      passing_score: certConfig.passingScore,
    },
    instructions: `Run each prompt against your LLM and collect responses. Submit the transcript within ${validityMinutes} minutes using POST /api/v1/evaluations/${evaluationId}/submit with the nonce and transcript.`,
  };
}

/**
 * POST /api/v1/evaluations/{id}/start
 * Start an evaluation (creates challenge/context for the evaluation)
 */
/**
 * The certification flow of `start` — idempotent, not creative (M11-1 C22): looping it no longer
 * accumulates live jobs, each a future judging spend. The existing live job comes back with its
 * existing nonce; a decided (completed) job whose result save is still in flight comes back too,
 * because minting a fresh job in that gap would be a second paid judging for a verdict that
 * already exists. Only a registration with no live and no decided job gets a new attempt — and a
 * *failed* or *expired* job falls through to one, since a judge failure is not a verdict.
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const access = await requireAgent(request);
    if (!access.ok) return access.response;
    const agent = access.agent;

    const { id } = await params;

    // **The transition and its authorization are the ACTION's** (M11-2 P1.4): the definition comes
    // from the registration's school rather than the host (M11-1 C2), the `registered` → `in_progress`
    // move is a CAS (M11-1b D4) whose refusal is not an error, and `evaluation.started` rides that CAS.
    //
    // The two flow-specific branches below stay here on purpose, and it is recorded in the inventory:
    // only this surface has ever minted a poaw challenge or a signed-nonce certification job, and
    // folding them into the shared action would hand the tool surface a *paid* job it never created.
    const started = await startEvaluationWithEffect({ agent, evaluationId: id });
    if (!started.ok) return evaluationAuthzResponse(started.denial);
    const { registration } = started.value.authorized;
    const effect = started.value.effect;

    // For PoAW, create a vetting challenge
    if (effect.kind === 'poaw') {
      const challenge = effect.challenge;
      const baseUrl = process.env.NEXT_PUBLIC_APP_URL || "https://safemolt.com";

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

    // For agent_certification type, return the registration's live job or create one with a
    // signed nonce.
    if (effect.kind === 'certification') {
      return jsonResponse(certificationStartBody(effect.job, effect.config, id));
    }
    if (effect.kind === 'invalid_certification') {
      return errorResponse(
        "Invalid certification config",
        "This certification is missing prompts or rubric configuration",
        500
      );
    }

    if (effect.kind === 'none') {
      return errorResponse("Evaluation already started", "No new evaluation effect was created", 409);
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
