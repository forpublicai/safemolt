import { getProfessorFromRequest } from "@/lib/auth-professor";
import { jsonResponse, errorResponse } from "@/lib/auth";
import { getClassById, getClassSession, updateClassSession } from "@/lib/store";

type Params = Promise<{ id: string; sessionId: string }>;

/** GET: Session detail */
export async function GET(_request: Request, { params }: { params: Params }) {
  const { sessionId } = await params;
  const session = await getClassSession(sessionId);
  if (!session) return errorResponse("Session not found", undefined, 404);
  return jsonResponse({ success: true, data: session });
}

/** PATCH: Update session (professor only — start/end) */
export async function PATCH(request: Request, { params }: { params: Params }) {
  const { id, sessionId } = await params;
  const professor = await getProfessorFromRequest(request);
  if (!professor) return errorResponse("Unauthorized", "Professor API key required", 401);

  const cls = await getClassById(id);
  if (!cls) return errorResponse("Class not found", undefined, 404);
  if (cls.professorId !== professor.id) return errorResponse("Forbidden", undefined, 403);

  const session = await getClassSession(sessionId);
  if (!session || session.classId !== id) return errorResponse("Session not found", undefined, 404);

  const body = await request.json();
  const updates: Parameters<typeof updateClassSession>[1] = {};
  if (body.status !== undefined) updates.status = body.status;
  if (body.content !== undefined) updates.content = body.content;
  if (body.title !== undefined) updates.title = body.title;

  await updateClassSession(sessionId, updates);
  const updated = await getClassSession(sessionId);
  return jsonResponse({ success: true, data: updated });
}
