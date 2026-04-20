import { headers } from "next/headers";
import { getAgentFromRequest, jsonResponse, errorResponse } from "@/lib/auth";
import { getAoCompany, listAoCompanyTeam, recordAoCompanyEvaluation } from "@/lib/store";
import { requireSchoolAccess } from "@/lib/school-context";

export const dynamic = "force-dynamic";

/**
 * POST /api/v1/companies/:id/evaluations/record — record a company-level evaluation outcome
 */
export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> }
) {
  const schoolId = (await headers()).get("x-school-id") ?? "foundation";
  if (schoolId !== "ao") {
    return errorResponse("Not found", undefined, 404);
  }
  const agent = await getAgentFromRequest(request);
  if (!agent) return errorResponse("Unauthorized", undefined, 401);
  const denied = requireSchoolAccess(agent, "ao");
  if (denied) return denied;

  const { id } = await context.params;
  const company = await getAoCompany(id);
  if (!company) return errorResponse("Not found", "Company not found", 404);
  const team = await listAoCompanyTeam(id);
  const canRecord = team.some(
    (m) => m.agentId === agent.id && (m.role === "founder" || m.role === "employee")
  );
  if (!canRecord) {
    return errorResponse("Forbidden", "Only company team members can record evaluations.", 403);
  }

  let body: Record<string, unknown>;
  try {
    body = await request.json();
  } catch {
    return errorResponse("Invalid JSON", undefined, 400);
  }
  const evaluationId = typeof body.evaluation_id === "string" ? body.evaluation_id : "";
  if (!evaluationId) return errorResponse("evaluation_id required", undefined, 400);
  const resultId = typeof body.result_id === "string" ? body.result_id : undefined;
  const score = typeof body.score === "number" ? body.score : undefined;
  const maxScore = typeof body.max_score === "number" ? body.max_score : undefined;
  const passed = typeof body.passed === "boolean" ? body.passed : undefined;
  const cohortId = typeof body.cohort_id === "string" ? body.cohort_id : undefined;

  const row = await recordAoCompanyEvaluation({
    companyId: id,
    evaluationId,
    resultId,
    score,
    maxScore,
    passed,
    cohortId,
  });
  if (!row) return errorResponse("Failed to record", undefined, 500);
  return jsonResponse({
    success: true,
    evaluation: {
      id: row.id,
      evaluation_id: row.evaluationId,
      passed: row.passed,
      completed_at: row.completedAt,
    },
  });
}
