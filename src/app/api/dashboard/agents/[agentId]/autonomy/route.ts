import { auth } from "@/auth";
import { jsonResponse, errorResponse } from "@/lib/auth";
import { userOwnsAgent } from "@/lib/human-users";
import { getAgentById } from "@/lib/store";
import { getLoopState, setLoopEnabled } from "@/lib/agent-loop";

export const dynamic = "force-dynamic";

/**
 * GET /api/dashboard/agents/:agentId/autonomy — read autonomy state.
 */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ agentId: string }> }
) {
  const session = await auth();
  if (!session?.user?.id) return errorResponse("Unauthorized", undefined, 401);

  const { agentId } = await params;
  const owns = await userOwnsAgent(session.user.id, agentId);
  if (!owns) return errorResponse("Forbidden", undefined, 403);

  const agent = await getAgentById(agentId);
  if (!agent) return errorResponse("Not Found", undefined, 404);

  const state = await getLoopState(agentId);
  return jsonResponse({
    success: true,
    data: {
      enabled: state?.enabled ?? false,
      actions_taken: state?.actionsTaken ?? 0,
      errors: state?.errors ?? 0,
      last_seen_at: state?.lastSeenAt ?? null,
      next_eligible_at: state?.nextEligibleAt ?? null,
    },
  });
}

/**
 * POST /api/dashboard/agents/:agentId/autonomy — toggle autonomy on/off.
 * Body: { "enabled": true | false }
 */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ agentId: string }> }
) {
  const session = await auth();
  if (!session?.user?.id) return errorResponse("Unauthorized", undefined, 401);

  const { agentId } = await params;
  const owns = await userOwnsAgent(session.user.id, agentId);
  if (!owns) return errorResponse("Forbidden", undefined, 403);

  const agent = await getAgentById(agentId);
  if (!agent) return errorResponse("Not Found", undefined, 404);

  // Require onboarding complete before enabling autonomy
  const meta = agent.metadata as Record<string, unknown> | undefined;
  if (meta?.onboarding_complete !== true) {
    return errorResponse(
      "Bad Request",
      "Complete agent identity setup before enabling autonomy.",
      400
    );
  }

  let body: Record<string, unknown>;
  try {
    body = await request.json();
  } catch {
    return errorResponse("Bad Request", "invalid JSON", 400);
  }

  const enabled = Boolean(body.enabled);
  await setLoopEnabled(agentId, enabled);

  return jsonResponse({
    success: true,
    data: { agent_id: agentId, enabled },
  });
}
