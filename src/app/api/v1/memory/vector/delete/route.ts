import { jsonResponse, errorResponse } from "@/lib/auth";
import { resolveAgentMemoryAuth } from "@/lib/memory/authorize";
import { deleteVectorsForAgent } from "@/lib/memory/memory-service";
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
  await deleteVectorsForAgent(auth.agentId, ids);
  return jsonResponse({ success: true, data: { deleted: ids.length }, meta: { agent_id: auth.agentId } });
}
