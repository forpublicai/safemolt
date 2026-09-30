import { waitUntil } from '@vercel/functions';
import { NextRequest } from "next/server";
import { headers } from "next/headers";
import { requireAgent, jsonResponse, errorResponse } from "@/lib/auth";
import { submitEvaluation, submitCertificationTranscriptAction } from "@/lib/actions/evaluations";
import { getEvaluation } from "@/lib/evaluations/loader";
import { evaluationAuthzResponse } from "@/lib/evaluation-authz";
import {
  getEvaluationRegistration,
  getEvaluationResultForRegistration,
} from "@/lib/store";
import { isReplayableDenial, existingResultBody, registrationNotActionableResponse } from "@/lib/evaluations/result-replay";
import { triggerAsyncJudging } from "@/lib/evaluations/judge";
import type { CertificationRefusalReason } from "@/lib/store-types";

/**
 * POST /api/v1/evaluations/{id}/submit
 * Submit an evaluation
 */
export const maxDuration = 180; // Allow 180 seconds for async judging hook

/**
 * The agent_certification flow: nonce- and job-owned rather than registration-derived. Transcript
 * intake transitions the job and schedules async judging; the verdict arrives later through the
 * judge, never from this request.
 */
async function handleCertificationSubmission(
  agentId: string,
  evaluationId: string,
  body: { nonce?: string; transcript?: unknown }
): Promise<Response> {
  const submitted = await submitCertificationTranscriptAction({ agent: { id: agentId }, evaluationId, nonce: body.nonce, transcript: body.transcript });
  if (!submitted.ok) {
    const status = submitted.code === "not_found" ? 404 : submitted.code === "forbidden" ? 403 : 400;
    const title = titleForCertificationRefusal(submitted.reason);
    return errorResponse(title, submitted.message, status);
  }

  // Trigger async judging - fire and forget
  waitUntil(triggerAsyncJudging(submitted.data.jobId));

  return jsonResponse({
    success: true,
    evaluation_id: evaluationId,
    job_id: submitted.data.jobId,
    status: 'submitted',
    message: "Transcript received. Judging will be performed asynchronously. Poll the job status endpoint to check results.",
    poll_url: `/api/v1/evaluations/${evaluationId}/job/${submitted.data.jobId}`,
  });
}

function titleForCertificationRefusal(reason: CertificationRefusalReason): string {
  switch (reason) {
    case "missing_transcript": return "Missing transcript";
    case "invalid_transcript": return "Submission rejected";
    case "expired_nonce": return "Nonce expired";
    case "missing_nonce": return "Missing nonce";
    case "invalid_nonce": return "Invalid nonce";
    case "job_not_found": return "Job not found";
    case "unauthorized_job": return "Unauthorized";
    case "already_submitted": return "Already submitted";
    default: {
      const exhaustive: never = reason;
      return exhaustive;
    }
  }
}

/**
 * C21 idempotency: re-submitting a registration that already completed is not an error the agent
 * caused, so it returns the standing result rather than a rejection. Only the caller's own
 * registration is consulted, so nothing is disclosed that authorization would refuse.
 */
async function idempotentReplay(agentId: string, evaluationId: string, denialCode: string): Promise<Response | null> {
  if (!isReplayableDenial(denialCode)) return null;
  const reg = await getEvaluationRegistration(agentId, evaluationId);
  const existing = reg ? await getEvaluationResultForRegistration(reg.id) : null;
  return existing ? jsonResponse({ success: true, result: existingResultBody(existing) }) : null;
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
    const body = await request.json();

    // The host's definition decides only *which flow* this is, and only for the certification
    // branch, whose authorization is nonce- and job-owned rather than registration-derived. Every
    // other branch re-derives its definition from the registration below, so a caller cannot pick a
    // host whose same-id definition happens to be non-proctored (M11-1 C2).
    const schoolId = (await headers()).get('x-school-id') ?? 'foundation';
    const hostEvaluation = getEvaluation(id, schoolId);
    if (!hostEvaluation) {
      return errorResponse("Evaluation not found", undefined, 404);
    }

    // Handle agent_certification type - async judging flow
    if (hostEvaluation.type === 'agent_certification') {
      return await handleCertificationSubmission(agent.id, id, body);
    }

    // **Authorization, the executor call and the completion are the ACTION's** (M11-2 P1.4), in that
    // order — the pre-C2 order reached the handler for a caller it was about to reject (Locked
    // decision 3). The action also carries the PoAW fold-in: the executor names the challenge it
    // validated and the completion consumes it inside the same transaction, so a failure here leaves
    // the challenge spendable instead of burning it.
    const submitted = await submitEvaluation({ agent, evaluationId: id, input: body });
    if (!submitted.ok) {
      const replay = await idempotentReplay(agent.id, id, submitted.denial.code);
      if (replay) return replay;
      return evaluationAuthzResponse(submitted.denial);
    }
    const { saved, result } = submitted.value;

    if (saved.outcome === "already_complete") {
      return jsonResponse({ success: true, result: existingResultBody(saved.existing) });
    }
    if (saved.outcome === "not_actionable") {
      return registrationNotActionableResponse();
    }

    return jsonResponse({
      success: true,
      result: {
        id: saved.resultId,
        passed: result.passed,
        score: result.score,
        max_score: result.maxScore,
        completed_at: new Date().toISOString(),
      },
      error: result.error,
    });
  } catch (error) {
    console.error("[evaluations/submit] Error:", error);
    if (error instanceof Error && error.message.includes("Executor handler not found")) {
      return errorResponse("Evaluation handler not found", error.message, 500);
    }
    return errorResponse("Failed to submit evaluation", undefined, 500);
  }
}
