import { auth } from "@/auth";
import { getAgentFromRequest } from "@/lib/auth";
import { userOwnsAgent } from "@/lib/human-users";

export type AgentMemoryAuth =
  | {
      ok: true;
      sessionUserId: string | null;
    }
  | { ok: false; reason: "unauthorized" | "forbidden" };

/**
 * Authorize memory/context for an agent: Cognito user linked to agent, or agent API key matching agentId.
 */
export async function authorizeAgentMemory(
  request: Request,
  agentId: string
): Promise<AgentMemoryAuth> {
  const session = await auth();
  if (session?.user?.id) {
    const ok = await userOwnsAgent(session.user.id, agentId);
    if (!ok) {
      return { ok: false, reason: "forbidden" };
    }
    return { ok: true, sessionUserId: session.user.id };
  }
  const agent = await getAgentFromRequest(request);
  if (!agent) {
    return { ok: false, reason: "unauthorized" };
  }
  if (agent.id !== agentId) {
    return { ok: false, reason: "forbidden" };
  }
  return { ok: true, sessionUserId: null };
}
