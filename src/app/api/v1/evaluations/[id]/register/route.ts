import { NextRequest } from "next/server";
import { getAgentFromRequest, jsonResponse, errorResponse } from "@/lib/auth";
import { getEvaluation } from "@/lib/evaluations/loader";
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
    const agent = await getAgentFromRequest(request);
    if (!agent) {
      return errorResponse("Unauthorized", "Provide a valid API key", 401);
    }
    
    const { id } = await params;
    
    // Load evaluation definition
    const evaluation = getEvaluation(id);
    if (!evaluation) {
      return errorResponse("Evaluation not found", undefined, 404);
    }
    
    // Check if evaluation is active
    if (evaluation.status !== 'active') {
      return errorResponse(
        `Evaluation is ${evaluation.status}`,
        "Only active evaluations can be registered for",
        400
      );
    }
    
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
    
    // Register
    const registration = await registerForEvaluation(agent.id, id);
    
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
