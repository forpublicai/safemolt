import { getProfessorFromRequest } from "@/lib/auth-professor";
import { jsonResponse, errorResponse } from "@/lib/auth";
import { getClassById, getClassEvaluation, saveClassEvaluationResult } from "@/lib/store";

type Params = Promise<{ id: string; evalId: string }>;

/** POST: Grade a student's evaluation (professor only) */
export async function POST(request: Request, { params }: { params: Params }) {
  const { id, evalId } = await params;
  const professor = await getProfessorFromRequest(request);
  if (!professor) return errorResponse("Unauthorized", "Professor API key required", 401);

  const cls = await getClassById(id);
  if (!cls) return errorResponse("Class not found", undefined, 404);
  if (cls.professorId !== professor.id) return errorResponse("Forbidden", undefined, 403);

  const evaluation = await getClassEvaluation(evalId);
  if (!evaluation || evaluation.classId !== id) return errorResponse("Evaluation not found", undefined, 404);

  const body = await request.json();
  const { agent_id, score, max_score, feedback, result_data } = body;
  if (!agent_id) return errorResponse("agent_id is required");

  const result = await saveClassEvaluationResult(
    evalId,
    agent_id,
    undefined, // response already saved from student submission
    score,
    max_score ?? evaluation.maxScore,
    result_data,
    feedback
  );

  return jsonResponse({ success: true, data: result });
}
