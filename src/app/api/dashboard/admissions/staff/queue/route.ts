import { auth } from "@/auth";
import { errorResponse, jsonResponse } from "@/lib/auth";
import { isAdmissionsStaffForRequest } from "@/lib/admissions/authz";
import { getAgentById } from "@/lib/store";
import { getDefaultOpenCycleId, listApplicationsForStaff } from "@/lib/admissions";
import type { AdmissionsApplicationState } from "@/lib/admissions/types";

export const dynamic = "force-dynamic";

const DEFAULT_STATES: AdmissionsApplicationState[] = [
  "in_pool",
  "under_review",
  "shortlisted",
  "offered",
];

/**
 * GET /api/dashboard/admissions/staff/queue?cycle_id=&state=
 * Hybrid queue: applications in the pipeline (automation flags on each row; offers require staff creation).
 */
export async function GET(request: Request) {
  const session = await auth();
  if (!session?.user?.id) {
    return errorResponse("Unauthorized", "Sign in required", 401);
  }

  if (!(await isAdmissionsStaffForRequest(session.user.id))) {
    return errorResponse("Forbidden", "Admissions staff only (set is_admissions_staff or ADMISSIONS_STAFF_EMAILS).", 403);
  }

  const url = new URL(request.url);
  let cycleId = url.searchParams.get("cycle_id")?.trim() || "";
  if (!cycleId) {
    cycleId = (await getDefaultOpenCycleId()) ?? "";
  }
  if (!cycleId) {
    return errorResponse("No cycle", "No admissions cycle configured.", 503);
  }

  const stateFilter = url.searchParams.get("state")?.trim();
  const states = stateFilter
    ? (stateFilter.split(",").map((s) => s.trim()) as AdmissionsApplicationState[])
    : DEFAULT_STATES;

  const apps = await listApplicationsForStaff(cycleId, states);
  const enriched = await Promise.all(
    apps.map(async (a) => {
      const agent = await getAgentById(a.agentId);
      return {
        ...a,
        agent_name: agent?.name ?? null,
        agent_display_name: agent?.displayName ?? null,
        is_vetted: agent?.isVetted ?? false,
        is_admitted: agent?.isAdmitted ?? false,
      };
    })
  );

  return jsonResponse({ success: true, data: { cycle_id: cycleId, applications: enriched } });
}
