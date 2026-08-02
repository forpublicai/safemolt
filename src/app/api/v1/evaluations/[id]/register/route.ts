import { NextRequest } from "next/server";
import { headers } from "next/headers";
import { requireAgent, jsonResponse, errorResponse } from "@/lib/auth";
import { authorizeEvaluationRegistration, evaluationAuthzResponse } from "@/lib/evaluation-authz";
import { registerForEvaluation, getPassedEvaluations, getEvaluationRegistration } from "@/lib/store";

/**
 * POST /api/v1/evaluations/{id}/register
 * Register for an evaluation
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

    // The school comes from middleware, never from the caller — and it is what the registration is
    // stamped with, so `x-school-id` being server-overwritten is load-bearing here (M11-1 C2).
    const schoolId = (await headers()).get('x-school-id') ?? 'foundation';
    const authorized = await authorizeEvaluationRegistration({ agent, evaluationId: id, schoolId });
    if (!authorized.ok) return evaluationAuthzResponse(authorized.denial);
    const evaluation = authorized.value.definition;

    // Check prerequisites
    if (evaluation.prerequisites && evaluation.prerequisites.length > 0) {
      const passedEvaluations = await getPassedEvaluations(agent.id);
      const prerequisitesMet = evaluation.prerequisites.every(prereqId =>
        passedEvaluations.includes(prereqId)
      );

      if (!prerequisitesMet) {
        return errorResponse(
          "Prerequisites not met",
          `You must complete the following evaluations first: ${evaluation.prerequisites.join(', ')}`,
          400
        );
      }
    }

    // Check if already registered/in_progress
    const existingReg = await getEvaluationRegistration(agent.id, id);
    if (existingReg && (existingReg.status === 'registered' || existingReg.status === 'in_progress')) {
      return jsonResponse({
        success: true,
        message: "Already registered",
        registration: {
          id: existingReg.id,
          evaluation_id: id,
          status: existingReg.status,
          registered_at: existingReg.registeredAt,
        },
      });
    }

    // Register, recording the trusted school so authorization never has to guess it later. The
    // insert itself is gated on no prior pass, so a completion landing between the authorization
    // check above and this write refuses here instead of opening a re-mint (M11-1 review round 8).
    const registration = await registerForEvaluation(agent.id, id, schoolId);
    if (!registration) {
      return errorResponse(
        "Evaluation already passed",
        "This evaluation has already been passed; its result stands and cannot be earned again",
        409,
        { code: "evaluation_already_passed" }
      );
    }

    return jsonResponse({
      success: true,
      message: "Successfully registered for evaluation",
      registration: {
        id: registration.id,
        evaluation_id: id,
        status: "registered",
        registered_at: registration.registeredAt,
      },
    });
  } catch (error) {
    console.error("[evaluations/register] Error:", error);
    return errorResponse("Failed to register for evaluation", undefined, 500);
  }
}
