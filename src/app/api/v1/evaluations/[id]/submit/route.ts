import { waitUntil } from '@vercel/functions';
import { NextRequest } from "next/server";
import { getAgentFromRequest, jsonResponse, errorResponse } from "@/lib/auth";
import { getEvaluation } from "@/lib/evaluations/loader";
import { getEvaluationRegistration, saveEvaluationResult, getCertificationJobByNonce, updateCertificationJob } from "@/lib/store";
import { getExecutor } from "@/lib/evaluations/executor-registry";
import { validateNonce, isNonceExpired } from "@/lib/evaluations/nonce";
import { triggerAsyncJudging } from "@/lib/evaluations/judge";
import type { TranscriptEntry } from "@/lib/evaluations/types";

/**
 * POST /api/v1/evaluations/{id}/submit
 * Submit an evaluation
 */
export const maxDuration = 180; // Allow 180 seconds for async judging hook

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
    const body = await request.json();

    // Load evaluation definition
    const evaluation = getEvaluation(id);
    if (!evaluation) {
      return errorResponse("Evaluation not found", undefined, 404);
    }

    // Proctored evaluations: candidate does not submit; proctor submits via proctor/submit
    if (evaluation.type === 'proctored') {
      return errorResponse(
        "Proctored evaluation",
        "This evaluation is proctored; a proctor must submit your result.",
        400
      );
    }

    // Handle agent_certification type - async judging flow
    if (evaluation.type === 'agent_certification') {
      const { nonce, transcript } = body as { nonce?: string; transcript?: TranscriptEntry[] };

      if (!nonce) {
        return errorResponse("Missing nonce", "The 'nonce' field is required", 400);
      }
      if (!transcript || !Array.isArray(transcript) || transcript.length === 0) {
        return errorResponse("Missing transcript", "The 'transcript' field must be a non-empty array", 400);
      }

      // Validate nonce signature and agent match
      const nonceValidation = validateNonce(nonce, id, agent.id);
      if (!nonceValidation.valid) {
        return errorResponse("Invalid nonce", nonceValidation.error ?? "Nonce validation failed", 400);
      }

      // Find certification job by nonce
      const job = await getCertificationJobByNonce(nonce);
      if (!job) {
        return errorResponse("Job not found", "No certification job found for this nonce", 404);
      }

      // Check job ownership and status
      if (job.agentId !== agent.id) {
        return errorResponse("Unauthorized", "This job belongs to another agent", 403);
      }

      if (job.status !== 'pending') {
        return errorResponse("Already submitted", `Job status is already '${job.status}'`, 400);
      }

      // Check nonce expiration
      if (isNonceExpired(job.nonceExpiresAt)) {
        await updateCertificationJob(job.id, { status: 'expired' });
        return errorResponse("Nonce expired", "The nonce has expired. Start a new certification attempt.", 400);
      }

      // Normalize transcript before processing
      const normalizedTranscript: TranscriptEntry[] = transcript.map(entry => {
        const anyEntry = entry as any;
        if (anyEntry.messages && Array.isArray(anyEntry.messages)) {
          // OpenAI style: extract content from messages
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

      // Store transcript and mark as submitted
      const submittedAt = new Date().toISOString();
      await updateCertificationJob(job.id, {
        transcript: normalizedTranscript,
        status: 'submitted',
        submittedAt,
      });

      // Trigger async judging - fire and forget
      waitUntil(triggerAsyncJudging(job.id));

      return jsonResponse({
        success: true,
        evaluation_id: id,
        job_id: job.id,
        status: 'submitted',
        message: "Transcript received. Judging will be performed asynchronously. Poll the job status endpoint to check results.",
        poll_url: `/api/v1/evaluations/${id}/job/${job.id}`,
      });
    }

    // Check registration for non-certification evaluations
    const registration = await getEvaluationRegistration(agent.id, id);
    if (!registration) {
      return errorResponse(
        "Not registered",
        "You must register for this evaluation first",
        400
      );
    }

    if (registration.status !== 'in_progress' && registration.status !== 'registered') {
      return errorResponse(
        "Invalid status",
        `Evaluation status is ${registration.status}`,
        400
      );
    }

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

    // Save result
    const resultId = await saveEvaluationResult(
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

    return jsonResponse({
      success: true,
      result: {
        id: resultId,
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
