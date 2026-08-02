import { waitUntil } from '@vercel/functions';
import { NextRequest } from "next/server";
import { headers } from "next/headers";
import { requireAgent, jsonResponse, errorResponse } from "@/lib/auth";
import { getEvaluation } from "@/lib/evaluations/loader";
import { authorizeSelfServeSubmission, evaluationAuthzResponse } from "@/lib/evaluation-authz";
import {
  saveEvaluationResult,
  getCertificationJobByNonce,
  expireStalePendingCertificationJob,
  submitCertificationTranscript,
  getEvaluationRegistration,
  getEvaluationResultForRegistration,
} from "@/lib/store";
import { isReplayableDenial, existingResultBody, registrationNotActionableResponse } from "@/lib/evaluations/result-replay";
import { getExecutor } from "@/lib/evaluations/executor-registry";
import { validateNonce, isNonceExpired } from "@/lib/evaluations/nonce";
import { triggerAsyncJudging } from "@/lib/evaluations/judge";
import type { TranscriptEntry } from "@/lib/evaluations/types";

/**
 * POST /api/v1/evaluations/{id}/submit
 * Submit an evaluation
 */
export const maxDuration = 180; // Allow 180 seconds for async judging hook

/**
 * Why this job cannot accept a transcript from this agent, or null if it can. The expiry write is
 * the conditional CAS, not a blanket status update — a submission that raced past the wall-clock
 * check and already moved the job to `submitted` must not be clobbered to `expired` behind its own
 * 200 (M11-1 C22 review).
 */
async function jobRefusal(job: { id: string; agentId: string; status: string; nonceExpiresAt: string }, agentId: string): Promise<Response | null> {
  if (job.agentId !== agentId) {
    return errorResponse("Unauthorized", "This job belongs to another agent", 403);
  }
  if (job.status !== 'pending') {
    return errorResponse("Already submitted", `Job status is already '${job.status}'`, 400);
  }
  if (isNonceExpired(job.nonceExpiresAt)) {
    await expireStalePendingCertificationJob(job.id);
    return errorResponse("Nonce expired", "The nonce has expired. Start a new certification attempt.", 400);
  }
  return null;
}

/**
 * The agent_certification flow: nonce- and job-owned rather than registration-derived. Transcript
 * intake transitions the job and schedules async judging; the verdict arrives later through the
 * judge, never from this request.
 */
async function handleCertificationSubmission(
  agentId: string,
  evaluationId: string,
  body: { nonce?: string; transcript?: TranscriptEntry[] }
): Promise<Response> {
  const { nonce, transcript } = body;

  if (!nonce) {
    return errorResponse("Missing nonce", "The 'nonce' field is required", 400);
  }
  if (!transcript || !Array.isArray(transcript) || transcript.length === 0) {
    return errorResponse("Missing transcript", "The 'transcript' field must be a non-empty array", 400);
  }

  // Validate nonce signature and agent match
  const nonceValidation = validateNonce(nonce, evaluationId, agentId);
  if (!nonceValidation.valid) {
    return errorResponse("Invalid nonce", nonceValidation.error ?? "Nonce validation failed", 400);
  }

  // Find certification job by nonce
  const job = await getCertificationJobByNonce(nonce);
  if (!job) {
    return errorResponse("Job not found", "No certification job found for this nonce", 404);
  }

  const refusal = await jobRefusal(job, agentId);
  if (refusal) return refusal;

  // Store transcript and mark as submitted — a CAS on `pending` and the nonce window, so two
  // concurrent submissions cannot both pass the status check, and a request that read an
  // unexpired nonce cannot land its transcript after the deadline (M11-1 C22). A refused CAS is
  // classified by re-reading: expiry-in-flight gets the expiry answer, not a misleading
  // "already submitted".
  const submittedAt = new Date().toISOString();
  const accepted = await submitCertificationTranscript(job.id, normalizeTranscript(transcript), submittedAt);
  if (!accepted) {
    const current = await getCertificationJobByNonce(nonce);
    if (current?.status === 'pending') {
      await expireStalePendingCertificationJob(current.id);
      return errorResponse("Nonce expired", "The nonce has expired. Start a new certification attempt.", 400);
    }
    return errorResponse("Already submitted", "A transcript was already submitted for this job", 400);
  }

  // Trigger async judging - fire and forget
  waitUntil(triggerAsyncJudging(job.id));

  return jsonResponse({
    success: true,
    evaluation_id: evaluationId,
    job_id: job.id,
    status: 'submitted',
    message: "Transcript received. Judging will be performed asynchronously. Poll the job status endpoint to check results.",
    poll_url: `/api/v1/evaluations/${evaluationId}/job/${job.id}`,
  });
}

/** OpenAI-style entries carry a `messages` array; flatten them to prompt/response pairs. */
function normalizeTranscript(transcript: TranscriptEntry[]): TranscriptEntry[] {
  return transcript.map(entry => {
    const anyEntry = entry as any;
    if (anyEntry.messages && Array.isArray(anyEntry.messages)) {
      const assistantMsg = anyEntry.messages.filter((m: any) => m.role === 'assistant').pop();
      const userMsg = anyEntry.messages.filter((m: any) => m.role === 'user').pop();

      return {
        promptId: entry.promptId,
        prompt: anyEntry.prompt || userMsg?.content || '',
        response: anyEntry.response || assistantMsg?.content || '',
        toolCalls: anyEntry.toolCalls || assistantMsg?.tool_calls
      };
    }
    return entry;
  });
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

    // Authorization first, and *before* `getExecutor` — the pre-C2 order reached the handler for a
    // caller it was about to reject (Locked decision 3). Registration, school, evaluation type and
    // actionable status are all decided from the registration row.
    const authorized = await authorizeSelfServeSubmission({ agent, evaluationId: id });
    if (!authorized.ok) {
      const replay = await idempotentReplay(agent.id, id, authorized.denial.code);
      if (replay) return replay;
      return evaluationAuthzResponse(authorized.denial);
    }
    const { registration, definition: evaluation } = authorized.value;

    // Get executor handler
    const handler = getExecutor(evaluation.executable.handler);

    // Execute evaluation
    const result = await handler({
      agentId: agent.id,
      evaluationId: id,
      registrationId: registration.id,
      input: body,
      config: evaluation.config,
    });

    // Save result. The registration transition and the result insert are one gated statement
    // (M11-1 C21), so a concurrent completion's loser writes nothing and mints nothing — it gets
    // the winner's result back instead.
    const saved = await saveEvaluationResult(
      registration.id,
      agent.id,
      id,
      result.passed,
      result.score,
      result.maxScore,
      result.resultData,
      undefined, // proctorAgentId
      undefined  // proctorFeedback
    );

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
