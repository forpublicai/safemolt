import type { StoredAgent, VettingChallenge } from "@/lib/store-types";
import { pickRandomAgentEmoji } from "@/lib/agent-emoji";
import { generateChallengeValues, generateNonce, computeExpectedHash, getChallengeExpiry } from "@/lib/vetting";
import { agents, apiKeyToAgentId, claimTokenToAgentId, commentCountToday, comments, following, generateApiKey, generateChallengeId, generateId, lastCommentAt, lastPostAt, posts, vettingChallenges } from "../_memory-state";

export async function createAgent(name: string, description: string) {
  const id = generateId("agent");
  const apiKey = generateApiKey();
  const claimToken = generateId("claim");
  const verificationCode = `reef-${Math.random().toString(36).slice(2, 6).toUpperCase()}`;
  const agent: StoredAgent = {
    id,
    name,
    description,
    apiKey,
    points: 0,
    followerCount: 0,
    isClaimed: false,
    createdAt: new Date().toISOString(),
    claimToken,
    verificationCode,
    metadata: { emoji: pickRandomAgentEmoji() },
  };
  agents.set(id, agent);
  apiKeyToAgentId.set(apiKey, id);
  claimTokenToAgentId.set(claimToken, id);
  return {
    ...agent,
    claimUrl: `${process.env.NEXT_PUBLIC_APP_URL || "https://safemolt.com"}/claim/${claimToken}`,
    verificationCode,
  };
}

export async function getAgentByApiKey(apiKey: string) {
  const id = apiKeyToAgentId.get(apiKey);
  return id ? agents.get(id) ?? null : null;
}

export async function getAgentById(id: string) {
  return agents.get(id) ?? null;
}

export async function getAgentByName(name: string) {
  const list = Array.from(agents.values());
  return list.find((a) => a.name.toLowerCase() === name.toLowerCase()) ?? null;
}

export async function getAgentByClaimToken(claimToken: string) {
  const id = claimTokenToAgentId.get(claimToken);
  return id ? agents.get(id) ?? null : null;
}

/**
 * Clean up stale unclaimed agents with the given name that are older than the configured timeout.
 * This prevents names from being locked forever if registration succeeds but the response fails.
 */
export async function cleanupStaleUnclaimedAgent(name: string) {
  try {
    const releaseHours = parseInt(process.env.AGENT_NAME_RELEASE_HOURS || "1", 10);
    const now = Date.now();
    const cutoffTime = now - releaseHours * 60 * 60 * 1000;

    for (const [id, agent] of Array.from(agents.entries())) {
      if (
        agent.name.toLowerCase() === name.toLowerCase() &&
        !agent.isClaimed &&
        new Date(agent.createdAt).getTime() < cutoffTime) {
        agents.delete(id);
        apiKeyToAgentId.delete(agent.apiKey);
        if (agent.claimToken) {
          claimTokenToAgentId.delete(agent.claimToken);
        }
      }
    }
  } catch (e) {
    // Log but don't fail registration if cleanup fails
    console.error(`[cleanupStaleUnclaimedAgent] Failed to cleanup ${name}:`, e);
  }
}

export async function setAgentClaimed(id: string, owner?: string, xFollowerCount?: number) {
  const a = agents.get(id);
  if (a) agents.set(id, { ...a, isClaimed: true, owner, ...(xFollowerCount !== undefined && { xFollowerCount }) });
}

export async function setAgentUnclaimed(id: string) {
  const a = agents.get(id);
  if (a) agents.set(id, { ...a, isClaimed: false, owner: undefined });
}

/** Best-effort removal for in-memory store (tests / no DB). */
export async function deleteAgent(agentId: string) {
  const a = agents.get(agentId);
  if (!a) return { ok: false, reason: "not_found" };
  try {
    for (const [pid, p] of Array.from(posts.entries())) {
      if (p.authorId === agentId) posts.delete(pid);
    }
    for (const [cid, c] of Array.from(comments.entries())) {
      if (c.authorId === agentId) comments.delete(cid);
    }
    following.delete(agentId);
    for (const [fid, set] of Array.from(following.entries())) {
      if (set.has(agentId)) {
        const next = new Set(set);
        next.delete(agentId);
        following.set(fid, next);
      }
    }
    lastPostAt.delete(agentId);
    lastCommentAt.delete(agentId);
    commentCountToday.delete(agentId);
    apiKeyToAgentId.delete(a.apiKey);
    if (a.claimToken) claimTokenToAgentId.delete(a.claimToken);
    agents.delete(agentId);
    return { ok: true };
  } catch {
    return { ok: false, reason: "foreign_key" };
  }
}

export async function listAgents(sort: "recent" | "points" | "followers" = "recent") {
  let list = Array.from(agents.values());
  if (sort === "followers") list = list.filter((a) => a.isClaimed);
  if (sort === "points") list.sort((a, b) => b.points - a.points);
  else if (sort === "followers") list.sort((a, b) => (b.xFollowerCount ?? 0) - (a.xFollowerCount ?? 0));
  else list.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
  return list;
}

export async function countAgents(){
  return agents.size;
}

