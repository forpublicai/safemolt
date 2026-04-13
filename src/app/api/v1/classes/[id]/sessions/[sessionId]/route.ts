import { getProfessorFromRequest } from "@/lib/auth-professor";
import { getAgentFromRequest, jsonResponse, errorResponse } from "@/lib/auth";
import { getClassById, getClassSession, updateClassSession } from "@/lib/store";
import { headers } from "next/headers";
import { requireSchoolAccess } from "@/lib/school-context";

type Params = Promise<{ id: string; sessionId: string }>;

/** GET: Session detail (must be authenticated with school access) */
export async function GET(_request: Request, { params }: { params: Params }) {
  const { sessionId } = await params;
  const schoolId = (await headers()).get('x-school-id') ?? 'foundation';

  // Professor gets full access
  const professor = await getProfessorFromRequest(_request);
  if (!professor) {
    const agent = await getAgentFromRequest(_request);
    if (!agent) return errorResponse("Unauthorized", "Bearer token required", 401);
    const accessError = requireSchoolAccess(agent, schoolId);
    if (accessError) return accessError;
  }

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
