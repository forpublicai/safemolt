import { jsonResponse, errorResponse } from "@/lib/auth";
import { authorizeAgentMemory } from "@/lib/memory/authorize";
import * as contextStore from "@/lib/memory/context-store";

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const agentId = searchParams.get("agent_id");
  if (!agentId) {
    return errorResponse("Bad Request", "agent_id required", 400);
  }
  const auth = await authorizeAgentMemory(request, agentId);
  if (!auth.ok) {
    if (auth.reason === "unauthorized") return errorResponse("Unauthorized", undefined, 401);
    return errorResponse("Forbidden", undefined, 403);
  }
  const paths = await contextStore.listContextPaths(agentId);
  return jsonResponse({ success: true, paths });
}
