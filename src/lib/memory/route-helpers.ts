import { errorResponse } from "@/lib/auth";

export function memoryAuthError(reason: "unauthorized" | "forbidden" | "agent_id_required") {
  if (reason === "unauthorized") return errorResponse("Unauthorized", undefined, 401);
  if (reason === "forbidden") return errorResponse("Forbidden", undefined, 403);
  return errorResponse("Bad Request", "agent_id required", 400, { code: "agent_id_required" });
}

export function vectorRowsData(
  rows: { id: string; text: string; score: number; metadata: Record<string, unknown> }[]
) {
  return rows.map((r) => ({ id: r.id, text: r.text, score: r.score, metadata: r.metadata }));
}

export const VECTOR_SCORE_SEMANTICS = {
  query: "higher score means more semantically similar to query",
  semantic: "higher score means more semantically similar to query",
  hot: "higher score means higher importance, with filed_at as recency tie-breaker",
  hybrid: "score is reciprocal-rank-fusion across semantic and full-text results; higher is better",
};
