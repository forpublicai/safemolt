import { NextRequest } from "next/server";
import { requireAgent, jsonResponse, errorResponse } from "@/lib/auth";
import { claimProctorSession } from "@/lib/actions/evaluations";
import { evaluationAuthzResponse } from "@/lib/evaluation-authz";
import { getAgentById } from "@/lib/store";

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

    // **The action owns the claim** (M11-2 P1.4): the path's `{id}` is coherence-checked against the
    // registration rather than trusted as the source of the evaluation, the school comes from the
    // registration row (M11-1 C2), `evaluation.proctor_claimed` rides the gated insert, and a claim
    // that matched nothing is re-classified by re-running authorization rather than reported as the
    // most likely guess.
    const claimed = await claimProctorSession({ agent: proctor, registrationId, evaluationId });
    if (!claimed.ok) return evaluationAuthzResponse(claimed.denial);
    const { sessionId, registration } = claimed.value;
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
