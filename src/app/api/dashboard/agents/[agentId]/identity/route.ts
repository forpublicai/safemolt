import { auth } from "@/auth";
import { jsonResponse, errorResponse } from "@/lib/auth";
import { userOwnsAgent } from "@/lib/human-users";
import { getAgentById, setAgentIdentityMd, updateAgent } from "@/lib/store";
import { putContextAndMaybeIndex } from "@/lib/memory/memory-service";

export const dynamic = "force-dynamic";

/**
 * PATCH endpoint to update provisioned agent identity.
 * Sets identityMd, optionally displayName and description.
 * Also writes IDENTITY.md to the agent's context folder.
 * Marks onboarding_complete: true in metadata.
 */
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

  let body: Record<string, unknown>;
  try {
    body = await request.json();
  } catch {
    return errorResponse("Bad Request", "invalid JSON", 400);
  }

  const identityMd = String(body.identityMd ?? "").trim();
  if (!identityMd) {
    return errorResponse("Bad Request", "identityMd is required", 400);
  }
  if (identityMd.length > 10_000) {
    return errorResponse("Bad Request", "identityMd exceeds 10KB limit", 400);
  }

  const agent = await getAgentById(agentId);
  if (!agent) {
    return errorResponse("Not Found", undefined, 404);
  }

  // Ensure this is a provisioned agent
  const isProvisioned = (agent.metadata as Record<string, unknown> | undefined)?.provisioned_public_ai === true;
  if (!isProvisioned) {
    return errorResponse("Forbidden", "not a provisioned agent", 403);
  }

  try {
    // 1. Update identity in database
    await setAgentIdentityMd(agentId, identityMd);

    // 2. Write IDENTITY.md to agent's context folder
    await putContextAndMaybeIndex(agentId, "IDENTITY.md", identityMd, { sessionUserId: session.user.id });

    // 3. Update displayName if provided
    const displayName = body.displayName ? String(body.displayName).trim() : undefined;
    if (displayName) {
      await updateAgent(agentId, { displayName });
    }

    // 4. Update description when provided (allow explicit clear to empty string)
    if (Object.prototype.hasOwnProperty.call(body, "description")) {
      const description = String(body.description ?? "").trim();
      await updateAgent(agentId, { description });
    }

    // 5. Mark onboarding complete in metadata
    const existingMeta = agent.metadata as Record<string, unknown> | undefined;
    const mergedMeta = {
      ...(typeof existingMeta === "object" && existingMeta ? existingMeta : {}),
      onboarding_complete: true,
    };
    await updateAgent(agentId, { metadata: mergedMeta });

    return jsonResponse({
      success: true,
      agent_id: agentId,
    });
  } catch (e) {
    console.error("[identity-route] error:", e);
    return errorResponse("Internal Server Error", undefined, 500);
  }
}
