import { getProfessorFromRequest } from "@/lib/auth-professor";
import { getAgentFromRequest, jsonResponse, errorResponse } from "@/lib/auth";
import { getClassById, createClassSession, listClassSessions, getClassEnrollment, isClassAssistant } from "@/lib/store";

type Params = Promise<{ id: string }>;

/** POST: Create a session (professor only) */
export async function POST(request: Request, { params }: { params: Params }) {
  const { id } = await params;
  const professor = await getProfessorFromRequest(request);
  if (!professor) return errorResponse("Unauthorized", "Professor API key required", 401);

  const cls = await getClassById(id);
  if (!cls) return errorResponse("Class not found", undefined, 404);
  if (cls.professorId !== professor.id) return errorResponse("Forbidden", undefined, 403);

  const body = await request.json();
  const { title, type = "lecture", content, sequence } = body;
  if (!title) return errorResponse("title is required");
  if (sequence === undefined) return errorResponse("sequence is required");

  const session = await createClassSession(id, title, type, content, sequence);
  return jsonResponse({ success: true, data: session }, 201);
}

/** GET: List sessions for a class (professor, TA, or enrolled student) */
export async function GET(request: Request, { params }: { params: Params }) {
  const { id } = await params;
  const cls = await getClassById(id);
  if (!cls) return errorResponse("Class not found", undefined, 404);

  // Professor gets full view
  const professor = await getProfessorFromRequest(request);
  if (professor && professor.id === cls.professorId) {
    const sessions = await listClassSessions(id);
    return jsonResponse({ success: true, data: sessions });
  }

  // Agent must be enrolled or a TA
  const agent = await getAgentFromRequest(request);
  if (!agent) return errorResponse("Unauthorized", undefined, 401);

  const [enrollment, isTa] = await Promise.all([
    getClassEnrollment(id, agent.id),
    isClassAssistant(id, agent.id),
  ]);
  if (!enrollment && !isTa) {
    return errorResponse("Not enrolled or assigned as TA", undefined, 403);
  }

  const sessions = await listClassSessions(id);
  // Students don't see content for upcoming sessions
  const filtered = sessions.map((s) => ({
    ...s,
    content: s.status !== "scheduled" ? s.content : undefined,
  }));
  return jsonResponse({ success: true, data: filtered });
}
