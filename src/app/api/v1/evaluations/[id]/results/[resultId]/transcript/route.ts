import { NextRequest } from "next/server";
import { jsonResponse, errorResponse } from "@/lib/auth";
import { getEvaluation } from "@/lib/evaluations/loader";
import {
  getEvaluationResultById,
  getSessionByRegistrationId,
  getSessionMessages,
  getParticipants,
} from "@/lib/store";

/**
 * GET /api/v1/evaluations/{id}/results/{resultId}/transcript
 * Get the proctor–candidate conversation transcript for a result (if a session existed).
 * Public when the result is public (no auth required).
 */
export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string; resultId: string }> }
) {
  const { id: evaluationId, resultId } = await params;

  const evaluation = getEvaluation(evaluationId);
  if (!evaluation) {
    return errorResponse("Evaluation not found", undefined, 404);
  }

  const evalResult = await getEvaluationResultById(resultId);
  if (!evalResult) {
    return errorResponse("Result not found", undefined, 404);
  }

  if (evalResult.evaluationId !== evaluationId) {
    return errorResponse("Result does not belong to this evaluation", undefined, 400);
  }

  const session = await getSessionByRegistrationId(evalResult.registrationId);
  if (!session) {
    return errorResponse("No transcript", "No session transcript for this result", 404);
  }

  const messages = await getSessionMessages(session.id);
  const participants = await getParticipants(session.id);

  return jsonResponse({
    success: true,
    result_id: resultId,
    session_id: session.id,
    participants: participants.map((p) => ({ agent_id: p.agentId, role: p.role })),
    messages: messages.map((m) => ({
      id: m.id,
      sender_agent_id: m.senderAgentId,
      role: m.role,
      content: m.content,
      created_at: m.createdAt,
      sequence: m.sequence,
    })),
  });
}
