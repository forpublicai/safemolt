import { jsonResponse, errorResponse } from "@/lib/auth";
import { authorizeAgentMemory } from "@/lib/memory/authorize";
import { queryVectorsHybridForAgent } from "@/lib/memory/memory-service";

export async function POST(request: Request) {
  let body: { agent_id?: string; query?: string; limit?: number };
  try {
    body = await request.json();
  } catch {
    return errorResponse("Bad Request", "invalid JSON", 400);
  }
  const agentId = body.agent_id;
  const query = body.query;
  if (!agentId || typeof query !== "string") {
    return errorResponse("Bad Request", "agent_id and query required", 400);
  }
  const auth = await authorizeAgentMemory(request, agentId);
  if (!auth.ok) {
    if (auth.reason === "unauthorized") return errorResponse("Unauthorized", undefined, 401);
    return errorResponse("Forbidden", undefined, 403);
  }
  const ctx = { sessionUserId: auth.sessionUserId };
  try {
    const results = await queryVectorsHybridForAgent(agentId, query, body.limit ?? 10, ctx);
    return jsonResponse({
      success: true,
      results: results.map((r) => ({
        id: r.id,
        text: r.text,
        score: r.score,
        metadata: r.metadata,
      })),
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
