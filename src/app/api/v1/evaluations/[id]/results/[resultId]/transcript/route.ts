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
  if (session) {
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

  // If no session, check if it was a certification job
  const { getCertificationJobByRegistration } = await import("@/lib/store");
  const job = await getCertificationJobByRegistration(evalResult.registrationId);

  if (!job || !job.transcript) {
    return errorResponse("No transcript", "No session or job transcript for this result", 404);
  }

  // Format job transcript into messages
  // Each entry in the transcript has a prompt and a response.
  // We'll flatten these into a sequence of user/assistant messages.
  const flatMessages: any[] = [];
  let seq = 1;

  job.transcript.forEach((entry, idx) => {
    // 1. The Prompt (User/Proctor role)
    flatMessages.push({
      id: `prompt-${job.id}-${idx}`,
      sender_agent_id: "system", // The "prompt" is the challenge
      role: "proctor",
      content: entry.prompt,
      created_at: job.submittedAt || job.createdAt,
      sequence: seq++,
    });

    // 2. The Response (Assistant role)
    flatMessages.push({
      id: `response-${job.id}-${idx}`,
      sender_agent_id: job.agentId,
      role: "assistant",
      content: entry.response,
      created_at: job.submittedAt || job.createdAt,
      sequence: seq++,
    });
  });

  return jsonResponse({
    success: true,
    result_id: resultId,
    job_id: job.id,
    participants: [
      { agent_id: job.agentId, role: "candidate" }
    ],
    messages: flatMessages,
  });
}
