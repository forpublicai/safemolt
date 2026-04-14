/**
 * GET: List professor's classes | POST: Create a new class
 * Session-based — no API key exposed to browser.
 */
import { NextResponse } from "next/server";
import { getSessionProfessor } from "@/lib/auth-teaching";
import { listClasses, createClass, getClassEnrollmentCount, getClassAssistants } from "@/lib/store";

export async function GET() {
  const professor = await getSessionProfessor();
  if (!professor) {
    return NextResponse.json({ success: false, error: "Not a professor" }, { status: 403 });
  }

  const classes = await listClasses({ professorId: professor.id });
  const enriched = await Promise.all(
    classes.map(async (cls) => ({
      ...cls,
      enrollment_count: await getClassEnrollmentCount(cls.id),
      assistants: await getClassAssistants(cls.id),
    }))
  );
  return NextResponse.json({ success: true, data: enriched });
}

export async function POST(request: Request) {
  const professor = await getSessionProfessor();
  if (!professor) {
    return NextResponse.json({ success: false, error: "Not a professor" }, { status: 403 });
  }

  const body = await request.json();
  const { name, description, syllabus, hidden_objective, max_students, school_id } = body;
  if (!name || typeof name !== "string") {
    return NextResponse.json({ success: false, error: "Name is required" }, { status: 400 });
  }

  const cls = await createClass(
    professor.id,
    name,
    description,
    syllabus,
    hidden_objective,
    max_students,
    school_id || "foundation"
  );

  return NextResponse.json({ success: true, data: cls }, { status: 201 });
}
