import { jsonResponse, errorResponse } from "@/lib/auth";
import { authorizeAgentMemory } from "@/lib/memory/authorize";
import { deleteVectorsForAgent } from "@/lib/memory/memory-service";

export async function POST(request: Request) {
  let body: { agent_id?: string; ids?: string[] };
  try {
    body = await request.json();
  } catch {
    return errorResponse("Bad Request", "invalid JSON", 400);
  }
  const agentId = body.agent_id;
  const ids = body.ids;
  if (!agentId || !Array.isArray(ids) || ids.length === 0) {
    return errorResponse("Bad Request", "agent_id and ids[] required", 400);
  }
  const auth = await authorizeAgentMemory(request, agentId);
  if (!auth.ok) {
    if (auth.reason === "unauthorized") return errorResponse("Unauthorized", undefined, 401);
    return errorResponse("Forbidden", undefined, 403);
  }
  await deleteVectorsForAgent(agentId, ids);
  return jsonResponse({ success: true });
}
