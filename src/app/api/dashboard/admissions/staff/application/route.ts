import { auth } from "@/auth";
import { errorResponse, jsonResponse } from "@/lib/auth";
import { isAdmissionsStaffForRequest } from "@/lib/admissions/authz";
import {
  transitionApplicationState,
  updateApplicationNiche,
  updateApplicationDedupe,
  getApplicationById,
  ADMISSIONS_REJECT_REASON_CATEGORIES,
} from "@/lib/admissions";
import type { AdmissionsApplicationState } from "@/lib/admissions/types";

export const dynamic = "force-dynamic";

const VALID_TRANSITIONS: Partial<Record<AdmissionsApplicationState, AdmissionsApplicationState[]>> = {
  in_pool: ["under_review", "rejected"],
  under_review: ["in_pool", "shortlisted", "rejected"],
  shortlisted: ["under_review", "rejected"],
  declined_offer: ["in_pool", "under_review", "rejected"],
};

function canTransition(from: AdmissionsApplicationState, to: AdmissionsApplicationState): boolean {
  const allowed = VALID_TRANSITIONS[from];
  return Boolean(allowed?.includes(to));
}

/**
 * POST /api/dashboard/admissions/staff/application
 * op: transition | niche | dedupe
 */
export async function POST(request: Request) {
  const session = await auth();
  if (!session?.user?.id) {
    return errorResponse("Unauthorized", "Sign in required", 401);
  }

  if (!(await isAdmissionsStaffForRequest(session.user.id))) {
    return errorResponse("Forbidden", "Admissions staff only.", 403);
  }

  let body: Record<string, unknown>;
  try {
    body = await request.json();
  } catch {
    return errorResponse("Invalid JSON", undefined, 400);
  }

  const applicationId = typeof body.application_id === "string" ? body.application_id.trim() : "";
  const op = typeof body.op === "string" ? body.op.trim() : "";
  if (!applicationId || !op) {
    return errorResponse("application_id and op required", undefined, 400);
  }

  if (op === "transition") {
    const newState = body.new_state as AdmissionsApplicationState;
    if (!newState) {
      return errorResponse("new_state required", undefined, 400);
    }
    const cur = await getApplicationById(applicationId);
    if (!cur) return errorResponse("Not found", undefined, 404);
    if (!canTransition(cur.state, newState)) {
      return errorResponse("Invalid transition", `Cannot go from ${cur.state} to ${newState}`, 409);
    }
    const cat = typeof body.reject_reason_category === "string" ? body.reject_reason_category.trim() : null;
    if (newState === "rejected" && cat && !ADMISSIONS_REJECT_REASON_CATEGORIES.includes(cat as (typeof ADMISSIONS_REJECT_REASON_CATEGORIES)[number])) {
      return errorResponse("Invalid reject_reason_category", ADMISSIONS_REJECT_REASON_CATEGORIES.join(", "), 400);
    }
    const notes = typeof body.reviewer_notes_internal === "string" ? body.reviewer_notes_internal : null;
    const updated = await transitionApplicationState(
      applicationId,
      newState,
      notes,
      newState === "rejected" ? cat : null
    );
    return jsonResponse({ success: true, data: updated });
  }

  if (op === "niche") {
    const updated = await updateApplicationNiche(applicationId, {
      primaryDomain: typeof body.primary_domain === "string" ? body.primary_domain : undefined,
      nonGoals: typeof body.non_goals === "string" ? body.non_goals : undefined,
      evaluationPlan: typeof body.evaluation_plan === "string" ? body.evaluation_plan : undefined,
    });
    if (!updated) return errorResponse("Not found", undefined, 404);
    return jsonResponse({ success: true, data: updated });
  }

  if (op === "dedupe") {
    const score = body.dedupe_similarity_score;
    const flagged = body.dedupe_flagged;
    const updated = await updateApplicationDedupe(applicationId, {
      dedupeSimilarityScore: typeof score === "number" ? score : score === null ? null : undefined,
      dedupeFlagged: typeof flagged === "boolean" ? flagged : undefined,
    });
    if (!updated) return errorResponse("Not found", undefined, 404);
    return jsonResponse({ success: true, data: updated });
  }

  return errorResponse("Unknown op", "Use transition, niche, or dedupe", 400);
}
