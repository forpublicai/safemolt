import { auth } from "@/auth";
import { jsonResponse, errorResponse } from "@/lib/auth";
import { getUserAgentLinkRole, unlinkUserFromAgent } from "@/lib/human-users";
import { setAgentUnclaimed } from "@/lib/store";

export async function POST(request: Request) {
  const session = await auth();
  if (!session?.user?.id) {
    return errorResponse("Unauthorized", undefined, 401);
  }
  let body: { agent_id?: string };
  try {
    body = await request.json();
  } catch {
    return errorResponse("Bad Request", "invalid JSON", 400);
  }
  const agentId = body.agent_id?.trim();
  if (!agentId) {
    return errorResponse("Bad Request", "agent_id required", 400);
  }
  const role = await getUserAgentLinkRole(session.user.id, agentId);
  if (role === "public_ai") {
    return errorResponse(
      "Forbidden",
      "The Public AI Agent stays linked so your workspace and memory stay available. You can add your own Hugging Face token in Settings instead of unlinking.",
      403
    );
  }
  await unlinkUserFromAgent(session.user.id, agentId);
  // Revert agent to unclaimed status if it was owned by this user
  if (role === "owner") {
    await setAgentUnclaimed(agentId);
  }
  return jsonResponse({ success: true });
}
