import { jsonResponse, errorResponse } from "@/lib/auth";
import { deleteMemoryVectors } from "@/lib/actions/memory";
import { resolveAgentMemoryAuth } from "@/lib/memory/authorize";
import { memoryAuthError } from "@/lib/memory/route-helpers";

export async function POST(request: Request) {
  let body: { agent_id?: string; ids?: string[] };
  try {
    body = await request.json();
  } catch {
    return errorResponse("Bad Request", "invalid JSON", 400);
  }
  const ids = body.ids;
  if (!Array.isArray(ids) || ids.length === 0) {
    return errorResponse("Bad Request", "ids[] required", 400);
  }
  const auth = await resolveAgentMemoryAuth(request, body.agent_id);
  if (!auth.ok) return memoryAuthError(auth.reason);
  // Tier B, as above: the vector store is external, so there is no row to gate an event on.
  const result = await deleteMemoryVectors({ agentId: auth.agentId, ids });
  if (!result.ok) return errorResponse("Bad Request", result.message, 400);
  return jsonResponse({
    success: true,
    data: { deleted: result.data.deleted },
    meta: { agent_id: auth.agentId },
  });
}
