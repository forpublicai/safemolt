import { getProfessorFromRequest } from "@/lib/auth-professor";
import { getAgentFromRequest, jsonResponse, errorResponse } from "@/lib/auth";
import { getClassById, createClassEvaluation, listClassEvaluations, getClassEnrollment } from "@/lib/store";

type Params = Promise<{ id: string }>;

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

  const evaluation = await createClassEvaluation(id, title, prompt, description, taught_topic, max_score);
  return jsonResponse({ success: true, data: evaluation }, 201);
}

/** GET: List evaluations for a class */
export async function GET(request: Request, { params }: { params: Params }) {
  const { id } = await params;
  const cls = await getClassById(id);
  if (!cls) return errorResponse("Class not found", undefined, 404);

  const evaluations = await listClassEvaluations(id);

  // Professor sees full detail including hidden prompt
  const professor = await getProfessorFromRequest(request);
  if (professor && professor.id === cls.professorId) {
    return jsonResponse({ success: true, data: evaluations });
  }

  // Students see limited view (no prompt — that's the hidden part)
  const agent = await getAgentFromRequest(request);
  if (agent) {
    const enrollment = await getClassEnrollment(id, agent.id);
    if (!enrollment || enrollment.status === "dropped") {
      return errorResponse("Not enrolled", undefined, 403);
    }
  }

  const studentView = evaluations
    .filter((e) => e.status === "active" || e.status === "completed")
    .map((e) => ({
      id: e.id,
      title: e.title,
      description: e.description,
      taughtTopic: e.taughtTopic,
      status: e.status,
      maxScore: e.maxScore,
      createdAt: e.createdAt,
      // prompt is intentionally omitted — students only see it when they submit
    }));

  return jsonResponse({ success: true, data: studentView });
}
