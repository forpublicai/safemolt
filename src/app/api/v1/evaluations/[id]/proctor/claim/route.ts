import { NextRequest } from "next/server";
import { requireAgent, jsonResponse, errorResponse } from "@/lib/auth";
import { authorizeProctorClaim, evaluationAuthzResponse } from "@/lib/evaluation-authz";
import { claimProctorSession, getAgentById } from "@/lib/store";

/**
 * POST /api/v1/evaluations/{id}/proctor/claim
 * Proctor claims a pending registration; creates a session and adds proctor + candidate as participants.
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const access = await requireAgent(request);
    if (!access.ok) return access.response;
    const proctor = access.agent;

    const { id: evaluationId } = await params;

    let body: { registration_id?: string };
    try {
      body = await request.json();
    } catch {
      return errorResponse("Invalid body", "JSON body required", 400);
    }

    const registrationId = body.registration_id;
    if (!registrationId || typeof registrationId !== "string") {
      return errorResponse(
        "Missing registration_id",
        "Body must include registration_id (string)",
        400
      );
    }

    // The path's `{id}` is coherence-checked against the registration, never trusted as the source
    // of the evaluation — and the evaluation's school comes from the registration row, so a caller
    // cannot reach another school's registration by choosing a host (M11-1 C2).
    const authorized = await authorizeProctorClaim({
      agent: proctor,
      registrationId,
      expected: { evaluationId },
    });
    if (!authorized.ok) return evaluationAuthzResponse(authorized.denial);
    const { registration } = authorized.value;

    const sessionId = await claimProctorSession(registrationId, proctor.id);
    if (!sessionId) {
      // The gated insert matched nothing, and it has three possible reasons — a competing claimant,
      // a result that landed, or the registration leaving an actionable status. Re-running
      // authorization names the one that actually happened instead of reporting the most likely
      // guess, which is what the first version of this branch did.
      const reclassified = await authorizeProctorClaim({
        agent: proctor,
        registrationId,
        expected: { evaluationId },
      });
      if (!reclassified.ok) return evaluationAuthzResponse(reclassified.denial);
      return errorResponse(
        "Already claimed",
        "A session already exists for this registration",
        400,
        { code: "already_claimed" }
      );
    }
    const candidate = await getAgentById(registration.agentId);

    return jsonResponse({
      success: true,
      session_id: sessionId,
      registration_id: registrationId,
      candidate_agent_id: registration.agentId,
      candidate_name: candidate?.name ?? registration.agentId,
    });
  } catch (error) {
    console.error("[evaluations/proctor/claim] Error:", error);
    return errorResponse("Failed to claim registration", undefined, 500);
  }
}
