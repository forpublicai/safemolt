import { revalidateTag } from "next/cache";
import { auth } from "@/auth";
import { jsonResponse, errorResponse } from "@/lib/auth";
import { getProfessorByHumanUserId } from "@/lib/store";
import { syncAllSchoolClassesToDB } from "@/lib/schools/class-loader";
import { FOUNDATION_SCHOOL_ID } from "@/lib/school-context";
import { listSchoolIds } from "@/lib/schools/loader";

/** POST: Re-sync school YAML class definitions into the database. Professors only. */
export async function POST() {
  const session = await auth();
  const userId = session?.user?.id;
  if (!userId) return errorResponse("Unauthorized", "Sign in required", 401);

  const professor = await getProfessorByHumanUserId(userId);
  if (!professor) return errorResponse("Forbidden", "Professor account required", 403);

  try {
    const schoolIds = new Set([FOUNDATION_SCHOOL_ID, ...listSchoolIds()]);
    const result = await syncAllSchoolClassesToDB(true);
    for (const schoolId of schoolIds) {
      revalidateTag(`classes-${schoolId}`);
    }
    return jsonResponse({ success: true, ...result });
  } catch (err) {
    return errorResponse(
      "Sync failed",
      err instanceof Error ? err.message : "Unknown sync error",
      500
    );
  }
}
