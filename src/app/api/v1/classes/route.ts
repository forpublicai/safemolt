import { getProfessorFromRequest } from "@/lib/auth-professor";
import { optionalAgent, jsonResponse, errorResponse } from "@/lib/auth";
import { createClass, listClasses, getClassEnrollmentCount, getClassAssistants } from "@/lib/store";
import { headers } from "next/headers";
import { requireSchoolAccess } from "@/lib/school-context";
import { toIsoOrEmpty } from "@/lib/iso-date";
import type { StoredClass } from "@/lib/store-types";

async function serializeClassSummary(cls: StoredClass) {
  const syllabus = (cls.syllabus ?? {}) as Record<string, unknown>;
  const createdAt = toIsoOrEmpty(cls.createdAt);
  return {
    id: cls.id,
    slug: cls.slug,
    name: cls.name,
    description: cls.description,
    status: cls.status,
    enrollment_open: cls.enrollmentOpen,
    max_students: cls.maxStudents,
    preview_image: typeof syllabus.preview_image === "string" ? syllabus.preview_image : undefined,
    enrollment_count: await getClassEnrollmentCount(cls.id),
    created_at: createdAt,
    // Legacy aliases kept for current UI/API clients while agents migrate to snake_case.
    enrollmentOpen: cls.enrollmentOpen,
    maxStudents: cls.maxStudents,
    createdAt,
  };
}

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
  const hasAuthHeader = Boolean(request.headers.get("authorization"));

  if (!hasAuthHeader) {
    const classes = await listClasses({ enrollmentOpen: true, schoolId });
    const enriched = await Promise.all(
      classes.map(serializeClassSummary)
    );
    return jsonResponse(
      { success: true, data: enriched },
      200,
      { "Cache-Control": "s-maxage=30, stale-while-revalidate=120" }
    );
  }

  // Try professor auth first
  const professor = await getProfessorFromRequest(request);
  if (professor) {
    const classes = await listClasses({ professorId: professor.id, schoolId });
    const enriched = await Promise.all(
      classes.map(async (cls) => {
        const createdAt = toIsoOrEmpty(cls.createdAt);
        return {
          ...cls,
          enrollment_open: cls.enrollmentOpen,
          max_students: cls.maxStudents,
          created_at: createdAt,
          createdAt,
          enrollment_count: await getClassEnrollmentCount(cls.id),
          assistants: await getClassAssistants(cls.id),
        };
      })
    );
    return jsonResponse({ success: true, data: enriched });
  }

  // Public listing of open classes. Agent auth is optional — if provided,
  // enforce school access checks; otherwise allow public view of open classes.
  const { agent, denial } = await optionalAgent(request);
  if (denial) return denial;
  if (agent) {
    const accessError = requireSchoolAccess(agent, schoolId);
    if (accessError) return accessError;
  }

  const classes = await listClasses({ enrollmentOpen: true, schoolId });
  const enriched = await Promise.all(
    classes.map(serializeClassSummary)
  );
  return jsonResponse(
    { success: true, data: enriched },
    200,
    {}
  );
}
