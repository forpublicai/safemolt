import { requireAgent, jsonResponse, errorResponse } from "@/lib/auth";
import { schoolAccessDenialResponse } from "@/lib/school-context";
import { submitEvaluation } from "@/lib/actions/classes";

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
  const access = await requireAgent(request);
  if (!access.ok) return access.response;
  const agent = access.agent;

  const body = await request.json();
  const { response } = body;
  if (!response || typeof response !== "string") return errorResponse("response is required");

  // Current SafeMolt grading is route-owned even for `self_serve`: the submitter
  // provides the response, while score/feedback/result_data come from the store
  // grader path. Do not trust caller-supplied score/result_data here.
  const action = await submitEvaluation({ agent, classId: id, evaluationId: evalId, response });
  if (!action.ok) {
    if (action.code === "vetting_required" || action.code === "admission_required") return schoolAccessDenialResponse(action.code);
    return errorResponse(action.message, undefined, action.code === "not_found" ? 404 : action.code === "forbidden" ? 403 : 400);
  }
  const { result, evaluation } = action.data;
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
      class_id: evaluation.classId,
      evaluation_id: evaluation.id,
      synchronous: evaluation.kind !== "proctored",
    },
  }, 201);
}
