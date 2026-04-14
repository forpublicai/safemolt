import { getProfessorFromRequest } from "@/lib/auth-professor";
import { getAgentFromRequest, jsonResponse, errorResponse } from "@/lib/auth";
import { createClass, listClasses, getClassEnrollmentCount, getClassAssistants } from "@/lib/store";
import { headers } from "next/headers";
import { requireSchoolAccess } from "@/lib/school-context";

/** POST: Create a class (professor only, school-scoped) */
export async function POST(request: Request) {
  const professor = await getProfessorFromRequest(request);
  if (!professor) return errorResponse("Unauthorized", "Professor API key required", 401);

  const schoolId = (await headers()).get('x-school-id') ?? "foundation";

  const body = await request.json();
  const { name, description, syllabus, hidden_objective, max_students } = body;
  if (!name || typeof name !== "string") {
    return errorResponse("Name is required");
  }

  const cls = await createClass(
    professor.id,
    name,
    description,
    syllabus,
    hidden_objective,
    max_students,
    schoolId
  );

  return jsonResponse({ success: true, data: cls }, 201);
}

/** GET: List classes. Professors see their own; agents see open classes. */
export async function GET(request: Request) {
  const schoolId = (await headers()).get('x-school-id') ?? "foundation";

  // Try professor auth first
  const professor = await getProfessorFromRequest(request);
  if (professor) {
    const classes = await listClasses({ professorId: professor.id, schoolId });
    const enriched = await Promise.all(
      classes.map(async (cls) => ({
        ...cls,
        enrollment_count: await getClassEnrollmentCount(cls.id),
        assistants: await getClassAssistants(cls.id),
      }))
    );
    return jsonResponse({ success: true, data: enriched });
  }

  // Public listing of open classes. Agent auth is optional — if provided,
  // enforce school access checks; otherwise allow public view of open classes.
  const agent = await getAgentFromRequest(request);
  if (agent) {
    const accessError = requireSchoolAccess(agent, schoolId);
    if (accessError) return accessError;
  }

  const classes = await listClasses({ enrollmentOpen: true, schoolId });
  const enriched = await Promise.all(
    classes.map(async (cls) => {
      const syllabus = (cls.syllabus ?? {}) as Record<string, unknown>;
      return {
        id: cls.id,
        name: cls.name,
        description: cls.description,
        status: cls.status,
        enrollmentOpen: cls.enrollmentOpen,
        maxStudents: cls.maxStudents,
        preview_image: typeof syllabus.preview_image === "string" ? syllabus.preview_image : undefined,
        enrollment_count: await getClassEnrollmentCount(cls.id),
        createdAt: cls.createdAt,
      };
    })
  );
  return jsonResponse({ success: true, data: enriched });
}
