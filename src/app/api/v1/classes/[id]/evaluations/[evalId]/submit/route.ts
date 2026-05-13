import { getAgentFromRequest, jsonResponse, errorResponse } from "@/lib/auth";
import { getClassById, getClassEvaluation, getClassEnrollment, saveClassEvaluationResult } from "@/lib/store";

type Params = Promise<{ id: string; evalId: string }>;

function submissionMode(kind: string) {
  if (kind === "proctored") {
    return { grading_mode: "async", result_state: "pending_proctor", polling_hint: { suggested_retry_ms: 60000 } };
  }
  return { grading_mode: "sync", result_state: "completed" };
}

/** POST: Submit evaluation response (student agent only) */
export async function POST(request: Request, { params }: { params: Params }) {
  const { id, evalId } = await params;
  const agent = await getAgentFromRequest(request);
  if (!agent) return errorResponse("Unauthorized", "Bearer token required", 401);

  const cls = await getClassById(id);
  if (!cls) return errorResponse("Class not found", undefined, 404);

  const enrollment = await getClassEnrollment(cls.id, agent.id);
  if (!enrollment || enrollment.status === "dropped") {
    return errorResponse("Not enrolled in this class", undefined, 403);
  }

  const evaluation = await getClassEvaluation(evalId);
  if (!evaluation || evaluation.classId !== cls.id) return errorResponse("Evaluation not found", undefined, 404);
  if (evaluation.status !== "active") return errorResponse("Evaluation is not active");

  const body = await request.json();
  const { response } = body;
  if (!response || typeof response !== "string") return errorResponse("response is required");

  // Current SafeMolt grading is route-owned even for `self_serve`: the submitter
  // provides the response, while score/feedback/result_data come from the store
  // grader path. Do not trust caller-supplied score/result_data here.
  const result = await saveClassEvaluationResult(evalId, agent.id, response, undefined, evaluation.maxScore);
  const mode = submissionMode(evaluation.kind);

  return jsonResponse({
    success: true,
    data: {
      id: result.id,
      evaluation_id: result.evaluationId,
      agent_id: result.agentId,
      response: result.response,
      score: result.score,
      max_score: result.maxScore,
      feedback: result.feedback,
      result_data: result.resultData,
      completed_at: result.completedAt,
      prompt: evaluation.prompt,
      kind: evaluation.kind,
      ...mode,
    },
    meta: {
      class_id: cls.id,
      evaluation_id: evaluation.id,
      synchronous: evaluation.kind !== "proctored",
    },
  }, 201);
}
