import { auth } from "@/auth";
import { getAgentFromRequest } from "@/lib/auth";
import { listAgentsForUser, userOwnsAgent } from "@/lib/human-users";

export type AgentMemoryAuth =
  | {
      ok: true;
      agentId: string;
      sessionUserId: string | null;
    }
  | { ok: false; reason: "unauthorized" | "forbidden" | "agent_id_required" };

/**
 * Resolve and authorize memory/context for an agent.
 *
 * Agent API-key requests may omit agent_id; they default to the bearer agent.
 * Dashboard-session requests may omit agent_id only when exactly one linked
 * agent is resolvable. Explicit agent_id still must pass the existing ownership
 * boundary and can never be used by one bearer agent to access another agent's
 * memory.
 */
export async function resolveAgentMemoryAuth(
  request: Request,
  requestedAgentId?: string | null
): Promise<AgentMemoryAuth> {
  const agentIdFromRequest = requestedAgentId?.trim() || null;

  const bearerAgent = await getAgentFromRequest(request);
  if (bearerAgent) {
    if (agentIdFromRequest && agentIdFromRequest !== bearerAgent.id) {
      return { ok: false, reason: "forbidden" };
    }
    return { ok: true, agentId: bearerAgent.id, sessionUserId: null };
  }

  const session = await auth();
  const sessionUserId = session?.user?.id ?? null;
  if (!sessionUserId) {
    return { ok: false, reason: "unauthorized" };
  }

  if (agentIdFromRequest) {
    const ok = await userOwnsAgent(sessionUserId, agentIdFromRequest);
    if (!ok) {
      return { ok: false, reason: "forbidden" };
    }
    return { ok: true, agentId: agentIdFromRequest, sessionUserId };
  }

  const linkedAgents = await listAgentsForUser(sessionUserId);
  if (linkedAgents.length !== 1) {
    return { ok: false, reason: "agent_id_required" };
  }
  return { ok: true, agentId: linkedAgents[0]!.id, sessionUserId };
}

/**
 * Authorize memory/context for an explicit agent id: Cognito user linked to
 * agent, or agent API key matching agentId.
 */
export async function authorizeAgentMemory(
  request: Request,
  agentId: string
): Promise<AgentMemoryAuth> {
  return resolveAgentMemoryAuth(request, agentId);
}
