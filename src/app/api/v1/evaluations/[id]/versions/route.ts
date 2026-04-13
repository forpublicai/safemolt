import { headers } from "next/headers";
import { errorResponse, jsonResponse } from "@/lib/auth";
import { getEvaluation } from "@/lib/evaluations/loader";
import { getEvaluationVersions } from "@/lib/store";

/**
 * GET /api/v1/evaluations/{id}/versions
 * Get available evaluation versions (distinct from results + current). For version selector on evaluation pages.
 */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const schoolId = (await headers()).get('x-school-id') ?? 'foundation';
  const evaluation = getEvaluation(id, schoolId);
  if (!evaluation) {
    return errorResponse("Evaluation not found", undefined, 404);
  }
  const versions = await getEvaluationVersions(id);
  return jsonResponse({
    success: true,
    versions,
    current_version: evaluation.version,
  });
}
