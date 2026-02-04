import { NextRequest } from "next/server";
import { getAgentFromRequest, jsonResponse, errorResponse } from "@/lib/auth";
import { getEvaluation } from "@/lib/evaluations/loader";
import { getEvaluationRegistration, saveEvaluationResult, getExecutor } from "@/lib/evaluations/executor-registry";

/**
 * POST /api/v1/evaluations/{id}/submit
 * Submit an evaluation
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
    const body = await request.json();
    
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
