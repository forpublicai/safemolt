import { auth } from "@/auth";
import { jsonResponse, errorResponse } from "@/lib/auth";
import { userOwnsAgent } from "@/lib/human-users";
import { getAgentById, rotateAgentApiKey } from "@/lib/store";

export const dynamic = "force-dynamic";

/**
 * Session + ownership gate shared by GET and POST — the same contract the sibling routes use.
 * The returned `userId` matters for POST: the rotation re-derives ownership **inside its own
 * statement** (review round 2, B2), so this check is the friendly 403, not the decision.
 */
async function requireOwnedAgentId(params: Promise<{ agentId: string }>): Promise<{ agentId: string; userId: string } | { response: Response }> {
  const session = await auth();
  if (!session?.user?.id) {
    return { response: errorResponse("Unauthorized", undefined, 401) };
  }
  const { agentId } = await params;
  if (!agentId?.trim()) {
    return { response: errorResponse("Bad Request", "agent id required", 400) };
  }
  const owns = await userOwnsAgent(session.user.id, agentId);
  if (!owns) {
    return { response: errorResponse("Forbidden", "You do not own this agent.", 403) };
  }
  return { agentId, userId: session.user.id };
}

/**
 * GET /api/dashboard/agents/:agentId/api-key
 *
 * Returns the agent's API key to the owning human user.
 * Gated by session auth + ownership check.
 */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ agentId: string }> }
) {
  const gate = await requireOwnedAgentId(params);
  if ("response" in gate) return gate.response;

  const agent = await getAgentById(gate.agentId);
  if (!agent) {
    return errorResponse("Not Found", undefined, 404);
  }

  return jsonResponse({
    success: true,
    data: {
      api_key: agent.apiKey,
      agent_id: agent.id,
      agent_name: agent.name,
      hint: "Use as Authorization: Bearer *** for all /api/v1/ endpoints. See /reference.md for the full API reference or /skill.md for startup instructions.",
    },
  });
}

/**
 * POST /api/dashboard/agents/:agentId/api-key — M11-1 C17 (OQ-4 option b), the opt-in re-issue.
 *
 * A specified amendment to Locked decision 2, not a smuggled surface: authenticated by the same
 * Cognito session + ownership gate as GET, the new key is returned ONCE in the same shape GET
 * returns, and the old key stops authenticating immediately — no dual-accept window, because the
 * path is user-initiated and the user has the new key in hand.
 */
export async function POST(
  _request: Request,
  { params }: { params: Promise<{ agentId: string }> }
) {
  const gate = await requireOwnedAgentId(params);
  if ("response" in gate) return gate.response;

  const agent = await getAgentById(gate.agentId);
  if (!agent) {
    return errorResponse("Not Found", undefined, 404);
  }

  // Ownership is re-derived by the rotation statement itself: a caller whose ownership was
  // revoked between the gate above and this call gets a refusal, not a working key (B2).
  const newKey = await rotateAgentApiKey(gate.agentId, gate.userId);
  if (!newKey) {
    return errorResponse("Forbidden", "You do not own this agent.", 403);
  }

  return jsonResponse({
    success: true,
    data: {
      api_key: newKey,
      agent_id: agent.id,
      agent_name: agent.name,
      hint: "This is your NEW API key — the previous key no longer authenticates. Use as Authorization: Bearer *** for all /api/v1/ endpoints.",
    },
  });
}
