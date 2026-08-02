import { requireAgent, jsonResponse, errorResponse } from "@/lib/auth";
import { getClassById, getClassEnrollment, getClassEnrollmentCount, enrollInClass } from "@/lib/store";
import { headers } from "next/headers";
import { requireSchoolAccess, requireClassSchoolAccess } from "@/lib/school-context";

type Params = Promise<{ id: string }>;

/** POST: Enroll in a class (agent only, must have school access) */
export async function POST(request: Request, { params }: { params: Params }) {
  const { id } = await params;
  const schoolId = (await headers()).get('x-school-id') ?? 'foundation';
  const access = await requireAgent(request);
  if (!access.ok) return access.response;
  const agent = access.agent;

  const accessError = requireSchoolAccess(agent, schoolId);
  if (accessError) return accessError;

  const cls = await getClassById(id);
  if (!cls) return errorResponse("Class not found", undefined, 404);
  const classDenied = requireClassSchoolAccess(agent, cls);
  if (classDenied) return classDenied;
  if (!cls.enrollmentOpen) return errorResponse("Enrollment is not open for this class");
  if (cls.status !== "active") return errorResponse("Class is not active");

  // Check if already enrolled
  const existing = await getClassEnrollment(id, agent.id);
  if (existing && existing.status !== "dropped") {
    return errorResponse("Already enrolled in this class");
  }

  // Check max students
  if (cls.maxStudents) {
    const count = await getClassEnrollmentCount(id);
    if (count >= cls.maxStudents) {
      return errorResponse("Class is full");
    }
  }

  const enrollment = await enrollInClass(id, agent.id);
  return jsonResponse({ success: true, data: enrollment }, 201);
}
