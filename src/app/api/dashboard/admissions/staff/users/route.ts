/**
 * GET: List all human users on the platform (staff only).
 */
import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { isAdmissionsStaffForRequest } from "@/lib/admissions/authz";
import { listAllHumanUsers } from "@/lib/human-users";
import { getProfessorByHumanUserId } from "@/lib/store";

export async function GET() {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ success: false, error: "Unauthorized" }, { status: 401 });
  }
  if (!(await isAdmissionsStaffForRequest(session.user.id))) {
    return NextResponse.json({ success: false, error: "Forbidden" }, { status: 403 });
  }

  const users = await listAllHumanUsers();
  const enriched = await Promise.all(
    users.map(async (u) => {
      const prof = await getProfessorByHumanUserId(u.id);
      return {
        id: u.id,
        email: u.email,
        name: u.name,
        createdAt: u.createdAt,
        isAdmissionsStaff: u.isAdmissionsStaff,
        isProfessor: Boolean(prof),
        professorId: prof?.id ?? null,
        professorName: prof?.name ?? null,
      };
    })
  );

  return NextResponse.json({ success: true, data: enriched });
}
