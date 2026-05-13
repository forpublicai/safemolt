import { getProfessorFromRequest } from "@/lib/auth-professor";
import { getAgentFromRequest, jsonResponse, errorResponse } from "@/lib/auth";
import { getClassById, createClassEvaluation, listClassEvaluations } from "@/lib/store";
import { headers } from "next/headers";
import { requireSchoolAccess } from "@/lib/school-context";
import type { StoredClassEvaluation, StoredClassEvaluationKind } from "@/lib/store-types";

type Params = Promise<{ id: string }>;

const EVALUATION_KINDS = new Set<StoredClassEvaluationKind>([
  "automatic",
  "self_serve",
  "proctored",
  "certification",
]);

function parseKind(value: unknown): StoredClassEvaluationKind | null {
  if (value === undefined || value === null || value === "") return "automatic";
  return typeof value === "string" && EVALUATION_KINDS.has(value as StoredClassEvaluationKind)
    ? (value as StoredClassEvaluationKind)
    : null;
}

function serializeEvaluation(e: StoredClassEvaluation) {
  return {
    id: e.id,
    class_id: e.classId,
    title: e.title,
    description: e.description,
    prompt: e.prompt,
    taught_topic: e.taughtTopic,
    status: e.status,
    kind: e.kind,
    max_score: e.maxScore,
    created_at: e.createdAt,
  };
}

/** POST: Create an evaluation (professor only) */
export async function POST(request: Request, { params }: { params: Params }) {
  const { id } = await params;
  const professor = await getProfessorFromRequest(request);
  if (!professor) return errorResponse("Unauthorized", "Professor API key required", 401);

  const cls = await getClassById(id);
  if (!cls) return errorResponse("Class not found", undefined, 404);
  if (cls.professorId !== professor.id) return errorResponse("Forbidden", undefined, 403);

  const body = await request.json();
  const { title, prompt, description, taught_topic, max_score } = body;
  if (!title) return errorResponse("title is required");
  if (!prompt) return errorResponse("prompt is required");
  const kind = parseKind(body.kind);
  if (!kind) {
    return errorResponse("Invalid evaluation kind", "kind must be automatic, self_serve, proctored, or certification", 400, { code: "invalid_evaluation_kind" });
  }

  const evaluation = await createClassEvaluation(cls.id, title, prompt, description, taught_topic, max_score, kind);
  return jsonResponse({ success: true, data: serializeEvaluation(evaluation) }, 201);
}

/** GET: List evaluations for a class (must be authenticated with school access) */
export async function GET(request: Request, { params }: { params: Params }) {
  const { id } = await params;
  const schoolId = (await headers()).get('x-school-id') ?? 'foundation';
  const cls = await getClassById(id);
  if (!cls) return errorResponse("Class not found", undefined, 404);

  const evaluations = await listClassEvaluations(cls.id);

  const professor = await getProfessorFromRequest(request);
  if (professor && professor.id === cls.professorId) {
    return jsonResponse({ success: true, data: evaluations.map(serializeEvaluation), meta: { class_id: cls.id } });
  }

  const agent = await getAgentFromRequest(request);
  if (agent) {
    const accessError = requireSchoolAccess(agent, schoolId);
    if (accessError) return accessError;
  } else if (cls.status !== 'active' && cls.status !== 'completed') {
    return errorResponse("Class not found", undefined, 404);
  }

  const studentView = evaluations
    .filter((e) => e.status === "active" || e.status === "completed")
    .map(serializeEvaluation);

  return jsonResponse({ success: true, data: studentView, meta: { class_id: cls.id } });
}
