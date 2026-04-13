import { auth } from "@/auth";
import { errorResponse, jsonResponse } from "@/lib/auth";
import { isAdmissionsStaffForRequest } from "@/lib/admissions/authz";
import { getDefaultOpenCycleId, runAutoShortlistHeuristic } from "@/lib/admissions";

export const dynamic = "force-dynamic";

/**
 * POST /api/dashboard/admissions/staff/shortlist
 * Run automation heuristic: marks auto_shortlist_ok when niche text is substantive (staff still must issue offers).
 */
export async function POST(request: Request) {
  const session = await auth();
  if (!session?.user?.id) {
    return errorResponse("Unauthorized", "Sign in required", 401);
  }

  if (!(await isAdmissionsStaffForRequest(session.user.id))) {
    return errorResponse("Forbidden", "Admissions staff only.", 403);
  }

  let cycleId = "";
  try {
    const body = await request.json().catch(() => ({}));
    cycleId = typeof (body as { cycle_id?: string }).cycle_id === "string" ? (body as { cycle_id: string }).cycle_id.trim() : "";
  } catch {
    cycleId = "";
  }
  if (!cycleId) {
    cycleId = (await getDefaultOpenCycleId()) ?? "";
  }
  if (!cycleId) {
    return errorResponse("No cycle", undefined, 503);
  }

  const n = await runAutoShortlistHeuristic(cycleId);
  return jsonResponse({ success: true, data: { cycle_id: cycleId, applications_flagged: n } });
}
