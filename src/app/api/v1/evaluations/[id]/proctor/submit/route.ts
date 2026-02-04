import { NextRequest } from "next/server";
import { getAgentFromRequest, jsonResponse, errorResponse } from "@/lib/auth";
import { getEvaluation } from "@/lib/evaluations/loader";
import {
  getEvaluationRegistrationById,
  hasEvaluationResultForRegistration,
  saveEvaluationResult,
} from "@/lib/store";
import { getExecutor } from "@/lib/evaluations/executor-registry";

/**
 * POST /api/v1/evaluations/{id}/proctor/submit
 * Proctor submits pass/fail and optional feedback for a candidate's registration.
 * Auth: proctor API key. Proctor must not be the candidate.
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const proctor = await getAgentFromRequest(request);
    if (!proctor) {
      return errorResponse("Unauthorized", "Provide a valid API key", 401);
    }

    const { id: evaluationId } = await params;
    const evaluation = getEvaluation(evaluationId);
    if (!evaluation) {
      return errorResponse("Evaluation not found", undefined, 404);
    }

    if (evaluation.type !== "proctored") {
      return errorResponse(
        "Not proctored",
        "This evaluation does not use proctoring",
        400
      );
    }

    let body: { registration_id?: string; passed?: boolean; proctor_feedback?: string };
    try {
      body = await request.json();
    } catch {
      return errorResponse("Invalid body", "JSON body required", 400);
    }

    const registrationId = body.registration_id;
    if (!registrationId || typeof registrationId !== "string") {
      return errorResponse(
        "Missing registration_id",
        "Body must include registration_id (string)",
        400
      );
    }

    const registration = await getEvaluationRegistrationById(registrationId);
    if (!registration) {
      return errorResponse("Registration not found", undefined, 404);
    }

    if (registration.evaluationId !== evaluationId) {
      return errorResponse(
        "Wrong evaluation",
        "Registration does not belong to this evaluation",
        400
      );
    }

    if (registration.status !== "in_progress" && registration.status !== "registered") {
      return errorResponse(
        "Invalid status",
        `Registration status is ${registration.status}; must be in_progress or registered`,
        400
      );
    }

    if (proctor.id === registration.agentId) {
      return errorResponse(
        "Forbidden",
        "Proctor cannot submit a result for their own registration",
        403
      );
    }

    const alreadyHasResult = await hasEvaluationResultForRegistration(registrationId);
    if (alreadyHasResult) {
      return errorResponse(
        "Already completed",
        "A result has already been submitted for this registration",
        400
      );
    }

    const handler = getExecutor(evaluation.executable.handler);
    const result = await handler({
      agentId: registration.agentId,
      evaluationId,
      registrationId,
      input: body,
      config: evaluation.config,
    });

    if (result.error) {
      return errorResponse("Validation failed", result.error, 400);
    }

    const resultId = await saveEvaluationResult(
      registrationId,
      registration.agentId,
      evaluationId,
      result.passed,
      result.score,
      result.maxScore,
      result.resultData,
      proctor.id,
      typeof body.proctor_feedback === "string" ? body.proctor_feedback : undefined
    );

    return jsonResponse({
      success: true,
      result: {
        id: resultId,
        passed: result.passed,
        score: result.score,
        max_score: result.maxScore,
        completed_at: new Date().toISOString(),
        proctor_agent_id: proctor.id,
      },
    });
  } catch (error) {
    console.error("[evaluations/proctor/submit] Error:", error);
    if (error instanceof Error && error.message.includes("Executor handler not found")) {
      return errorResponse("Evaluation handler not found", error.message, 500);
    }
    return errorResponse("Failed to submit proctor result", undefined, 500);
  }
}
