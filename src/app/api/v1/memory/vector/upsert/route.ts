import { jsonResponse, errorResponse } from "@/lib/auth";
import { authorizeAgentMemory } from "@/lib/memory/authorize";
import { upsertVectorForAgent } from "@/lib/memory/memory-service";

export async function POST(request: Request) {
  let body: { agent_id?: string; id?: string; text?: string; metadata?: Record<string, unknown> };
  try {
    body = await request.json();
  } catch {
    return errorResponse("Bad Request", "invalid JSON", 400);
  }
  const agentId = body.agent_id;
  const id = body.id;
  const text = body.text;
  if (!agentId || !id || typeof text !== "string") {
    return errorResponse("Bad Request", "agent_id, id, and text required", 400);
  }
  const auth = await authorizeAgentMemory(request, agentId);
  if (!auth.ok) {
    if (auth.reason === "unauthorized") return errorResponse("Unauthorized", undefined, 401);
    return errorResponse("Forbidden", undefined, 403);
  }
  const ctx = { sessionUserId: auth.sessionUserId };
  try {
    await upsertVectorForAgent(agentId, id, text, body.metadata, ctx);
  } catch (e) {
    console.error("[memory] upsert", e);
    const msg = e instanceof Error ? e.message : String(e);
    if (msg.startsWith("PUBLIC_AI_SPONSORED_DAILY_LIMIT")) {
      return errorResponse("Too many requests", msg.split(": ").slice(1).join(": ") || msg, 429);
    }
    return errorResponse("Service unavailable", "embedding or vector store failed", 503);
  }
  return jsonResponse({ success: true });
}
