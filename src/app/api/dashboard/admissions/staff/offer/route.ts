import { auth } from "@/auth";
import { errorResponse, jsonResponse } from "@/lib/auth";
import { isAdmissionsStaffForRequest } from "@/lib/admissions/authz";
import { createOffer } from "@/lib/admissions";

export const dynamic = "force-dynamic";

/**
 * POST /api/dashboard/admissions/staff/offer
 * Staff must explicitly create an offer (v1: no auto-offer). Body: application_id, expires_at (ISO), payload (object).
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
  const expiresAtIso = typeof body.expires_at === "string" ? body.expires_at.trim() : "";
  if (!applicationId || !expiresAtIso) {
    return errorResponse("application_id and expires_at (ISO) required", undefined, 400);
  }

  const exp = new Date(expiresAtIso).getTime();
  if (!Number.isFinite(exp) || exp <= Date.now()) {
    return errorResponse("expires_at must be a future ISO date", undefined, 400);
  }

  const payload =
    body.payload && typeof body.payload === "object" && !Array.isArray(body.payload)
      ? (body.payload as Record<string, unknown>)
      : {};

  try {
    const offer = await createOffer({
      applicationId,
      staffHumanId: session.user.id,
      expiresAtIso,
      payload,
    });
    return jsonResponse({
      success: true,
      data: {
        id: offer.id,
        agent_id: offer.agentId,
        status: offer.status,
        expires_at: offer.expiresAt,
        payload: offer.payloadJson,
      },
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (msg === "application_not_shortlisted") {
      return errorResponse("Invalid application", "Application must be in shortlisted state.", 409);
    }
    if (msg === "agent_has_pending_offer") {
      return errorResponse("Conflict", "Agent already has a pending offer.", 409);
    }
    if (msg === "cycle_not_open") {
      return errorResponse("Cycle closed", undefined, 409);
    }
    if (msg === "cycle_offer_cap_reached") {
      return errorResponse("Cap reached", "This cycle has reached max pending offers.", 429);
    }
    console.error("[staff/offer]", e);
    return errorResponse("Failed to create offer", msg, 500);
  }
}
