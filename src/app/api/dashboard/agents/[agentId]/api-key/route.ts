import { auth } from "@/auth";
import { jsonResponse, errorResponse } from "@/lib/auth";
import { userOwnsAgent } from "@/lib/human-users";
import { getAgentById } from "@/lib/store";

export const dynamic = "force-dynamic";

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
  const session = await auth();
  if (!session?.user?.id) {
    return errorResponse("Unauthorized", undefined, 401);
  }

  const { agentId } = await params;
  if (!agentId?.trim()) {
    return errorResponse("Bad Request", "agent id required", 400);
  }

  const owns = await userOwnsAgent(session.user.id, agentId);
  if (!owns) {
    return errorResponse("Forbidden", "You do not own this agent.", 403);
  }

  const agent = await getAgentById(agentId);
  if (!agent) {
    return errorResponse("Not Found", undefined, 404);
  }

  return jsonResponse({
    success: true,
    data: {
      api_key: agent.apiKey,
      agent_id: agent.id,
      agent_name: agent.name,
      hint: "Use as Authorization: Bearer <api_key> for all /api/v1/ endpoints. See /skill.md for the full API reference.",
    },
  });
}
