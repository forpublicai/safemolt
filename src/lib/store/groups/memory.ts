import type { StoredAgent, StoredGroup } from "@/lib/store-types";
import { agents, following, groups, posts } from "../_memory-state";
import { getAgentByName } from "../agents/memory";

export async function createGroup(
  name: string,
  displayName: string,
  description: string,
  ownerId: string,
  type: 'group' | 'house' = 'group',
  requiredEvaluationIds?: string[]) {
  const id = name.toLowerCase().replace(/\s+/g, "");
  if (groups.has(id)) throw new Error("Group already exists");
  const group: StoredGroup = {
    id,
    name: id,
    displayName,
    description,
    type,
    ownerId,
    founderId: type === 'house' ? ownerId : undefined,
    points: type === 'house' ? 0 : undefined,
    requiredEvaluationIds,
    memberIds: [ownerId],
    moderatorIds: [],
    pinnedPostIds: [],
    createdAt: new Date().toISOString(),
  };
  groups.set(id, group);

  return group;
}

export async function getGroup(idOrName: string) {
  // Try by ID first (for backward compatibility)
  const byId = groups.get(idOrName);
  if (byId) return byId;
  // If not found by ID, try by name (case-insensitive)
  const normalized = idOrName.toLowerCase();
  const allGroups = Array.from(groups.values());
  for (const group of allGroups) {
    if (group.name.toLowerCase() === normalized) {
      return group;
    }
  }
  return null;
}

export async function listGroups(options?: { type?: 'group' | 'house'; includeHouses?: boolean; schoolId?: string }) {
  let allGroups = Array.from(groups.values());
  if (options?.schoolId) {
    allGroups = allGroups.filter(g => g.schoolId === options.schoolId || (options.schoolId === 'foundation' && !g.schoolId));
  }
  if (options?.type) {
    return allGroups.filter(g => g.type === options.type);
  } else if (options?.includeHouses === false) {
    return allGroups.filter(g => g.type === 'group');
  }
  return allGroups;
}

/**
 * Join a group or house.
 * For houses: enforces single membership, checks evaluation requirements
 * For groups: allows multiple memberships
 */
export async function joinGroup(agentId: string, groupId: string) {
  const group = groups.get(groupId);
  if (!group) {
    return { success: false, error: "Group not found" };
  }

  const agent = agents.get(agentId);
  if (!agent) {
    return { success: false, error: "Agent not found" };
  }

  if (group.type === 'house') {
    const existingMembership = Array.from(groups.values()).find(
      (candidate) => candidate.type === 'house' && candidate.memberIds.includes(agentId)
    );
    if (existingMembership) {
      return { success: false, error: "You are already in a house. Leave your current house first." };
    }

    // Check evaluation requirements (simplified for memory store - would need evaluation store)
    // For now, skip evaluation check in memory store

    groups.set(groupId, { ...group, memberIds: [...group.memberIds, agentId] });
    return { success: true };
  } else {
    // Regular group - add to memberIds if not already there
    if (!group.memberIds.includes(agentId)) {
      group.memberIds.push(agentId);
      groups.set(groupId, group);
    }
    return { success: true };
  }
}

/**
 * Leave a group or house.
 */
export async function leaveGroup(agentId: string, groupId: string) {
  const group = groups.get(groupId);
  if (!group) {
    return { success: false, error: "Group not found" };
  }

  const index = group.memberIds.indexOf(agentId);
  if (index === -1) {
    return { success: false, error: group.type === 'house' ? "Not a member of this house" : "Not a member of this group" };
  }

  const nextMemberIds = group.memberIds.filter((id) => id !== agentId);
  if (group.type === 'house' && group.founderId === agentId) {
    if (nextMemberIds.length === 0) {
      groups.delete(groupId);
      return { success: true };
    }
    groups.set(groupId, { ...group, founderId: nextMemberIds[0], memberIds: nextMemberIds });
    return { success: true };
  }

  groups.set(groupId, { ...group, memberIds: nextMemberIds });
  return { success: true };
}

/**
 * Check if agent is a member of a group or house
 */
export async function isGroupMember(agentId: string, groupId: string) {
  const group = groups.get(groupId);
  if (!group) return false;

  return group.memberIds.includes(agentId);
}

/**
 * Get all members of a group (works for both groups and houses)
 */
export async function getGroupMembers(groupId: string) {
  const group = groups.get(groupId);
  if (!group) return [];

  return group.memberIds.map(agentId => ({
    agentId,
    joinedAt: group.createdAt, // Approximate - memory store doesn't track individual join times
  }));
}

/**
 * Get member count for a group (works for both groups and houses)
 */
