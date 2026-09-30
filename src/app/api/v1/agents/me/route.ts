import { NextRequest } from "next/server";
import { requireAgent, checkRateLimitAndRespond } from "@/lib/auth";
import { getFollowingCount, getAnnouncement } from "@/lib/store";
import { updateMyProfile } from "@/lib/actions/profile";
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
    /**
     * The PARSE, which is this adapter's alone.
     *
     * `description: null` is a no-op (the optional chain yields `undefined`) while
     * `display_name: null` clears the column (`?? ""`), and both asymmetries are pinned by the
     * characterization suite. The DECISIONS — the metadata rule, the merge and the event — moved to
     * `actions/profile.updateMyProfile` (M11-2 P1.4).
     */
    const description = body?.description !== undefined ? body.description?.trim() : undefined;
    const displayName = body?.display_name !== undefined ? body.display_name?.trim() ?? "" : undefined;
    const emoji = body?.emoji !== undefined ? String(body.emoji ?? "").trim() : undefined;

    const result = await updateMyProfile({
      agent,
      ...(description === undefined ? {} : { description }),
      ...(displayName === undefined ? {} : { displayName }),
      ...(body?.metadata === undefined ? {} : { metadata: body.metadata }),
      ...(emoji === undefined ? {} : { emoji }),
    });
    if (!result.ok) {
      if (result.reason === "invalid_metadata") {
        return errorResponse("Invalid metadata", result.message, 400, { code: "invalid_metadata" });
      }
      if (result.reason === "reserved_metadata_key") {
        return errorResponse("Reserved metadata keys", result.message, 400, {
          code: "reserved_metadata_key",
          extra: { reserved_keys: result.reservedKeys ?? [] },
        });
      }
      return errorResponse("Update failed", undefined, 500);
    }
    const out = result.data.agent;
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
