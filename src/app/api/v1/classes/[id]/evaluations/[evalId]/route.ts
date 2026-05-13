import { getProfessorFromRequest } from "@/lib/auth-professor";
import { jsonResponse, errorResponse } from "@/lib/auth";
import { getClassById, getClassEvaluation, updateClassEvaluation } from "@/lib/store";
import type { StoredClassEvaluation, StoredClassEvaluationKind } from "@/lib/store-types";

type Params = Promise<{ id: string; evalId: string }>;

const EVALUATION_KINDS = new Set<StoredClassEvaluationKind>(["automatic", "self_serve", "proctored", "certification"]);

function serializeEvaluationDetail(evaluation: StoredClassEvaluation) {
  return {
    id: evaluation.id,
    class_id: evaluation.classId,
    title: evaluation.title,
    description: evaluation.description,
    taught_topic: evaluation.taughtTopic,
    prompt: evaluation.prompt,
    status: evaluation.status,
    kind: evaluation.kind,
    max_score: evaluation.maxScore,
    created_at: evaluation.createdAt,
  };
}

/** GET: Evaluation detail */
export async function GET(request: Request, { params }: { params: Params }) {
  const { id, evalId } = await params;
  const cls = await getClassById(id);
  if (!cls) return errorResponse("Class not found", undefined, 404);
  const evaluation = await getClassEvaluation(evalId);
  if (!evaluation || evaluation.classId !== cls.id) return errorResponse("Evaluation not found", undefined, 404);

  // Only professor sees full detail
  const professor = await getProfessorFromRequest(request);
  if (professor && professor.id === cls.professorId) {
    return jsonResponse({ success: true, data: serializeEvaluationDetail(evaluation), meta: { class_id: cls.id } });
  }

  return jsonResponse({
    success: true,
    data: serializeEvaluationDetail(evaluation),
    meta: { class_id: cls.id },
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
  if (!evaluation || evaluation.classId !== cls.id) return errorResponse("Evaluation not found", undefined, 404);

  const body = await request.json();
  const updates: Parameters<typeof updateClassEvaluation>[1] = {};
  if (body.title !== undefined) updates.title = body.title;
  if (body.description !== undefined) updates.description = body.description;
  if (body.prompt !== undefined) updates.prompt = body.prompt;
  if (body.taught_topic !== undefined) updates.taughtTopic = body.taught_topic;
  if (body.status !== undefined) updates.status = body.status;
  if (body.kind !== undefined) {
    if (typeof body.kind !== "string" || !EVALUATION_KINDS.has(body.kind as StoredClassEvaluationKind)) {
      return errorResponse("Invalid evaluation kind", "kind must be automatic, self_serve, proctored, or certification", 400, { code: "invalid_evaluation_kind" });
    }
    updates.kind = body.kind;
  }
  if (body.max_score !== undefined) updates.maxScore = body.max_score;

  await updateClassEvaluation(evalId, updates);
  const updated = await getClassEvaluation(evalId);
  if (!updated) return errorResponse("Evaluation not found", undefined, 404);
  return jsonResponse({ success: true, data: serializeEvaluationDetail(updated), meta: { class_id: cls.id } });
}
