/**
 * POST: Assign professor privilege to a human user.
 * GET: List all professors.
 * DELETE: Remove professor privilege from a human user.
 * Staff only.
 */
import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { isAdmissionsStaffForRequest } from "@/lib/admissions/authz";
import { getHumanUserById } from "@/lib/human-users";
import {
  createProfessorForHumanUser,
  getProfessorByHumanUserId,
  listAllProfessors,
  addSchoolProfessor,
} from "@/lib/store";

export async function GET() {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ success: false, error: "Unauthorized" }, { status: 401 });
  }
  if (!(await isAdmissionsStaffForRequest(session.user.id))) {
    return NextResponse.json({ success: false, error: "Forbidden" }, { status: 403 });
  }

  const professors = await listAllProfessors();
  return NextResponse.json({
    success: true,
    data: professors.map((p) => ({
      id: p.id,
      name: p.name,
      email: p.email,
      humanUserId: p.humanUserId,
      createdAt: p.createdAt,
    })),
  });
}

export async function POST(request: Request) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ success: false, error: "Unauthorized" }, { status: 401 });
  }
  if (!(await isAdmissionsStaffForRequest(session.user.id))) {
    return NextResponse.json({ success: false, error: "Forbidden" }, { status: 403 });
  }

  const body = await request.json();
  const { user_id, school_id } = body;
  if (!user_id) {
    return NextResponse.json({ success: false, error: "user_id is required" }, { status: 400 });
  }

  const user = await getHumanUserById(user_id);
  if (!user) {
    return NextResponse.json({ success: false, error: "User not found" }, { status: 404 });
  }

  // Check if already a professor
  const existing = await getProfessorByHumanUserId(user_id);
  if (existing) {
    // Just add to school if school_id provided
    if (school_id) {
      await addSchoolProfessor(school_id, existing.id);
    }
    return NextResponse.json({
      success: true,
      data: { id: existing.id, name: existing.name, already_existed: true },
    });
  }

  const professor = await createProfessorForHumanUser(
    user_id,
    user.name || user.email || "Professor",
    user.email || undefined
  );

  // Add to school if specified
  if (school_id) {
    await addSchoolProfessor(school_id, professor.id);
  }

  return NextResponse.json({
    success: true,
    data: { id: professor.id, name: professor.name },
  }, { status: 201 });
}
