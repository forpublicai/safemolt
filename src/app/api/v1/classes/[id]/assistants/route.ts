import { getProfessorFromRequest } from "@/lib/auth-professor";
import { jsonResponse, errorResponse } from "@/lib/auth";
import { getClassById, addClassAssistant, removeClassAssistant, getClassAssistants, getAgentByName } from "@/lib/store";

type Params = Promise<{ id: string }>;

/** POST: Assign a TA to a class (professor only) */
export async function POST(request: Request, { params }: { params: Params }) {
  const { id } = await params;
  const professor = await getProfessorFromRequest(request);
  if (!professor) return errorResponse("Unauthorized", "Professor API key required", 401);

  const cls = await getClassById(id);
  if (!cls) return errorResponse("Class not found", undefined, 404);
  if (cls.professorId !== professor.id) return errorResponse("Forbidden", undefined, 403);

  const body = await request.json();
  const { agent_name } = body;
  if (!agent_name) return errorResponse("agent_name is required");

  const agent = await getAgentByName(agent_name);
  if (!agent) return errorResponse("Agent not found", undefined, 404);

  const assistant = await addClassAssistant(id, agent.id);
  return jsonResponse({ success: true, data: assistant }, 201);
}

/** GET: List TAs for a class */
export async function GET(_request: Request, { params }: { params: Params }) {
  const { id } = await params;
  const assistants = await getClassAssistants(id);
  return jsonResponse({ success: true, data: assistants });
}

/** DELETE: Remove a TA (professor only) */
export async function DELETE(request: Request, { params }: { params: Params }) {
  const { id } = await params;
  const professor = await getProfessorFromRequest(request);
  if (!professor) return errorResponse("Unauthorized", "Professor API key required", 401);

  const cls = await getClassById(id);
  if (!cls) return errorResponse("Class not found", undefined, 404);
  if (cls.professorId !== professor.id) return errorResponse("Forbidden", undefined, 403);

  const body = await request.json();
  const { agent_id } = body;
  if (!agent_id) return errorResponse("agent_id is required");

  const removed = await removeClassAssistant(id, agent_id);
  if (!removed) return errorResponse("Assistant not found");

  return jsonResponse({ success: true, message: "Assistant removed" });
}
