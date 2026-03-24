import { getProfessorFromRequest } from "@/lib/auth-professor";
import { jsonResponse, errorResponse } from "@/lib/auth";
import { getClassById, getClassEvaluation, updateClassEvaluation } from "@/lib/store";

type Params = Promise<{ id: string; evalId: string }>;

/** GET: Evaluation detail */
export async function GET(request: Request, { params }: { params: Params }) {
  const { evalId } = await params;
  const evaluation = await getClassEvaluation(evalId);
  if (!evaluation) return errorResponse("Evaluation not found", undefined, 404);

  // Only professor sees full detail
  const professor = await getProfessorFromRequest(request);
  if (professor) {
    return jsonResponse({ success: true, data: evaluation });
  }

  // Others see limited view
  return jsonResponse({
    success: true,
    data: {
      id: evaluation.id,
      title: evaluation.title,
      description: evaluation.description,
      taughtTopic: evaluation.taughtTopic,
      status: evaluation.status,
      maxScore: evaluation.maxScore,
      createdAt: evaluation.createdAt,
    },
  });
}

/** PATCH: Update evaluation (professor only) */
export async function PATCH(request: Request, { params }: { params: Params }) {
  const { id, evalId } = await params;
  const professor = await getProfessorFromRequest(request);
  if (!professor) return errorResponse("Unauthorized", "Professor API key required", 401);

  const cls = await getClassById(id);
  if (!cls) return errorResponse("Class not found", undefined, 404);
  if (cls.professorId !== professor.id) return errorResponse("Forbidden", undefined, 403);

  const evaluation = await getClassEvaluation(evalId);
  if (!evaluation || evaluation.classId !== id) return errorResponse("Evaluation not found", undefined, 404);

  const body = await request.json();
  const updates: Parameters<typeof updateClassEvaluation>[1] = {};
  if (body.title !== undefined) updates.title = body.title;
  if (body.description !== undefined) updates.description = body.description;
  if (body.prompt !== undefined) updates.prompt = body.prompt;
  if (body.taught_topic !== undefined) updates.taughtTopic = body.taught_topic;
  if (body.status !== undefined) updates.status = body.status;
  if (body.max_score !== undefined) updates.maxScore = body.max_score;

  await updateClassEvaluation(evalId, updates);
  const updated = await getClassEvaluation(evalId);
  return jsonResponse({ success: true, data: updated });
}
