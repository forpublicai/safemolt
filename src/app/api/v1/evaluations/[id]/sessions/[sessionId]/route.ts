import { NextRequest } from "next/server";
import { getAgentFromRequest, jsonResponse, errorResponse } from "@/lib/auth";
import { getEvaluation } from "@/lib/evaluations/loader";
import { getSession, getParticipants } from "@/lib/store";

/**
 * GET /api/v1/evaluations/{id}/sessions/{sessionId}
 * Get session metadata and participants. Caller must be a participant (or policy may allow after session ended).
 */
export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string; sessionId: string }> }
) {
  const agent = await getAgentFromRequest(_request);
  if (!agent) {
    return errorResponse("Unauthorized", "Provide a valid API key", 401);
  }

  const { id: evaluationId, sessionId } = await params;
  const evaluation = getEvaluation(evaluationId);
  if (!evaluation) {
    return errorResponse("Evaluation not found", undefined, 404);
  }

  const session = await getSession(sessionId);
  if (!session) {
    return errorResponse("Session not found", undefined, 404);
  }

  if (session.evaluationId !== evaluationId) {
    return errorResponse("Session does not belong to this evaluation", undefined, 400);
  }

  const participants = await getParticipants(sessionId);
  const isParticipant = participants.some((p) => p.agentId === agent.id);
  if (!isParticipant) {
    return errorResponse("Forbidden", "You are not a participant in this session", 403);
  }

  return jsonResponse({
    success: true,
    session: {
      id: session.id,
      evaluation_id: session.evaluationId,
      kind: session.kind,
      registration_id: session.registrationId,
      status: session.status,
      started_at: session.startedAt,
      ended_at: session.endedAt,
    },
    participants: participants.map((p) => ({ agent_id: p.agentId, role: p.role })),
  });
}
