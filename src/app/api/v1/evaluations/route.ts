import { NextRequest } from "next/server";
import { getAgentFromRequest, jsonResponse, errorResponse } from "@/lib/auth";
import { listEvaluations } from "@/lib/evaluations/loader";
import { getPassedEvaluations, getEvaluationRegistration } from "@/lib/store";

/**
 * GET /api/v1/evaluations
 * List all evaluations with optional filtering
 * 
 * Query params:
 * - module: Filter by module (e.g., "core", "safety")
 * - status: Filter by status (default: "active")
 * - agent_id: Include registration status for agent (optional)
 */
export async function GET(request: NextRequest) {
  try {
    const searchParams = request.nextUrl.searchParams;
    const module = searchParams.get("module") || undefined;
    const statusParam = searchParams.get("status") || "active";
    const status = statusParam === "all" ? "all" : (statusParam as "active" | "draft" | "deprecated");
    
    // Get current agent if authenticated
    const agent = await getAgentFromRequest(request);
    
    // Load evaluations
    let evaluations = listEvaluations(module, status);
    
    // Add registration status if agent is authenticated
    if (agent) {
      const passedEvaluations = await getPassedEvaluations(agent.id);
      
      // Check registration status for each evaluation
      const evaluationsWithStatus = await Promise.all(
        evaluations.map(async (evaluation) => {
          // Check if agent has passed
          const hasPassed = passedEvaluations.includes(evaluation.id);
          
          // Check if agent is registered
          let registrationStatus: 'available' | 'registered' | 'in_progress' | 'completed' | 'prerequisites_not_met' = 'available';
          
          if (hasPassed) {
            registrationStatus = 'completed';
          } else {
            // Check prerequisites
            const prerequisitesMet = evaluation.prerequisites.every(prereqId => 
              passedEvaluations.includes(prereqId)
            );
            
            if (!prerequisitesMet) {
              registrationStatus = 'prerequisites_not_met';
            } else {
              // Check registration status
              const registration = await getEvaluationRegistration(agent.id, evaluation.id);
              if (registration) {
                if (registration.status === 'in_progress') {
                  registrationStatus = 'in_progress';
                } else if (registration.status === 'registered') {
                  registrationStatus = 'registered';
                } else {
                  registrationStatus = 'available';
                }
              } else {
                registrationStatus = 'available';
              }
            }
          }
          
          return {
            ...evaluation,
            registrationStatus,
            hasPassed,
            canRegister: evaluation.status === 'active' && registrationStatus === 'available',
          };
        })
      );
      
      evaluations = evaluationsWithStatus;
    } else {
      // No agent, just mark all as available
      evaluations = evaluations.map(evaluation => ({
        ...evaluation,
        canRegister: evaluation.status === 'active',
      }));
    }
    
    return jsonResponse({
      success: true,
      evaluations,
    });
  } catch (error) {
    console.error("[evaluations] Error:", error);
    return errorResponse("Failed to load evaluations", undefined, 500);
  }
}
