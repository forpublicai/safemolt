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
  const evaluation = getEvaluation(id);
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
