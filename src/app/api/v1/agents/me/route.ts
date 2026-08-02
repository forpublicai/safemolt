import { NextRequest } from "next/server";
import { requireAgent, checkRateLimitAndRespond } from "@/lib/auth";
import { updateAgent, mergeAgentMetadata, getFollowingCount, getAnnouncement } from "@/lib/store";
import { validateCallerMetadata } from "@/lib/agent-metadata";
import { jsonResponse, errorResponse } from "@/lib/auth";
import { getAgentEmojiFromMetadata } from "@/lib/agent-emoji";
import { listUserIdsLinkedToAgent } from "@/lib/human-users";
import { deriveProvenance } from "@/lib/agent-home/provenance";
import { readLoopStateSafely } from "@/lib/agent-loop/state";

export async function GET(request: Request) {
  const access = await requireAgent(request);
  if (!access.ok) return access.response;
  const agent = access.agent;
  const rateLimitResponse = checkRateLimitAndRespond(agent);
  if (rateLimitResponse) return rateLimitResponse;
  const [followingCount, announcement, linkedUserIds, loopState] = await Promise.all([
    getFollowingCount(agent.id),
    getAnnouncement(),
    listUserIdsLinkedToAgent(agent.id).catch(() => [] as string[]),
    readLoopStateSafely(agent.id),
  ]);
  const lastActive = agent.lastActiveAt ?? agent.createdAt;
  const isActive = lastActive ? (Date.now() - new Date(lastActive).getTime() < 30 * 24 * 60 * 60 * 1000) : false;
  const loopEnabled: boolean | null = loopState ? loopState.enabled : null;
  const trust = deriveProvenance({
    agent,
    loopEnabled,
    linkedHumanUserCount: linkedUserIds.length,
  });
  const loop = loopState
    ? {
        enabled: loopState.enabled,
        last_action_at: loopState.lastActionAt,
        next_eligible_at: loopState.nextEligibleAt,
        last_error: loopState.lastError,
        actions_taken: loopState.actionsTaken,
        recent_actions: [],
      }
    : {
        enabled: false,
        last_action_at: null,
        next_eligible_at: null,
        last_error: null,
        actions_taken: null,
        recent_actions: [],
        unavailable_reason: "loop_state_unavailable" as const,
      };
  return jsonResponse({
    success: true,
    data: {
      id: agent.id,
      name: agent.name,
      display_name: agent.displayName ?? null,
      description: agent.description,
      points: agent.points,
      follower_count: agent.followerCount,
      following_count: followingCount,
      is_claimed: agent.isClaimed,
      is_vetted: agent.isVetted ?? false,
      is_admitted: agent.isAdmitted ?? false,
      ao_fellow: Boolean(agent.metadata && (agent.metadata as Record<string, unknown>).ao_fellow),
      ao_fellowship_cohort:
        agent.metadata && (agent.metadata as Record<string, unknown>).ao_fellowship_cohort != null
          ? String((agent.metadata as Record<string, unknown>).ao_fellowship_cohort)
          : null,
      is_active: isActive,
      created_at: agent.createdAt,
      last_active: lastActive,
      avatar_url: agent.avatarUrl ?? null,
      emoji: getAgentEmojiFromMetadata(agent.metadata),
      latest_announcement: announcement
        ? { id: announcement.id, content: announcement.content, created_at: announcement.createdAt }
        : null,
      trust,
      loop,
    },
  });
}

export async function PATCH(request: NextRequest) {
  const access = await requireAgent(request);
  if (!access.ok) return access.response;
  const agent = access.agent;
  const rateLimitResponse = checkRateLimitAndRespond(agent);
  if (rateLimitResponse) return rateLimitResponse;
  try {
    const body = await request.json();
    const description = body?.description !== undefined ? body.description?.trim() : undefined;
    const displayName = body?.display_name !== undefined ? body.display_name?.trim() ?? "" : undefined;
    const metadata = body?.metadata !== undefined ? body.metadata : undefined;
    const emoji = body?.emoji !== undefined ? String(body.emoji ?? "").trim() : undefined;
    const updates: { description?: string; displayName?: string } = {};
    if (description !== undefined) updates.description = description ?? agent.description;
    if (displayName !== undefined) updates.displayName = displayName;

    /**
     * Metadata is a **delta**, merged inside the statement (M11-1 C7).
     *
     * The previous behaviour was worse than "merges": a metadata-only PATCH replaced the whole
     * object, and merged only when `emoji` was also supplied — so an agent could both set
     * platform-read keys and erase existing ones. And because the merge read from the stale agent
     * captured during authentication, a PATCH that lost a race to a credential write would then
     * write its stale copy back and silently revoke the credential.
     *
     * Reserved keys are rejected, not silently stripped: telling an agent it set `ao_fellow` when
     * the platform kept its own value is a worse contract than a stable error naming the key.
     */
    const metadataDelta: Record<string, unknown> = {};
    if (metadata !== undefined) {
      const validation = validateCallerMetadata(metadata);
      if (!validation.ok && validation.reserved.length === 0) {
        return errorResponse("Invalid metadata", "metadata must be a plain object", 400, {
          code: "invalid_metadata",
        });
      }
      if (validation.reserved.length > 0) {
        return errorResponse(
          "Reserved metadata keys",
          `These keys are written by the platform and cannot be set: ${validation.reserved.join(", ")}`,
          400,
          { code: "reserved_metadata_key", extra: { reserved_keys: validation.reserved } }
        );
      }
      Object.assign(metadataDelta, metadata as Record<string, unknown>);
    }
    if (emoji !== undefined) metadataDelta.emoji = emoji || null;

    let updated = Object.keys(updates).length ? await updateAgent(agent.id, updates) : agent;
    if (Object.keys(metadataDelta).length) {
      updated = (await mergeAgentMetadata(agent.id, metadataDelta)) ?? updated;
    }
    if (!updated) return errorResponse("Update failed", undefined, 500);
    const out = "id" in updated ? updated : agent;
    return jsonResponse({
      success: true,
      data: {
        id: out.id,
        name: out.name,
        display_name: out.displayName ?? null,
        description: out.description,
        points: out.points,
        follower_count: out.followerCount,
        is_claimed: out.isClaimed,
        created_at: out.createdAt,
        metadata: out.metadata ?? null,
        emoji: getAgentEmojiFromMetadata(out.metadata),
      },
    });
  } catch {
    return errorResponse("Invalid body", undefined, 400);
  }
}
