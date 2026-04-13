import { getProfessorFromRequest } from "@/lib/auth-professor";
import { getAgentFromRequest, jsonResponse, errorResponse } from "@/lib/auth";
import { headers } from "next/headers";
import { requireSchoolAccess } from "@/lib/school-context";
import { getClassById, getClassEnrollments, listAgents } from "@/lib/store";

type Params = Promise<{ id: string }>;

/** Helper: Enrich enrollments with agent data via batch load (all agents at once) */
async function enrichEnrollments(enrollments: Awaited<ReturnType<typeof getClassEnrollments>>) {
  // Batch-load all agents once instead of N+1 queries
  const agents = await listAgents();
  const agentMap = new Map(agents.map(a => [a.id, a]));

  return enrollments.map((e) => {
    const a = agentMap.get(e.agentId);
    return {
      id: e.id,
      status: e.status,
      enrolledAt: e.enrolledAt,
      completedAt: e.completedAt,
      agent: a
        ? { id: a.id, name: a.name, displayName: a.displayName, avatarUrl: a.avatarUrl }
        : { id: e.agentId, name: "Unknown Agent" },
    };
  });
}

/** GET: List enrollments for a class (professor, agent with school access, or public for active classes) */
export async function GET(request: Request, { params }: { params: Params }) {
  const { id } = await params;
  const schoolId = (await headers()).get('x-school-id') ?? 'foundation';

  const cls = await getClassById(id);
  if (!cls) return errorResponse("Class not found", undefined, 404);

  // All callers get enrollments; professor sees all, agent/public see active/enrolled only
  const enrollments = await getClassEnrollments(id);

  // Professor (owning) gets full list
  const professor = await getProfessorFromRequest(request);
  if (professor && professor.id === cls.professorId) {
    const enriched = await enrichEnrollments(enrollments);
    return jsonResponse({ success: true, data: enriched });
  }

  // Filter to active/enrolled only for agent and public
  const activeEnrollments = enrollments.filter((e) => e.status === 'enrolled' || e.status === 'active');

  // Agent with school access can view enrolled students
  const agent = await getAgentFromRequest(request);
  if (agent) {
    const accessError = requireSchoolAccess(agent, schoolId);
    if (accessError) return accessError;

    const enriched = await enrichEnrollments(activeEnrollments);
    return jsonResponse({ success: true, data: enriched });
  }

  // Public: only allow for active classes
  if (cls.status !== 'active') return errorResponse("Class not found", undefined, 404);
  const enriched = await enrichEnrollments(activeEnrollments);
  return jsonResponse({ success: true, data: enriched });
}
