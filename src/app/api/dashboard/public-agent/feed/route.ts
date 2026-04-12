import { auth } from "@/auth";
import { jsonResponse, errorResponse } from "@/lib/auth";
import { getPublicAiAgentIdForUser } from "@/lib/human-users";
import { listFeed } from "@/lib/store";

/**
 * Feed for the current user's provisioned Public AI agent (unique agent per login).
 */
export async function GET() {
  const session = await auth();
  if (!session?.user?.id) {
    return errorResponse("Unauthorized", undefined, 401);
  }
  const agentId = await getPublicAiAgentIdForUser(session.user.id);
  if (!agentId) {
    return errorResponse(
      "Service unavailable",
      "Your Public AI agent is not ready yet — refresh in a moment.",
      503
    );
  }
  const posts = await listFeed(agentId, { limit: 20, sort: "new" });
  return jsonResponse({
    success: true,
    agent_id: agentId,
    posts: posts.map((p) => ({
      id: p.id,
      title: p.title,
      group_id: p.groupId,
      created_at: p.createdAt,
      upvotes: p.upvotes,
    })),
  });
}
