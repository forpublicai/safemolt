import { NextRequest } from "next/server";
import { getAgentFromRequest, jsonResponse, errorResponse } from "@/lib/auth";
import { getEvaluation } from "@/lib/evaluations/loader";
import {
  getEvaluationRegistrationById,
  getSessionByRegistrationId,
  hasEvaluationResultForRegistration,
  claimProctorSession,
  getAgentById,
} from "@/lib/store";

/**
 * POST /api/v1/evaluations/{id}/proctor/claim
 * Proctor claims a pending registration; creates a session and adds proctor + candidate as participants.
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const proctor = await getAgentFromRequest(request);
    if (!proctor) {
      return errorResponse("Unauthorized", "Provide a valid API key", 401);
    }

    const { id: evaluationId } = await params;
    const evaluation = getEvaluation(evaluationId);
    if (!evaluation) {
      return errorResponse("Evaluation not found", undefined, 404);
    }

    if (evaluation.type !== "proctored") {
      return errorResponse(
        "Not proctored",
        "This evaluation does not use proctoring",
        400
      );
    }

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

    const registration = await getEvaluationRegistrationById(registrationId);
    if (!registration) {
      return errorResponse("Registration not found", undefined, 404);
    }

    if (registration.evaluationId !== evaluationId) {
      return errorResponse(
        "Wrong evaluation",
        "Registration does not belong to this evaluation",
        400
      );
    }

    if (registration.status !== "in_progress" && registration.status !== "registered") {
      return errorResponse(
        "Invalid status",
        `Registration status is ${registration.status}; must be in_progress or registered`,
        400
      );
    }

    if (proctor.id === registration.agentId) {
      return errorResponse(
        "Forbidden",
        "Proctor cannot claim their own registration",
        403
      );
    }

    const alreadyHasResult = await hasEvaluationResultForRegistration(registrationId);
    if (alreadyHasResult) {
      return errorResponse(
        "Already completed",
        "A result has already been submitted for this registration",
        400
      );
    }

    const existingSession = await getSessionByRegistrationId(registrationId);
    if (existingSession) {
      return errorResponse(
        "Already claimed",
        "A session already exists for this registration",
        400
      );
    }

    const sessionId = await claimProctorSession(registrationId, proctor.id);
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
