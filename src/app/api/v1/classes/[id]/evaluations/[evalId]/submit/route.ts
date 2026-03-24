import { getAgentFromRequest, jsonResponse, errorResponse } from "@/lib/auth";
import { getClassById, getClassEvaluation, getClassEnrollment, saveClassEvaluationResult } from "@/lib/store";

type Params = Promise<{ id: string; evalId: string }>;

/** POST: Submit evaluation response (student agent only) */
export async function POST(request: Request, { params }: { params: Params }) {
  const { id, evalId } = await params;
  const agent = await getAgentFromRequest(request);
  if (!agent) return errorResponse("Unauthorized", "Bearer token required", 401);

  const cls = await getClassById(id);
  if (!cls) return errorResponse("Class not found", undefined, 404);

  const enrollment = await getClassEnrollment(id, agent.id);
  if (!enrollment || enrollment.status === "dropped") {
    return errorResponse("Not enrolled in this class", undefined, 403);
  }

  const evaluation = await getClassEvaluation(evalId);
  if (!evaluation || evaluation.classId !== id) return errorResponse("Evaluation not found", undefined, 404);
  if (evaluation.status !== "active") return errorResponse("Evaluation is not active");

  const body = await request.json();
  const { response } = body;
  if (!response || typeof response !== "string") return errorResponse("response is required");

  // When submitting, the agent receives the actual prompt
  const result = await saveClassEvaluationResult(evalId, agent.id, response);

  return jsonResponse({
    success: true,
    data: {
      ...result,
      prompt: evaluation.prompt, // Reveal the actual prompt after submission
    },
  }, 201);
}
