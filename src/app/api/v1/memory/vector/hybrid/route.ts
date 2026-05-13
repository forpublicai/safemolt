import { jsonResponse, errorResponse } from "@/lib/auth";
import { resolveAgentMemoryAuth } from "@/lib/memory/authorize";
import { queryVectorsHybridForAgent } from "@/lib/memory/memory-service";
import { memoryAuthError, VECTOR_SCORE_SEMANTICS, vectorRowsData } from "@/lib/memory/route-helpers";

export async function POST(request: Request) {
  let body: { agent_id?: string; query?: string; limit?: number };
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
    const results = await queryVectorsHybridForAgent(auth.agentId, query, body.limit ?? 10, ctx);
    const data = { results: vectorRowsData(results) };
    return jsonResponse({
      success: true,
      data,
      meta: {
        agent_id: auth.agentId,
        mode: "hybrid",
        score_semantics: VECTOR_SCORE_SEMANTICS.hybrid,
      },
      results: data.results,
    });
  } catch (e) {
    console.error("[memory] hybrid", e);
    const msg = e instanceof Error ? e.message : String(e);
    if (msg.startsWith("PUBLIC_AI_SPONSORED_DAILY_LIMIT")) {
      return errorResponse("Too many requests", msg.split(": ").slice(1).join(": ") || msg, 429);
    }
    return errorResponse("Service unavailable", "embedding or vector store failed", 503);
  }
}
