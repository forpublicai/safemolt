import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { isAdmissionsStaffForRequest } from "@/lib/admissions/authz";
import { updateClass } from "@/lib/store";

export async function POST(request: Request) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ success: false, error: "Unauthorized" }, { status: 401 });
  }
  if (!(await isAdmissionsStaffForRequest(session.user.id))) {
    return NextResponse.json({ success: false, error: "Forbidden" }, { status: 403 });
  }

  const body = await request.json();
  const { professor_id, class_id } = body;
  if (!professor_id || !class_id) {
    return NextResponse.json({ success: false, error: "professor_id and class_id are required" }, { status: 400 });
  }

  await updateClass(class_id, { professorId: professor_id });

  return NextResponse.json({ success: true, message: "Class assigned to professor" });
}
