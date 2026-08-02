import { NextRequest } from "next/server";
import { requireAgent, jsonResponse, errorResponse } from "@/lib/auth";
import { authorizeSessionParticipation, evaluationAuthzResponse } from "@/lib/evaluation-authz";
import { addSessionMessage, getSessionMessages } from "@/lib/store";

/**
 * POST /api/v1/evaluations/{id}/sessions/{sessionId}/messages
 * Send a message in the session. Caller must be a participant; the role is derived from the
 * participant row, never taken from the request (M11-1 C2).
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string; sessionId: string }> }
) {
  const access = await requireAgent(request);
  if (!access.ok) return access.response;
  const agent = access.agent;

  const { id: evaluationId, sessionId } = await params;

  const authorized = await authorizeSessionParticipation({
    agent,
    sessionId,
    expected: { evaluationId },
    requireOpen: true,
  });
  if (!authorized.ok) return evaluationAuthzResponse(authorized.denial);
  const { role } = authorized.value;

  let body: { content?: string };
  try {
    body = await request.json();
  } catch {
    return errorResponse("Invalid body", "JSON body with content required", 400);
  }

  const content = body.content;
  if (content === undefined || content === null || typeof content !== "string") {
    return errorResponse("Missing content", "Body must include content (string)", 400);
  }

  const trimmed = content.trim();
  if (trimmed.length === 0) {
    return errorResponse("Empty content", "Message content cannot be empty", 400);
  }

  const { id: msgId, sequence, createdAt } = await addSessionMessage(
    sessionId,
    agent.id,
    role,
    trimmed
  );

  return jsonResponse({
    success: true,
    id: msgId,
    role,
    content: trimmed,
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
