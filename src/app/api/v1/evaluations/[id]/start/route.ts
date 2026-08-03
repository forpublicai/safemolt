import { NextRequest } from "next/server";
import { requireAgent, jsonResponse, errorResponse } from "@/lib/auth";
import { authorizeEvaluationStart, evaluationAuthzResponse } from "@/lib/evaluation-authz";
import {
  startEvaluation,
  createVettingChallenge,
  createCertificationJob,
  getLiveCertificationJobForRegistration,
  getCertificationJobByRegistration,
  expireStalePendingCertificationJob,
} from "@/lib/store";
import { generateNonce, getNonceExpiresAt, isNonceExpired } from "@/lib/evaluations/nonce";
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
async function certificationStart(
  registrationId: string,
  agentId: string,
  evaluationId: string,
  certConfig: CertificationConfig
): Promise<Response> {
  const existing = await getLiveCertificationJobForRegistration(registrationId);
  if (existing) {
    // A pending job whose nonce lapsed would strand the registration behind the live-job index;
    // expire it (conditionally — a concurrent submit wins) and fall through to a fresh attempt.
    const staleNonce = existing.status === 'pending' && isNonceExpired(existing.nonceExpiresAt);
    if (!staleNonce) {
      return jsonResponse(certificationStartBody(existing, certConfig, evaluationId));
    }
    await expireStalePendingCertificationJob(existing.id);
  } else {
    const latest = await getCertificationJobByRegistration(registrationId);
    if (latest?.status === 'completed') {
      return jsonResponse(certificationStartBody(latest, certConfig, evaluationId));
    }
  }

  // Generate signed nonce and create the job. A concurrent `start` races safely: the loser's
  // insert trips the live-job index and the winner's job is returned instead.
  const nonce = generateNonce(evaluationId, agentId);
  const nonceExpiresAt = getNonceExpiresAt(certConfig.nonceValidityMinutes ?? 30);
  const job = await createCertificationJob(registrationId, agentId, evaluationId, nonce, nonceExpiresAt);

  return jsonResponse(certificationStartBody(job, certConfig, evaluationId));
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const access = await requireAgent(request);
    if (!access.ok) return access.response;
    const agent = access.agent;

    const { id } = await params;

    // The definition comes from the **registration's** school, not the request's host (M11-1 C2,
    // review round 6). This route used to load it from the host and then mutate a globally-fetched
    // registration, so a vetted-but-unadmitted agent could start a non-Foundation registration
    // through the Foundation surface. `authorizeEvaluationStart` also subsumes the "not registered"
    // and terminal-status rejections this handler used to make by hand.
    const authorized = await authorizeEvaluationStart({ agent, evaluationId: id });
    if (!authorized.ok) return evaluationAuthzResponse(authorized.denial);
    const { registration, definition: evaluation } = authorized.value;

    // Start evaluation. The `registered` read is a friendly pre-check only; the transition
    // itself is a CAS (M11-1b D4), so a submit that completed in the gap is not dragged back to
    // `in_progress`. A refused CAS is not an error here — the registration is simply already
    // started or already finished, and the response below reports its standing state either way.
    if (registration.status === 'registered') {
      await startEvaluation(registration.id);
    }

    // For PoAW, create a vetting challenge
    if (id === 'poaw') {
      const challenge = await createVettingChallenge(agent.id);
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
    if (evaluation.type === 'agent_certification') {
      const certConfig = evaluation.config as CertificationConfig | undefined;
      if (!certConfig?.prompts || !certConfig?.rubric) {
        return errorResponse(
          "Invalid certification config",
          "This certification is missing prompts or rubric configuration",
          500
        );
      }
      return await certificationStart(registration.id, agent.id, id, certConfig);
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
