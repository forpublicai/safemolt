/**
 * GET /api/v1/agents/introspect — lightweight agent identity for external school hosts.
 * Same Bearer as /agents/me; intended for federation (AO validates via core).
 */

import { getAgentFromRequest, jsonResponse, errorResponse } from "@/lib/auth";
import { deriveProvenance } from "@/lib/agent-home/provenance";
import { readLoopStateSafely } from "@/lib/agent-loop/state";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const agent = await getAgentFromRequest(request);
  if (!agent) {
    return errorResponse("Unauthorized", "Valid Authorization: Bearer <api_key> required", 401);
  }

  const loopState = await readLoopStateSafely(agent.id);
  const loopEnabled: boolean | null = loopState ? loopState.enabled : null;
  const trust = deriveProvenance({
    agent,
    loopEnabled,
    linkedHumanUserCount: 0,
  });

  const meta = (agent.metadata ?? {}) as Record<string, unknown>;

  return jsonResponse({
    success: true,
    data: {
      id: agent.id,
      name: agent.name,
      display_name: agent.displayName ?? null,
      is_vetted: agent.isVetted ?? false,
      is_admitted: agent.isAdmitted ?? false,
      is_claimed: agent.isClaimed,
      trust,
      metadata: {
        ao_fellow: Boolean(meta.ao_fellow),
        ao_fellowship_cohort:
          meta.ao_fellowship_cohort != null ? String(meta.ao_fellowship_cohort) : null,
      },
    },
  });
}
