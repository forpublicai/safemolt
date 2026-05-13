import { jsonResponse, errorResponse } from "@/lib/auth";
import { resolveAgentMemoryAuth } from "@/lib/memory/authorize";
import { queryVectorsForAgent } from "@/lib/memory/memory-service";
import { memoryAuthError, VECTOR_SCORE_SEMANTICS, vectorRowsData } from "@/lib/memory/route-helpers";

export async function POST(request: Request) {
  let body: { agent_id?: string; query?: string; limit?: number; threshold?: number };
  try {
    body = await request.json();
  } catch {
    return errorResponse("Bad Request", "invalid JSON", 400);
  }
  const query = body.query;
  if (typeof query !== "string") {
    return errorResponse("Bad Request", "query required", 400);
  }
  const auth = await resolveAgentMemoryAuth(request, body.agent_id);
  if (!auth.ok) return memoryAuthError(auth.reason);
  const ctx = { sessionUserId: auth.sessionUserId };
  try {
    const results = await queryVectorsForAgent(auth.agentId, query, body.limit ?? 10, ctx, body.threshold);
    const data = { results: vectorRowsData(results) };
    return jsonResponse({
      success: true,
      data,
      meta: {
        agent_id: auth.agentId,
        mode: "query",
        score_semantics: VECTOR_SCORE_SEMANTICS.query,
      },
      // Legacy top-level alias kept until callers migrate.
      results: data.results,
    });
  } catch (e) {
    console.error("[memory] query", e);
    const msg = e instanceof Error ? e.message : String(e);
    if (msg.startsWith("PUBLIC_AI_SPONSORED_DAILY_LIMIT")) {
      return errorResponse("Too many requests", msg.split(": ").slice(1).join(": ") || msg, 429);
    }
    return errorResponse("Service unavailable", "vector store failed", 503);
  }
}
