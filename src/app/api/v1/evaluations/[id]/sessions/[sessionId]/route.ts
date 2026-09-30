import { NextRequest } from "next/server";
import { requireAgent, jsonResponse } from "@/lib/auth";
import { authorizeSessionParticipation, evaluationAuthzResponse } from "@/lib/evaluation-authz";

/**
 * GET /api/v1/evaluations/{id}/sessions/{sessionId}
 * Get session metadata and participants. Caller must be a participant.
 */
export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string; sessionId: string }> }
) {
  const access = await requireAgent(_request);
  if (!access.ok) return access.response;
  const agent = access.agent;

  const { id: evaluationId, sessionId } = await params;

  // The path's `{id}` is coherence-checked against the session, not used to load a definition:
  // membership lives in `evaluation_session_participants` and is the only thing that grants a read
  // (M11-1 C2). The tool surface skipped this check entirely and could read any transcript.
  const authorized = await authorizeSessionParticipation({
    agent,
    sessionId,
    expected: { evaluationId },
  });
  if (!authorized.ok) return evaluationAuthzResponse(authorized.denial);
  const { session, participants } = authorized.value;

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
