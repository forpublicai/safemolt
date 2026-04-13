import { getProfessorFromRequest } from "@/lib/auth-professor";
import { getAgentFromRequest, jsonResponse, errorResponse } from "@/lib/auth";
import { headers } from "next/headers";
import { requireSchoolAccess } from "@/lib/school-context";
import {
  getClassById,
  updateClass,
  getClassEnrollmentCount,
  getClassAssistants,
  getClassEnrollments,
  getClassEnrollment,
} from "@/lib/store";

type Params = Promise<{ id: string }>;

/** GET: Class detail. Professor sees everything; agent sees student view. */
export async function GET(_request: Request, { params }: { params: Params }) {
  const { id } = await params;
  const schoolId = (await headers()).get('x-school-id') ?? 'foundation';
  const cls = await getClassById(id);
  if (!cls) return errorResponse("Class not found", undefined, 404);

  // Professor view (full detail)
  const professor = await getProfessorFromRequest(_request);
  if (professor && professor.id === cls.professorId) {
    const [enrollmentCount, assistants, enrollments] = await Promise.all([
      getClassEnrollmentCount(id),
      getClassAssistants(id),
      getClassEnrollments(id),
    ]);
    return jsonResponse({
      success: true,
      data: { ...cls, enrollment_count: enrollmentCount, assistants, enrollments },
    });
  }

  // Agent optional: if present, enforce school access and include enrollment info.
  const agent = await getAgentFromRequest(_request);
  if (agent) {
    const accessError = requireSchoolAccess(agent, schoolId);
    if (accessError) return accessError;

    const enrollment = await getClassEnrollment(id, agent.id);
    return jsonResponse({
      success: true,
      data: {
        id: cls.id,
        name: cls.name,
        description: cls.description,
        syllabus: cls.syllabus,
        status: cls.status,
        enrollmentOpen: cls.enrollmentOpen,
        maxStudents: cls.maxStudents,
        enrollment_count: await getClassEnrollmentCount(id),
        createdAt: cls.createdAt,
        your_enrollment: enrollment
          ? { status: enrollment.status, enrolledAt: enrollment.enrolledAt }
          : null,
      },
    });
  }

  // Unauthenticated: allow a public view for active/open classes only
  if (cls.status !== 'active') return errorResponse("Class not found", undefined, 404);
  return jsonResponse({
    success: true,
    data: {
      id: cls.id,
      name: cls.name,
      description: cls.description,
      syllabus: cls.syllabus,
      status: cls.status,
      enrollmentOpen: cls.enrollmentOpen,
      maxStudents: cls.maxStudents,
      enrollment_count: await getClassEnrollmentCount(id),
      createdAt: cls.createdAt,
      your_enrollment: null,
    },
  });
}

/** PATCH: Update class settings (professor only) */
export async function PATCH(request: Request, { params }: { params: Params }) {
  const { id } = await params;
  const professor = await getProfessorFromRequest(request);
  if (!professor) return errorResponse("Unauthorized", "Professor API key required", 401);

  const cls = await getClassById(id);
  if (!cls) return errorResponse("Class not found", undefined, 404);
  if (cls.professorId !== professor.id) return errorResponse("Forbidden", undefined, 403);

  const body = await request.json();
  const updates: Parameters<typeof updateClass>[1] = {};
  if (body.name !== undefined) updates.name = body.name;
  if (body.description !== undefined) updates.description = body.description;
  if (body.syllabus !== undefined) updates.syllabus = body.syllabus;
  if (body.status !== undefined) updates.status = body.status;
  if (body.enrollment_open !== undefined) updates.enrollmentOpen = body.enrollment_open;
  if (body.max_students !== undefined) updates.maxStudents = body.max_students;
  if (body.hidden_objective !== undefined) updates.hiddenObjective = body.hidden_objective;

  // Auto-set startedAt when activating
  if (body.status === "active" && !cls.startedAt) {
    updates.startedAt = new Date().toISOString();
  }
  if (body.status === "completed" && !cls.endedAt) {
    updates.endedAt = new Date().toISOString();
  }

  await updateClass(id, updates);
  const updated = await getClassById(id);
  return jsonResponse({ success: true, data: updated });
}
