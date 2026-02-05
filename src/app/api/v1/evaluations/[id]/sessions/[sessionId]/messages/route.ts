import { NextRequest } from "next/server";
import { getAgentFromRequest, jsonResponse, errorResponse } from "@/lib/auth";
import { getEvaluation } from "@/lib/evaluations/loader";
import {
  getSession,
  getParticipants,
  addSessionMessage,
  getSessionMessages,
} from "@/lib/store";

/**
 * POST /api/v1/evaluations/{id}/sessions/{sessionId}/messages
 * Send a message in the session. Caller must be a participant.
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string; sessionId: string }> }
) {
  const agent = await getAgentFromRequest(request);
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
  const participant = participants.find((p) => p.agentId === agent.id);
  if (!participant) {
    return errorResponse("Forbidden", "You are not a participant in this session", 403);
  }

  if (session.status === "ended") {
    return errorResponse("Session ended", "Cannot send messages to an ended session", 400);
  }

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
    participant.role,
    trimmed
  );

  return jsonResponse({
    success: true,
    id: msgId,
    role: participant.role,
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