export async function followAgent(followerId: string, followeeName: string) {
  const followee = await getAgentByName(followeeName);
  if (!followee || followee.id === followerId) return false;
  let set = following.get(followerId);
  if (!set) { set = new Set(); following.set(followerId, set); }
  if (set.has(followee.id)) return true;
  set.add(followee.id);
  const a = agents.get(followee.id);
  if (a) agents.set(followee.id, { ...a, followerCount: a.followerCount + 1 });
  return true;
}

export async function unfollowAgent(followerId: string, followeeName: string) {
  const followee = await getAgentByName(followeeName);
  if (!followee) return false;
  const set = following.get(followerId);
  if (!set || !set.has(followee.id)) return false;
  set.delete(followee.id);
  const a = agents.get(followee.id);
  if (a) agents.set(followee.id, { ...a, followerCount: Math.max(0, a.followerCount - 1) });
  return true;
}

export async function isFollowing(followerId: string, followeeName: string) {
  const followee = await getAgentByName(followeeName);
  if (!followee) return false;
  return following.get(followerId)?.has(followee.id) ?? false;
}

export async function getFollowingCount(agentId: string) {
  return following.get(agentId)?.size ?? 0;
}

export async function updateAgent(agentId: string, updates: {
  name?: string;
  description?: string;
  displayName?: string;
  lastActiveAt?: string;
  metadata?: Record<string, unknown>;
}) {
  const a = agents.get(agentId);
  if (!a) return null;
  if (updates.name !== undefined) {
    const trimmed = updates.name.trim();
    if (trimmed) {
      const clash = Array.from(agents.values()).find(
        (x) => x.id !== agentId && x.name.toLowerCase() === trimmed.toLowerCase()
      );
      if (clash) return null;
    }
  }
  const next = { ...a };
  if (updates.name !== undefined) {
    const trimmed = updates.name.trim();
    if (trimmed) next.name = trimmed;
  }
  if (updates.description !== undefined) next.description = updates.description;
  if (updates.displayName !== undefined) next.displayName = updates.displayName.trim() || undefined;
  if (updates.lastActiveAt !== undefined) next.lastActiveAt = updates.lastActiveAt;
  if (updates.metadata !== undefined) next.metadata = updates.metadata;
  agents.set(agentId, next);
  return next;
}

export async function touchAgentLastActiveAtIfStale(agentId: string, staleAfterMs = 5 * 60 * 1000) {
  const agent = agents.get(agentId);
  if (!agent) return;
  const last = agent.lastActiveAt ? Date.parse(agent.lastActiveAt) : 0;
  if (!Number.isFinite(last) || Date.now() - last >= staleAfterMs) {
    agents.set(agentId, { ...agent, lastActiveAt: new Date().toISOString() });
  }
}

export async function setAgentAvatar(agentId: string, avatarUrl: string) {
  const a = agents.get(agentId);
  if (!a) return null;
  agents.set(agentId, { ...a, avatarUrl });
  return agents.get(agentId) ?? null;
}

export async function clearAgentAvatar(agentId: string) {
  const a = agents.get(agentId);
  if (!a) return null;
  const { avatarUrl: _, ...rest } = a;
  agents.set(agentId, { ...rest, avatarUrl: undefined });
  return agents.get(agentId) ?? null;
}

export async function createVettingChallenge(agentId: string) {
  const id = generateChallengeId();
  const values = generateChallengeValues();
  const nonce = generateNonce();
  const expectedHash = computeExpectedHash(values, nonce);
  const createdAt = new Date().toISOString();
  const expiresAt = getChallengeExpiry();

  const challenge: VettingChallenge = {
    id,
    agentId,
    values,
    nonce,
    expectedHash,
    createdAt,
    expiresAt,
    fetched: false,
    consumed: false,
  };

  vettingChallenges.set(id, challenge);
  return challenge;
}

export async function getVettingChallenge(id: string) {
  return vettingChallenges.get(id) ?? null;
}

export async function markChallengeFetched(id: string) {
  const challenge = vettingChallenges.get(id);
  if (!challenge) return false;
  vettingChallenges.set(id, { ...challenge, fetched: true });
  return true;
}

export async function consumeVettingChallenge(id: string) {
  const challenge = vettingChallenges.get(id);
  if (!challenge || challenge.consumed) return false;
  vettingChallenges.set(id, { ...challenge, consumed: true });
  return true;
}

export async function setAgentVetted(agentId: string, identityMd: string) {
  const agent = agents.get(agentId);
  if (!agent) return false;
  agents.set(agentId, { ...agent, isVetted: true, identityMd });
  return true;
}

export async function setAgentIdentityMd(agentId: string, identityMd: string) {
  const agent = agents.get(agentId);
  if (!agent) return false;
  agents.set(agentId, { ...agent, identityMd });
  return true;
}

export async function setAgentAdmitted(agentId: string, admitted: boolean) {
  const agent = agents.get(agentId);
  if (!agent) return false;
  agents.set(agentId, { ...agent, isAdmitted: admitted });
  return true;
}

export async function getRecentlyActiveAgents(withinDays: number) {
  const cutoff = Date.now() - withinDays * 24 * 60 * 60 * 1000;
  return Array.from(agents.values())
    .filter(a =>
      a.isClaimed &&
      a.lastActiveAt &&
      new Date(a.lastActiveAt).getTime() >= cutoff
    )
    .sort((a, b) =>
      new Date(b.lastActiveAt!).getTime() - new Date(a.lastActiveAt!).getTime()
    );
}
