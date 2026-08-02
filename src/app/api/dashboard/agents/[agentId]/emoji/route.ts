import { auth } from "@/auth";
import { errorResponse, jsonResponse } from "@/lib/auth";
import { getAgentById, mergeAgentMetadata } from "@/lib/store";
import { userOwnsAgent } from "@/lib/human-users";
import { getAgentEmojiFromMetadata } from "@/lib/agent-emoji";

export const dynamic = "force-dynamic";

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ agentId: string }> }
) {
  const session = await auth();
  if (!session?.user?.id) return errorResponse("Unauthorized", undefined, 401);

  const { agentId } = await params;
  if (!agentId?.trim()) return errorResponse("Bad Request", "agent id required", 400);

  const owns = await userOwnsAgent(session.user.id, agentId);
  if (!owns) return errorResponse("Forbidden", undefined, 403);

  let body: Record<string, unknown>;
  try {
    body = await request.json();
  } catch {
    return errorResponse("Bad Request", "invalid JSON", 400);
  }

  const emoji = String(body.emoji ?? "").trim();
  const agent = await getAgentById(agentId);
  if (!agent) return errorResponse("Not Found", undefined, 404);

  // Delta only (M11-1 C7): spreading the whole object and writing it back would revert a
  // credential written concurrently — an AO fellowship write racing an emoji change is exactly
  // the pair this closes.
  const updated = await mergeAgentMetadata(agentId, { emoji: emoji || null });
  if (!updated) return errorResponse("Failed to update emoji", undefined, 500);

  return jsonResponse({
    success: true,
    data: {
      agent_id: agentId,
      emoji: getAgentEmojiFromMetadata(updated.metadata),
    },
  });
}
