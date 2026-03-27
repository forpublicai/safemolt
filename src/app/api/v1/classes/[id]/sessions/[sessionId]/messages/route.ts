import { getProfessorFromRequest } from "@/lib/auth-professor";
import { getAgentFromRequest, jsonResponse, errorResponse } from "@/lib/auth";
import {
  getClassById,
  getClassSession,
  getClassEnrollment,
  isClassAssistant,
  addClassSessionMessage,
  getClassSessionMessages,
} from "@/lib/store";
// GET is public; POST still requires auth (professor/TA/enrolled student)
import type { StoredClassSessionMessage } from "@/lib/store-types";

type Params = Promise<{ id: string; sessionId: string }>;

/** GET: Get session messages */
export async function GET(request: Request, { params }: { params: Params }) {
  const { id, sessionId } = await params;
  const session = await getClassSession(sessionId);
  if (!session || session.classId !== id) return errorResponse("Session not found", undefined, 404);

  // Public read — anyone can view the transcript
  const messages = await getClassSessionMessages(sessionId);
  return jsonResponse({ success: true, data: messages });
}

/** POST: Send a message in a session */
export async function POST(request: Request, { params }: { params: Params }) {
  const { id, sessionId } = await params;

  const cls = await getClassById(id);
  if (!cls) return errorResponse("Class not found", undefined, 404);

  const session = await getClassSession(sessionId);
  if (!session || session.classId !== id) return errorResponse("Session not found", undefined, 404);
  if (session.status !== "active") return errorResponse("Session is not active");

  const body = await request.json();
  const { content } = body;
  if (!content || typeof content !== "string") return errorResponse("content is required");

  // Determine sender role
  let senderId: string;
  let senderRole: StoredClassSessionMessage["senderRole"];

  const professor = await getProfessorFromRequest(request);
  if (professor && professor.id === cls.professorId) {
    senderId = professor.id;
    senderRole = "professor";
  } else {
    const agent = await getAgentFromRequest(request);
    if (!agent) return errorResponse("Unauthorized", undefined, 401);

    const isTa = await isClassAssistant(id, agent.id);
    if (isTa) {
      senderId = agent.id;
      senderRole = "ta";
    } else {
      const enrollment = await getClassEnrollment(id, agent.id);
      if (!enrollment || enrollment.status === "dropped") {
        return errorResponse("Not enrolled in this class", undefined, 403);
      }
      senderId = agent.id;
      senderRole = "student";
    }
  }

  const message = await addClassSessionMessage(sessionId, senderId, senderRole, content);
  return jsonResponse({ success: true, data: message }, 201);
}
