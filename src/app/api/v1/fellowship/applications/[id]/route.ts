import { auth } from "@/auth";
import { jsonResponse, errorResponse } from "@/lib/auth";
import {
  getAoFellowshipApplication,
  updateAoFellowshipApplication,
  setAgentAoFellowCredential,
} from "@/lib/store";
import { isAoFellowshipStaffForRequest } from "@/lib/ao-stanford/authz";

export const dynamic = "force-dynamic";

/**
 * GET /api/v1/fellowship/applications/:id — staff
 */
export async function GET(_request: Request, context: { params: Promise<{ id: string }> }) {
  const session = await auth();
  if (!session?.user?.id) {
    return errorResponse("Unauthorized", undefined, 401);
  }
  if (!(await isAoFellowshipStaffForRequest(session.user.id))) {
    return errorResponse("Forbidden", undefined, 403);
  }
  const { id } = await context.params;
  const app = await getAoFellowshipApplication(id);
  if (!app) return errorResponse("Not found", undefined, 404);
  return jsonResponse({
    success: true,
    application: {
      id: app.id,
      org_slug: app.orgSlug,
      org_name: app.orgName,
      description: app.description,
      sponsor_agent_id: app.sponsorAgentId,
      application_json: app.applicationJson,
      status: app.status,
      cycle_id: app.cycleId,
      scores: app.scores,
      staff_feedback: app.staffFeedback,
      created_at: app.createdAt,
      updated_at: app.updatedAt,
    },
  });
}

/**
 * PATCH /api/v1/fellowship/applications/:id — staff review (status, scores, feedback)
 */
export async function PATCH(request: Request, context: { params: Promise<{ id: string }> }) {
  const session = await auth();
  if (!session?.user?.id) {
    return errorResponse("Unauthorized", undefined, 401);
  }
  if (!(await isAoFellowshipStaffForRequest(session.user.id))) {
    return errorResponse("Forbidden", undefined, 403);
  }
  const { id } = await context.params;
  const existing = await getAoFellowshipApplication(id);
  if (!existing) return errorResponse("Not found", undefined, 404);

  let body: Record<string, unknown>;
  try {
    body = await request.json();
  } catch {
    return errorResponse("Invalid JSON", undefined, 400);
  }
  const status = body.status as "pending" | "reviewing" | "accepted" | "declined" | undefined;
  const scores = body.scores as Record<string, unknown> | undefined;
  const staffFeedback = typeof body.staff_feedback === "string" ? body.staff_feedback : undefined;

  await updateAoFellowshipApplication(id, {
    status: status ?? existing.status,
    scores: scores ?? existing.scores,
    staffFeedback: staffFeedback ?? existing.staffFeedback,
    reviewedByHumanUserId: session.user.id,
  });

  if (status === "accepted") {
    const cohortLabel =
      typeof body.cohort_label === "string" && body.cohort_label.trim()
        ? body.cohort_label.trim()
        : existing.cycleId ?? "current";
    await setAgentAoFellowCredential(existing.sponsorAgentId, cohortLabel, existing.orgSlug);
  }

  const updated = await getAoFellowshipApplication(id);
  return jsonResponse({ success: true, application: updated });
}
