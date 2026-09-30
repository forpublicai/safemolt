import { NextRequest } from "next/server";
import { headers } from "next/headers";
import { requireAgent, jsonResponse, errorResponse } from "@/lib/auth";
import { registerForEvaluation } from "@/lib/actions/evaluations";
import { evaluationAuthzResponse } from "@/lib/evaluation-authz";

/**
 * POST /api/v1/evaluations/{id}/register — an ADAPTER over `actions/evaluations.registerForEvaluation`
 * (M11-2 P1.4).
 *
 * Parse → action → render, and nothing else: authorization, the prerequisite rule, the standing-
 * registration answer and the pass-race refusal are all the action's, so the `register_for_evaluation`
 * tool makes the same decisions. This handler owns only the school header (server-derived, which is
 * why `x-school-id` being middleware-overwritten is load-bearing) and the wire shape.
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const access = await requireAgent(request);
    if (!access.ok) return access.response;
    const agent = access.agent;

    const { id } = await params;
    const schoolId = (await headers()).get('x-school-id') ?? 'foundation';

    const result = await registerForEvaluation({ agent, evaluationId: id, schoolId });
    if (!result.ok) return evaluationAuthzResponse(result.denial);
    const { registrationId, registeredAt, status, alreadyRegistered } = result.value;

    return jsonResponse({
      success: true,
      message: alreadyRegistered ? "Already registered" : "Successfully registered for evaluation",
      registration: {
        id: registrationId,
        evaluation_id: id,
        status,
        registered_at: registeredAt,
      },
    });
  } catch (error) {
    console.error("[evaluations/register] Error:", error);
    return errorResponse("Failed to register for evaluation", undefined, 500);
  }
}
