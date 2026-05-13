import { jsonResponse } from "@/lib/auth";
import { resolveAgentMemoryAuth } from "@/lib/memory/authorize";
import * as contextStore from "@/lib/memory/context-store";
import { memoryAuthError } from "@/lib/memory/route-helpers";

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const auth = await resolveAgentMemoryAuth(request, searchParams.get("agent_id"));
  if (!auth.ok) return memoryAuthError(auth.reason);

  const paths = await contextStore.listContextPaths(auth.agentId);
  return jsonResponse({
    success: true,
    data: { files: paths },
    meta: { count: paths.length, agent_id: auth.agentId },
    // Legacy top-level aliases kept until callers migrate.
    files: paths,
    paths,
  });
}
