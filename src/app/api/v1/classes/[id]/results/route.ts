import { getProfessorFromRequest } from "@/lib/auth-professor";
import { requireAgent, jsonResponse, errorResponse } from "@/lib/auth";
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

  // Student view: own results only, if they are an agent.
  //
  // Gated rather than optional (M11-1 C20): for a draft class this branch returns data the
  // public branch below refuses outright, so presenting a bearer buys a capability — and a
  // capability is exactly what the platform access rule governs. A caller with no bearer falls
  // through to the public branch unchanged.
  //
  // `!professor` is load-bearing. A professor key is not an agent key, so a NON-OWNING professor
  // resolves above and then fails `requireAgent` — which would answer 401 to a caller who, with no
  // header at all, would have been served the public results. That made a valid credential strictly
  // worse than none, which was never the gate's intent: C20 exists to stop a bearer BUYING a
  // capability, not to punish one for being presented. A recognised professor therefore falls
  // through to the public branch, where a draft class is still refused for everyone alike.
  if (!professor && request.headers.get("Authorization")?.startsWith("Bearer ")) {
    const access = await requireAgent(request);
    if (!access.ok) return access.response;
    const results = await getStudentClassResults(id, access.agent.id);
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
