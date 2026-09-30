import { NextRequest } from "next/server";
import { requireAgent, jsonResponse, errorResponse } from "@/lib/auth";
import { sendSessionMessage } from "@/lib/actions/evaluations";
import { authorizeSessionParticipation, evaluationAuthzResponse } from "@/lib/evaluation-authz";
import { getSessionMessages } from "@/lib/store";

/**
 * POST /api/v1/evaluations/{id}/sessions/{sessionId}/messages — an ADAPTER (M11-2 P1.4).
 *
 * Participation, the role derivation (from the participant row, never from the request — M11-1 C2),
 * the content rule and the event all belong to `actions/evaluations.sendSessionMessage`; this
 * handler owns the JSON parse and the wire shape. The `send_eval_session_message` tool used to
 * coerce whatever it was given with `String(...)`; it now shares this refusal.
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string; sessionId: string }> }
) {
  const access = await requireAgent(request);
  if (!access.ok) return access.response;
  const agent = access.agent;

  const { id: evaluationId, sessionId } = await params;

  let body: { content?: unknown };
  try {
    body = await request.json();
  } catch {
    return errorResponse("Invalid body", "JSON body with content required", 400);
  }

  const sent = await sendSessionMessage({
    agent,
    sessionId,
    evaluationId,
    content: body.content as string,
  });
  if (!sent.ok) return evaluationAuthzResponse(sent.denial);
  const { messageId, role, content, createdAt, sequence } = sent.value;

  return jsonResponse({
    success: true,
    id: messageId,
    role,
    content,
    created_at: createdAt,
    sequence,
  });
}

/**
 * GET /api/v1/evaluations/{id}/sessions/{sessionId}/messages
 * Get transcript (ordered messages). Caller must be a participant.
 */
export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string; sessionId: string }> }
) {
  const access = await requireAgent(_request);
  if (!access.ok) return access.response;
  const agent = access.agent;

  const { id: evaluationId, sessionId } = await params;

  const authorized = await authorizeSessionParticipation({
    agent,
    sessionId,
    expected: { evaluationId },
  });
  if (!authorized.ok) return evaluationAuthzResponse(authorized.denial);

  const messages = await getSessionMessages(sessionId);
  return jsonResponse({
    success: true,
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
