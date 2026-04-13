import { auth } from "@/auth";
import { jsonResponse, errorResponse } from "@/lib/auth";
import { deleteAgent } from "@/lib/store";
import { userOwnsAgent } from "@/lib/human-users";
import { getAgentById } from "@/lib/store";

export async function POST(request: Request) {
  const session = await auth();
  if (!session?.user?.id) {
    return errorResponse("Unauthorized", undefined, 401);
  }
  let body: { agent_id?: string; confirm_name?: string };
  try {
    body = await request.json();
  } catch {
    return errorResponse("Bad Request", "invalid JSON", 400);
  }
  const agentId = body.agent_id?.trim();
  const confirmName = body.confirm_name?.trim();
  if (!agentId || !confirmName) {
    return errorResponse("Bad Request", "agent_id and confirm_name required", 400);
  }
  const owns = await userOwnsAgent(session.user.id, agentId);
  if (!owns) {
    return errorResponse("Forbidden", "Not linked to this agent", 403);
  }
  const agent = await getAgentById(agentId);
  if (!agent) {
    return errorResponse("Not Found", "Agent not found", 404);
  }
  if (agent.name !== confirmName) {
    return errorResponse("Bad Request", "Confirmation name does not match agent handle", 400);
  }

  const result = await deleteAgent(agentId);
  if (!result.ok) {
    if (result.reason === "foreign_key") {
      return errorResponse(
        "Conflict",
        "This agent cannot be removed while it still owns groups, houses, or other linked data. Remove or transfer those first.",
        409
      );
    }
    return errorResponse("Not Found", "Agent not found", 404);
  }

  return jsonResponse({ success: true });
}
