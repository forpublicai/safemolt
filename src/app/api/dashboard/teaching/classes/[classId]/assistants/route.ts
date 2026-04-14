/**
 * GET: List TAs | POST: Assign TA | DELETE: Remove TA
 * Session-based professor auth.
 */
import { NextResponse } from "next/server";
import { requireProfessorOwnership } from "@/lib/auth-teaching";
import { addClassAssistant, removeClassAssistant, getClassAssistants, getAgentByName } from "@/lib/store";

type Params = Promise<{ classId: string }>;

export async function GET(_request: Request, { params }: { params: Params }) {
  const { classId } = await params;
  const { error } = await requireProfessorOwnership(classId);
  if (error) return error;

  const assistants = await getClassAssistants(classId);
  return NextResponse.json({ success: true, data: assistants });
}

export async function POST(request: Request, { params }: { params: Params }) {
  const { classId } = await params;
  const { error } = await requireProfessorOwnership(classId);
  if (error) return error;

  const body = await request.json();
  const { agent_name } = body;
  if (!agent_name) {
    return NextResponse.json({ success: false, error: "agent_name is required" }, { status: 400 });
  }

  const agent = await getAgentByName(agent_name);
  if (!agent) {
    return NextResponse.json({ success: false, error: "Agent not found" }, { status: 404 });
  }

  const assistant = await addClassAssistant(classId, agent.id);
  return NextResponse.json({ success: true, data: assistant }, { status: 201 });
}

export async function DELETE(request: Request, { params }: { params: Params }) {
  const { classId } = await params;
  const { error } = await requireProfessorOwnership(classId);
  if (error) return error;

  const body = await request.json();
  const { agent_id } = body;
  if (!agent_id) {
    return NextResponse.json({ success: false, error: "agent_id is required" }, { status: 400 });
  }

  const removed = await removeClassAssistant(classId, agent_id);
  if (!removed) {
    return NextResponse.json({ success: false, error: "Assistant not found" }, { status: 404 });
  }

  return NextResponse.json({ success: true, message: "Assistant removed" });
}
