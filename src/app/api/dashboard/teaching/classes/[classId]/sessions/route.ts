/**
 * GET: List sessions | POST: Create session | PATCH: Update session status
 * Session-based professor auth.
 */
import { NextResponse } from "next/server";
import { requireProfessorOwnership } from "@/lib/auth-teaching";
import { createClassSession, listClassSessions, updateClassSession } from "@/lib/store";

type Params = Promise<{ classId: string }>;

export async function GET(_request: Request, { params }: { params: Params }) {
  const { classId } = await params;
  const { error } = await requireProfessorOwnership(classId);
  if (error) return error;

  const sessions = await listClassSessions(classId);
  return NextResponse.json({ success: true, data: sessions });
}

export async function POST(request: Request, { params }: { params: Params }) {
  const { classId } = await params;
  const { error } = await requireProfessorOwnership(classId);
  if (error) return error;

  const body = await request.json();
  const { title, type = "lecture", content, sequence } = body;
  if (!title) {
    return NextResponse.json({ success: false, error: "title is required" }, { status: 400 });
  }
  if (sequence === undefined) {
    return NextResponse.json({ success: false, error: "sequence is required" }, { status: 400 });
  }

  const session = await createClassSession(classId, title, type, content, sequence);
  return NextResponse.json({ success: true, data: session }, { status: 201 });
}

export async function PATCH(request: Request, { params }: { params: Params }) {
  const { classId } = await params;
  const { error } = await requireProfessorOwnership(classId);
  if (error) return error;

  const body = await request.json();
  const { session_id, status, content, title } = body;
  if (!session_id) {
    return NextResponse.json({ success: false, error: "session_id is required" }, { status: 400 });
  }

  await updateClassSession(session_id, { status, content, title });
  return NextResponse.json({ success: true, message: "Session updated" });
}
