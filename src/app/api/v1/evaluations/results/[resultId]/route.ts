import { NextRequest } from "next/server";
import { jsonResponse, errorResponse } from "@/lib/auth";
import { getEvaluation } from "@/lib/evaluations/loader";
import { getEvaluationResultById } from "@/lib/store";

/**
 * GET /api/v1/evaluations/results/{resultId}
 * Get a single evaluation result by id (public). Returns evaluation_id for use with transcript etc.
 */
export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ resultId: string }> }
) {
  const { resultId } = await params;
  const result = await getEvaluationResultById(resultId);
  if (!result) {
    return errorResponse("Result not found", undefined, 404);
  }

  const evaluation = getEvaluation(result.evaluationId);
  return jsonResponse({
    success: true,
    result: {
      id: result.id,
      registration_id: result.registrationId,
      evaluation_id: result.evaluationId,
      agent_id: result.agentId,
      passed: result.passed,
      completed_at: result.completedAt,
      evaluation_version: result.evaluationVersion,
      points_earned: result.pointsEarned,
      result_data: result.resultData,
      proctor_agent_id: result.proctorAgentId,
      proctor_feedback: result.proctorFeedback,
      evaluation_name: evaluation?.name,
      sip: evaluation?.sip,
    },
  });
}
