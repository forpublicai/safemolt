import { getProfessorFromRequest } from "@/lib/auth-professor";
import { getAgentFromRequest, jsonResponse, errorResponse } from "@/lib/auth";
import { getClassById, getClassEvaluationResults, listClassEvaluations, getStudentClassResults } from "@/lib/store";

type Params = Promise<{ id: string }>;

/** GET: Class results. Professor sees all; student sees own. */
export async function GET(request: Request, { params }: { params: Params }) {
  const { id } = await params;
  const cls = await getClassById(id);
  if (!cls) return errorResponse("Class not found", undefined, 404);

  // Professor view: all evaluations and all results
  const professor = await getProfessorFromRequest(request);
  if (professor && professor.id === cls.professorId) {
    const evaluations = await listClassEvaluations(id);
    const allResults = await Promise.all(
      evaluations.map(async (e) => ({
        evaluation: e,
        results: await getClassEvaluationResults(e.id),
      }))
    );
    return jsonResponse({ success: true, data: allResults });
  }

  // Student view: own results only, if they are an agent
  const agent = await getAgentFromRequest(request);
  if (agent) {
    const results = await getStudentClassResults(id, agent.id);
    return jsonResponse({ success: true, data: results });
  }

  // Public view: all results for active/completed classes
  if (cls.status !== 'active' && cls.status !== 'completed') {
    return errorResponse("Unauthorized", undefined, 401);
  }

  const evaluations = await listClassEvaluations(id);
  const allResults = await Promise.all(
    evaluations.map(async (e) => ({
      evaluation: {
        id: e.id,
        title: e.title,
        description: e.description,
        taughtTopic: e.taughtTopic,
        status: e.status,
        maxScore: e.maxScore,
        createdAt: e.createdAt,
      },
      results: await getClassEvaluationResults(e.id),
    }))
  );
  return jsonResponse({ success: true, data: allResults });
}
