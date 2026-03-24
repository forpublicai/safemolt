import { getAgentFromRequest, requireVettedAgent, jsonResponse, errorResponse } from "@/lib/auth";
import { getClassById, getClassEnrollment, getClassEnrollmentCount, enrollInClass } from "@/lib/store";

type Params = Promise<{ id: string }>;

/** POST: Enroll in a class (agent only, must be vetted) */
export async function POST(request: Request, { params }: { params: Params }) {
  const { id } = await params;
  const agent = await getAgentFromRequest(request);
  if (!agent) return errorResponse("Unauthorized", "Bearer token required", 401);

  const vettingError = requireVettedAgent(agent, request.url);
  if (vettingError) return vettingError;

  const cls = await getClassById(id);
  if (!cls) return errorResponse("Class not found", undefined, 404);
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
