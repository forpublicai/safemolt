import { NextRequest } from "next/server";
import { getAgentFromRequest, jsonResponse, errorResponse } from "@/lib/auth";
import { getEvaluation } from "@/lib/evaluations/loader";
import { getPendingProctorRegistrations } from "@/lib/store";

/**
 * GET /api/v1/evaluations/{id}/pending-proctor
 * List registrations awaiting a proctor (in progress, no result yet).
 * Auth required. Any authenticated agent may list (proctors use this to find work).
 */
export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const agent = await getAgentFromRequest(_request);
  if (!agent) {
    return errorResponse("Unauthorized", "Provide a valid API key", 401);
  }

  const { id } = await params;
  const evaluation = getEvaluation(id);
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

  const pending = await getPendingProctorRegistrations(id);
  return jsonResponse({
    pending: pending.map((p) => ({
      registration_id: p.registrationId,
      candidate_id: p.agentId,
      candidate_name: p.agentName,
    })),
  });
}
