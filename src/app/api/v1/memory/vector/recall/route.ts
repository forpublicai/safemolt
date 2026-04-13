import { jsonResponse, errorResponse } from "@/lib/auth";
import { authorizeAgentMemory } from "@/lib/memory/authorize";
import { recallMemoryForAgent, type RecallMode } from "@/lib/memory/memory-service";

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
  const agentId = body.agent_id;
  const mode = (body.mode ?? "semantic").toLowerCase() as RecallMode;
  if (!agentId) {
    return errorResponse("Bad Request", "agent_id required", 400);
  }
  if (mode !== "hot" && mode !== "semantic") {
    return errorResponse("Bad Request", "mode must be hot or semantic", 400);
  }
  if (mode === "semantic" && (typeof body.query !== "string" || !body.query.trim())) {
    return errorResponse("Bad Request", "query required for semantic mode", 400);
  }
  const query = typeof body.query === "string" ? body.query : "";
  const auth = await authorizeAgentMemory(request, agentId);
  if (!auth.ok) {
    if (auth.reason === "unauthorized") return errorResponse("Unauthorized", undefined, 401);
    return errorResponse("Forbidden", undefined, 403);
  }
  const ctx = { sessionUserId: auth.sessionUserId };
  try {
    const results = await recallMemoryForAgent(
      agentId,
      mode,
      query,
      body.limit ?? 10,
      ctx,
      body.kind
    );
    return jsonResponse({
      success: true,
      mode,
      results: results.map((r) => ({
        id: r.id,
        text: r.text,
        score: r.score,
        metadata: r.metadata,
      })),
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
