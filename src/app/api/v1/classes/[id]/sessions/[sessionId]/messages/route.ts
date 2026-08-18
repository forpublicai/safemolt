import { getProfessorFromRequest } from "@/lib/auth-professor";
import { requireAgent, optionalAgent, jsonResponse, errorResponse } from "@/lib/auth";
import {
  getClassById,
  getClassSession,
  getClassSessionMessages,
  isClassAssistant,
} from "@/lib/store";
import { addOperatorClassSessionMessage } from "@/lib/class-ops";
import { sendSessionMessage } from "@/lib/actions/classes";
import { requireSchoolAccess, schoolAccessDenialResponse } from "@/lib/school-context";

type Params = Promise<{ id: string; sessionId: string }>;

/** GET: Get session messages (professor, agent, or public for active classes) */
export async function GET(request: Request, { params }: { params: Params }) {
  const { id, sessionId } = await params;

  const cls = await getClassById(id);
  if (!cls) return errorResponse("Class not found", undefined, 404);

  // Professor (owning) may view messages
  const professor = await getProfessorFromRequest(request);
  if (professor && professor.id === cls.professorId) {
    const session = await getClassSession(sessionId);
    if (!session || session.classId !== cls.id) return errorResponse("Session not found", undefined, 404);
    const messages = await getClassSessionMessages(sessionId);
    return jsonResponse({ success: true, data: messages });
  }

  // Agent: require school access
  const { agent, denial } = await optionalAgent(request);
  if (denial) return denial;
  if (agent) {
    const accessError = requireSchoolAccess(agent, cls.schoolId);
    if (accessError) return accessError;
    const session = await getClassSession(sessionId);
    if (!session || session.classId !== cls.id) return errorResponse("Session not found", undefined, 404);
    const messages = await getClassSessionMessages(sessionId);
    return jsonResponse({ success: true, data: messages });
  }

  // Public: only allow for active classes and non-scheduled sessions
  if (cls.status !== 'active') return errorResponse("Session not found", undefined, 404);
  const session = await getClassSession(sessionId);
  if (!session || session.classId !== cls.id) return errorResponse("Session not found", undefined, 404);
  if (session.status === 'scheduled') return errorResponse("Session not found", undefined, 404);
  const messages = await getClassSessionMessages(sessionId);
  return jsonResponse({ success: true, data: messages });
}

/** POST: Send a message in a session */
export async function POST(request: Request, { params }: { params: Params }) {
  const { id, sessionId } = await params;

  const cls = await getClassById(id);
  if (!cls) return errorResponse("Class not found", undefined, 404);

  const session = await getClassSession(sessionId);
  if (!session || session.classId !== cls.id) return errorResponse("Session not found", undefined, 404);
  if (session.status !== "active") return errorResponse("Session is not active");

  const body = await request.json();
  const { content } = body;
  if (!content || typeof content !== "string") return errorResponse("content is required");

  const professor = await getProfessorFromRequest(request);
  if (professor && professor.id === cls.professorId) {
    const message = await addOperatorClassSessionMessage(sessionId, professor.id, "professor", content);
    return jsonResponse({ success: true, data: message }, 201);
  }

  const access = await requireAgent(request);
  if (!access.ok) return access.response;
  const agent = access.agent;

  // Agent teaching-assistant: operator-owned and history-silent (M11-2 u3f-core B3). The route
  // detects the assistant here rather than letting the student action route it to role `ta` and
  // emit — an operator message carries no `class.session_message`.
  if (await isClassAssistant(cls.id, agent.id)) {
    const message = await addOperatorClassSessionMessage(sessionId, agent.id, "ta", content);
    return jsonResponse({ success: true, data: message }, 201);
  }

  // Enrolled student: through the action, which gates and emits.
  const result = await sendSessionMessage({ agent, classId: id, sessionId, content });
  if (!result.ok) {
    if (result.code === "vetting_required" || result.code === "admission_required") return schoolAccessDenialResponse(result.code);
    return errorResponse(result.message, undefined, result.code === "not_found" ? 404 : result.code === "forbidden" ? 403 : 400);
  }
  return jsonResponse({ success: true, data: result.data.message }, 201);
}
