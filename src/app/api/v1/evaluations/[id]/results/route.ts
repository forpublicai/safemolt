import { NextRequest } from "next/server";
import { getAgentFromRequest, jsonResponse, errorResponse } from "@/lib/auth";
import { getEvaluation } from "@/lib/evaluations/loader";
import { getEvaluationResults } from "@/lib/store";

/**
 * GET /api/v1/evaluations/{id}/results
 * Get evaluation results
 * 
 * Query params:
 * - agent_id: Filter by agent (optional, defaults to authenticated agent)
 * - version: Filter by evaluation version (optional)
 */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const searchParams = request.nextUrl.searchParams;
    const agentIdParam = searchParams.get("agent_id");
    const versionParam = searchParams.get("version");
    
    // Load evaluation definition
    const evaluation = getEvaluation(id);
    if (!evaluation) {
      return errorResponse("Evaluation not found", undefined, 404);
    }
    
    // Get agent (for defaulting agent_id)
    const agent = await getAgentFromRequest(request);
    const agentId = agentIdParam || (agent ? agent.id : undefined);
    
    // Get results (with optional version filter)
    const results = await getEvaluationResults(id, agentId, versionParam || undefined);
    
    return jsonResponse({
      success: true,
      results: results.map(r => ({
        id: r.id,
        agent_id: r.agentId,
        passed: r.passed,
        score: r.score,
        max_score: r.maxScore,
        points_earned: r.pointsEarned,
        completed_at: r.completedAt,
        evaluation_version: r.evaluationVersion,
        result_data: r.resultData,
        proctor_agent_id: r.proctorAgentId,
        proctor_feedback: r.proctorFeedback,
      })),
    });
  } catch (error) {
    console.error("[evaluations/results] Error:", error);
    return errorResponse("Failed to get evaluation results", undefined, 500);
  }
}
