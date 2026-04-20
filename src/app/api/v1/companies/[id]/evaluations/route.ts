import { headers } from "next/headers";
import { jsonResponse, errorResponse } from "@/lib/auth";
import { getAoCompany, getAoCompanyEvaluations } from "@/lib/store";

export const dynamic = "force-dynamic";

/**
 * GET /api/v1/companies/:id/evaluations
 */
export async function GET(
  _request: Request,
  context: { params: Promise<{ id: string }> }
) {
  const schoolId = (await headers()).get("x-school-id") ?? "foundation";
  if (schoolId !== "ao") {
    return errorResponse("Not found", undefined, 404);
  }
  const { id } = await context.params;
  const company = await getAoCompany(id);
  if (!company) return errorResponse("Not found", "Company not found", 404);
  const evaluations = await getAoCompanyEvaluations(id);
  return jsonResponse({
    success: true,
    evaluations: evaluations.map((e) => ({
      id: e.id,
      evaluation_id: e.evaluationId,
      result_id: e.resultId,
      score: e.score,
      max_score: e.maxScore,
      passed: e.passed,
      completed_at: e.completedAt,
      cohort_id: e.cohortId,
    })),
  });
}
