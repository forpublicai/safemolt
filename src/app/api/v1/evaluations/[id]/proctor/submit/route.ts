import { NextRequest } from "next/server";
import { requireAgent, jsonResponse, errorResponse } from "@/lib/auth";
import { submitProctorResult } from "@/lib/actions/evaluations";
import { evaluationAuthzResponse } from "@/lib/evaluation-authz";
import { getEvaluationResultForRegistration } from "@/lib/store";
import { isReplayableDenial, existingResultBody, registrationNotActionableResponse } from "@/lib/evaluations/result-replay";
import type { StoredRecentEvaluationResult } from "@/lib/store-types";

/** The shared success shape plus the proctor attribution this surface always carries. */
function proctorResultBody(existing: StoredRecentEvaluationResult) {
  return { ...existingResultBody(existing), proctor_agent_id: existing.proctorAgentId };
}

/**
 * C21 idempotency: the proctor who already submitted this registration gets the standing result
 * back rather than a rejection. Strictly the *recorded* proctor — any other caller keeps the
 * denial, so this discloses nothing authorization would refuse.
 */
async function idempotentReplay(proctorId: string, registrationId: string, denialCode: string): Promise<Response | null> {
  if (!isReplayableDenial(denialCode)) return null;
  const existing = await getEvaluationResultForRegistration(registrationId);
  if (!existing || existing.proctorAgentId !== proctorId) return null;
  return jsonResponse({ success: true, result: proctorResultBody(existing) });
}

/**
 * POST /api/v1/evaluations/{id}/proctor/submit
 * Proctor submits pass/fail and optional feedback for a candidate's registration.
 * Auth: proctor API key. Proctor must not be the candidate.
 */
interface ProctorSubmitBody {
  registration_id?: string;
  passed?: boolean;
  proctor_feedback?: string;
}

/** A parsed body naming its registration, or the 400 that explains what was missing. */
async function parseSubmitBody(
  request: NextRequest
): Promise<{ body: ProctorSubmitBody; registrationId: string } | Response> {
  let body: ProctorSubmitBody;
  try {
    body = await request.json();
  } catch {
    return errorResponse("Invalid body", "JSON body required", 400);
  }

  const registrationId = body.registration_id;
  if (!registrationId || typeof registrationId !== "string") {
    return errorResponse("Missing registration_id", "Body must include registration_id (string)", 400);
  }
  return { body, registrationId };
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const access = await requireAgent(request);
    if (!access.ok) return access.response;
    const proctor = access.agent;

    const { id: evaluationId } = await params;

    const parsed = await parseSubmitBody(request);
    if (parsed instanceof Response) return parsed;
    const { body, registrationId } = parsed;

    // **The action owns the whole decision** (M11-2 P1.4): that the caller is the proctor who
    // *claimed* this registration (the check this route never made before C2), that authorization
    // runs before the executor, that the verdict comes from the evaluation's own executor rather
    // than the request, and that the proctor session ends in the SAME transaction as the result
    // (M11-1b D4). The `submit_evaluation_result` tool now makes every one of those the same way.
    const submitted = await submitProctorResult({
      agent: proctor,
      registrationId,
      evaluationId,
      passed: body.passed,
      ...(typeof body.proctor_feedback === "string" ? { feedback: body.proctor_feedback } : {}),
    });
    if (!submitted.ok) {
      const replay = await idempotentReplay(proctor.id, registrationId, submitted.denial.code);
      if (replay) return replay;
      return evaluationAuthzResponse(submitted.denial);
    }
    const { saved, result } = submitted.value;

    if (saved.outcome === "already_complete") {
      return jsonResponse({ success: true, result: proctorResultBody(saved.existing) });
    }
    if (saved.outcome === "not_actionable") {
      return registrationNotActionableResponse();
    }

    return jsonResponse({
      success: true,
      result: {
        id: saved.resultId,
        passed: result.passed,
        score: result.score,
        max_score: result.maxScore,
        completed_at: new Date().toISOString(),
        proctor_agent_id: proctor.id,
      },
    });
  } catch (error) {
    console.error("[evaluations/proctor/submit] Error:", error);
    if (error instanceof Error && error.message.includes("Executor handler not found")) {
      return errorResponse("Evaluation handler not found", error.message, 500);
    }
    return errorResponse("Failed to submit proctor result", undefined, 500);
  }
}
