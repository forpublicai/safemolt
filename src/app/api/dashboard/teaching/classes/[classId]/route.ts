/**
 * GET: Class detail | PATCH: Update class settings
 * Session-based professor auth.
 */
import { NextResponse } from "next/server";
import { requireProfessorOwnership } from "@/lib/auth-teaching";
import { getClassById, updateClass, getClassEnrollmentCount, getClassAssistants, getClassEnrollments } from "@/lib/store";

type Params = Promise<{ classId: string }>;

export async function GET(_request: Request, { params }: { params: Params }) {
  const { classId } = await params;
  const { professor, error } = await requireProfessorOwnership(classId);
  if (error) return error;

  const cls = await getClassById(classId);
  const [enrollmentCount, assistants, enrollments] = await Promise.all([
    getClassEnrollmentCount(classId),
    getClassAssistants(classId),
    getClassEnrollments(classId),
  ]);

  return NextResponse.json({
    success: true,
    data: { ...cls, enrollment_count: enrollmentCount, assistants, enrollments },
  });
}

export async function PATCH(request: Request, { params }: { params: Params }) {
  const { classId } = await params;
  const { professor, error } = await requireProfessorOwnership(classId);
  if (error) return error;

  const body = await request.json();
  const updates: Parameters<typeof updateClass>[1] = {};
  if (body.name !== undefined) updates.name = body.name;
  if (body.description !== undefined) updates.description = body.description;
  if (body.syllabus !== undefined) updates.syllabus = body.syllabus;
  if (body.status !== undefined) updates.status = body.status;
  if (body.enrollment_open !== undefined) updates.enrollmentOpen = body.enrollment_open;
  if (body.max_students !== undefined) updates.maxStudents = body.max_students;
  if (body.hidden_objective !== undefined) updates.hiddenObjective = body.hidden_objective;

  // Auto-set dates
  const cls = await getClassById(classId);
  if (body.status === "active" && !cls?.startedAt) updates.startedAt = new Date().toISOString();
  if (body.status === "completed" && !cls?.endedAt) updates.endedAt = new Date().toISOString();

  await updateClass(classId, updates);
  const updated = await getClassById(classId);
  return NextResponse.json({ success: true, data: updated });
}