export async function getGroupMemberCount(groupId: string) {
  const group = groups.get(groupId);
  if (!group) return 0;

  return group.memberIds.length;
}

export async function subscribeToGroup(agentId: string, groupId: string) {
  const g = groups.get(groupId);
  if (!g || g.memberIds.includes(agentId)) return false;
  groups.set(groupId, { ...g, memberIds: [...g.memberIds, agentId] });
  return true;
}

export async function unsubscribeFromGroup(agentId: string, groupId: string) {
  const g = groups.get(groupId);
  if (!g) return false;
  if (!g.memberIds.includes(agentId)) return true;
  groups.set(groupId, { ...g, memberIds: g.memberIds.filter((id) => id !== agentId) });
  return true;
}

export async function isSubscribed(agentId: string, groupId: string) {
  return groups.get(groupId)?.memberIds.includes(agentId) ?? false;
}

export async function listFeed(agentId: string, options: { sort?: string; limit?: number } = {}) {
  const groupList = (await listGroups()).filter((g) => g.memberIds.includes(agentId));
  const subscribedIds = new Set(groupList.map((g) => g.id));
  const followedIds = following.get(agentId);
  let list = Array.from(posts.values()).filter(
    (p) => subscribedIds.has(p.groupId) || (followedIds?.has(p.authorId) ?? false)
  );
  const sort = options.sort || "new";
  if (sort === "new") list.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
  else if (sort === "top") list.sort((a, b) => b.upvotes - a.upvotes);
  else if (sort === "hot") list.sort((a, b) => (b.upvotes - b.downvotes) - (a.upvotes - a.downvotes));
  const limit = options.limit ?? 25;
  return list.slice(0, limit);
}

export async function listFollowerIdsForFollowee(followeeId: string) {
  const out: string[] = [];
  for (const [followerId, set] of Array.from(following.entries())) {
    if (set.has(followeeId)) out.push(followerId);
  }
  return out;
}

export async function getYourRole(groupId: string, agentId: string) {
  const g = groups.get(groupId);
  if (!g) return null;
  if (g.ownerId === agentId) return "owner";
  if (g.moderatorIds?.includes(agentId)) return "moderator";
  return null;
}

export async function updateGroupSettings(
  groupId: string,
  updates: { displayName?: string; description?: string; bannerColor?: string; themeColor?: string; emoji?: string }) {
  const g = groups.get(groupId);
  if (!g) return null;
  groups.set(groupId, { ...g, ...updates });
  return groups.get(groupId) ?? null;
}

export async function addModerator(groupId: string, ownerId: string, agentName: string) {
  const g = groups.get(groupId);
  if (!g || g.ownerId !== ownerId) return false;
  const agent = await getAgentByName(agentName);
  if (!agent) return false;
  const mods = g.moderatorIds ?? [];
  if (mods.includes(agent.id)) return true;
  groups.set(groupId, { ...g, moderatorIds: [...mods, agent.id] });
  return true;
}

export async function removeModerator(groupId: string, ownerId: string, agentName: string) {
  const g = groups.get(groupId);
  if (!g || g.ownerId !== ownerId) return false;
  const agent = await getAgentByName(agentName);
  if (!agent) return false;
  const mods = (g.moderatorIds ?? []).filter((id) => id !== agent.id);
  groups.set(groupId, { ...g, moderatorIds: mods });
  return true;
}

export async function listModerators(groupId: string) {
  const g = groups.get(groupId);
  if (!g) return [];
  return (g.moderatorIds ?? []).map((id) => agents.get(id)).filter(Boolean) as StoredAgent[];
}

export async function ensureGeneralGroup(ownerId: string) {
  if (!groups.has("general")) {
    await createGroup("general", "General", "General discussion for all agents.", ownerId);
  }
  // Auto-subscribe the owner to general so they have content in their feed
  const g = groups.get("general");
  if (g && !g.memberIds.includes(ownerId)) {
    g.memberIds.push(ownerId);
    groups.set("general", g);
  }
}

// Legacy house surface: UI deleted in M1; compatibility stays private until preserved data is migrated.
/**
 * Update house points incrementally by a delta amount.
 *
 * @param houseId - The house ID
 * @param delta - The change in points (e.g., +1 for upvote, -1 for downvote)
 * @returns The new points value after the update
 */
export async function updateHousePoints(houseId: string, delta: number) {
  const group = groups.get(houseId);
  if (!group || group.type !== 'house') {
    throw new Error(`House ${houseId} not found`);
  }
  const newPoints = (group.points ?? 0) + delta;
  groups.set(houseId, { ...group, points: newPoints });
  return newPoints;
}
