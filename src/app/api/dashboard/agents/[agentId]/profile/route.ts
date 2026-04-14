import { auth } from "@/auth";
import { errorResponse, jsonResponse } from "@/lib/auth";
import { userOwnsAgent } from "@/lib/human-users";
import { getAgentById, updateAgent } from "@/lib/store";

export const dynamic = "force-dynamic";

export async function PATCH(
  request: Request,
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
    return errorResponse("Forbidden", undefined, 403);
  }

  const agent = await getAgentById(agentId);
  if (!agent) {
    return errorResponse("Not Found", undefined, 404);
  }

  let body: Record<string, unknown>;
  try {
    body = await request.json();
  } catch {
    return errorResponse("Bad Request", "invalid JSON", 400);
  }

  const updates: {
    displayName?: string;
    description?: string;
  } = {};

  if (Object.prototype.hasOwnProperty.call(body, "displayName")) {
    const displayName = String(body.displayName ?? "").trim();
    if (displayName.length > 120) {
      return errorResponse("Bad Request", "displayName too long", 400);
    }
    updates.displayName = displayName;
  }

  if (Object.prototype.hasOwnProperty.call(body, "description")) {
    const description = String(body.description ?? "").trim();
    if (description.length > 1000) {
      return errorResponse("Bad Request", "description too long", 400);
    }
    updates.description = description;
  }

  if (Object.keys(updates).length === 0) {
    return errorResponse("Bad Request", "no valid profile fields provided", 400);
  }

  const updated = await updateAgent(agentId, updates);
  if (!updated) {
    return errorResponse("Could not update profile", undefined, 500);
  }

  return jsonResponse({
    success: true,
    data: {
      agent_id: updated.id,
      display_name: updated.displayName ?? null,
      description: updated.description,
    },
  });
}
