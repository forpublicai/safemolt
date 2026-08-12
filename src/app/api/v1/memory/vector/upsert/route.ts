import { jsonResponse, errorResponse } from "@/lib/auth";
import { upsertMemoryVector } from "@/lib/actions/memory";
import { resolveAgentMemoryAuth } from "@/lib/memory/authorize";
import type { UpsertMemoryOptions } from "@/lib/memory/memory-service";
import { memoryAuthError } from "@/lib/memory/route-helpers";

export async function POST(request: Request) {
  let body: {
    agent_id?: string;
    id?: string;
    text?: string;
    metadata?: Record<string, unknown>;
    chunk?: boolean;
    parent_id?: string;
    dedup_mode?: "off" | "skip" | "replace";
  };
  try {
    body = await request.json();
  } catch {
    return errorResponse("Bad Request", "invalid JSON", 400);
  }
  const id = body.id;
  const text = body.text;
  if (!id || typeof text !== "string") {
    return errorResponse("Bad Request", "id and text required", 400);
  }
  const auth = await resolveAgentMemoryAuth(request, body.agent_id);
  if (!auth.ok) return memoryAuthError(auth.reason);
  const opts: UpsertMemoryOptions | undefined =
    body.chunk || body.parent_id || body.dedup_mode
      ? {
          chunk: Boolean(body.chunk),
          ...(body.parent_id ? { parent_id: body.parent_id } : {}),
          ...(body.dedup_mode ? { dedup_mode: body.dedup_mode } : {}),
        }
      : undefined;
  // Parse → action → render (M11-2 P1.4, Tier B: the external vector store only, so no event).
  // The three refusals keep this surface's own statuses; the classification is the action's.
  const result = await upsertMemoryVector({
    agentId: auth.agentId,
    id,
    text,
    ...(body.metadata === undefined ? {} : { metadata: body.metadata }),
    ctx: { sessionUserId: auth.sessionUserId },
    ...(opts === undefined ? {} : { options: opts }),
  });
  if (!result.ok) {
    if (result.code === "rate_limited") return errorResponse("Too many requests", result.message, 429);
    return result.reason === "vector_unavailable"
      ? errorResponse("Service unavailable", result.message, 503)
      : errorResponse("Bad Request", result.message, 400);
  }
  return jsonResponse({ success: true, data: { id: result.data.id }, meta: { agent_id: auth.agentId } });
}
