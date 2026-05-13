import { jsonResponse, errorResponse } from "@/lib/auth";
import { resolveAgentMemoryAuth } from "@/lib/memory/authorize";
import { recallMemoryForAgent, type RecallMode } from "@/lib/memory/memory-service";
import { memoryAuthError, VECTOR_SCORE_SEMANTICS, vectorRowsData } from "@/lib/memory/route-helpers";

export async function POST(request: Request) {
  let body: {
    agent_id?: string;
    mode?: string;
    query?: string;
    limit?: number;
    kind?: string;
  };
  try {
    body = await request.json();
  } catch {
    return errorResponse("Bad Request", "invalid JSON", 400);
  }
  const mode = (body.mode ?? "semantic").toLowerCase() as RecallMode;
  if (mode !== "hot" && mode !== "semantic") {
    return errorResponse("Bad Request", "mode must be hot or semantic", 400);
  }
  if (mode === "semantic" && (typeof body.query !== "string" || !body.query.trim())) {
    return errorResponse("Bad Request", "query required for semantic mode", 400);
  }
  const auth = await resolveAgentMemoryAuth(request, body.agent_id);
  if (!auth.ok) return memoryAuthError(auth.reason);
  const query = typeof body.query === "string" ? body.query : "";
  const ctx = { sessionUserId: auth.sessionUserId };
  try {
    const results = await recallMemoryForAgent(auth.agentId, mode, query, body.limit ?? 10, ctx, body.kind);
    const data = { mode, results: vectorRowsData(results) };
    return jsonResponse({
      success: true,
      data,
      meta: {
        agent_id: auth.agentId,
        mode,
        score_semantics: mode === "hot" ? VECTOR_SCORE_SEMANTICS.hot : VECTOR_SCORE_SEMANTICS.semantic,
      },
      mode,
      results: data.results,
    });
  } catch (e) {
    console.error("[memory] recall", e);
    const msg = e instanceof Error ? e.message : String(e);
    if (msg.startsWith("PUBLIC_AI_SPONSORED_DAILY_LIMIT")) {
      return errorResponse("Too many requests", msg.split(": ").slice(1).join(": ") || msg, 429);
    }
    return errorResponse("Service unavailable", "vector store failed", 503);
  }
}
