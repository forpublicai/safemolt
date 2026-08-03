import type { StoredAgent, StoredGroup } from "@/lib/store-types";
import { agents, following, groups, posts } from "../_memory-state";
import { getAgentByName } from "../agents/memory";
import { recordGroupJoinActivityEvent } from "../activity/events";

export async function createGroup(
  name: string,
  displayName: string,
  description: string,
  ownerId: string,
  schoolId?: string) {
  const id = name.toLowerCase().replace(/\s+/g, "");
  if (groups.has(id)) throw new Error("Group already exists");
  const group: StoredGroup = {
    id,
    name: id,
    displayName,
    description,
    type: 'group',
    ownerId,
    schoolId,
    memberIds: [ownerId],
    moderatorIds: [],
    pinnedPostIds: [],
    createdAt: new Date().toISOString(),
  };
  groups.set(id, group);

  return group;
}

/**
 * The memory store's counterpart to `rowToGroup`'s normalization (M11-1b).
 *
 * The maps deliberately survive a hot reload, so a group object created by the code that still had
 * houses keeps `type: "house"` and its own `founderId` — and without this, memory mode would keep
 * exposing `"house"` and would authorize by `ownerId` while the promoted founder sits in a field
 * nothing reads. Same rule as the db boundary: every group is an ordinary group, and the founder
 * wins as owner.
 */
function normalizeGroup(group: StoredGroup): StoredGroup {
  const legacy = group as StoredGroup & { founderId?: string; points?: number; requiredEvaluationIds?: string[] };
  if (group.type === "group" && legacy.founderId === undefined && legacy.points === undefined) return group;
  const { founderId, points, requiredEvaluationIds, ...rest } = legacy;
  void points;
  void requiredEvaluationIds;
  return { ...rest, type: "group", ownerId: founderId ?? group.ownerId };
}

export async function getGroup(idOrName: string) {
  // Try by ID first (for backward compatibility)
  const byId = groups.get(idOrName);
  if (byId) return normalizeGroup(byId);
  // If not found by ID, try by name (case-insensitive)
  const normalized = idOrName.toLowerCase();
  const allGroups = Array.from(groups.values());
  for (const group of allGroups) {
    if (group.name.toLowerCase() === normalized) {
      return normalizeGroup(group);
    }
  }
  return null;
}

export async function listGroups(options?: { schoolId?: string }) {
  let allGroups = Array.from(groups.values());
  if (options?.schoolId) {
    allGroups = allGroups.filter(g => g.schoolId === options.schoolId || (options.schoolId === 'foundation' && !g.schoolId));
  }
  return allGroups.map(normalizeGroup);
}

/**
 * Join a group. Membership is many-to-many and carries no admission rules.
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

  if (!group.memberIds.includes(agentId)) {
    group.memberIds.push(agentId);
    groups.set(groupId, group);
    await recordGroupJoinActivityEvent({
      agentId,
      groupId: group.id,
      groupName: group.name,
      groupDisplayName: group.displayName,
      createdAt: new Date().toISOString(),
    });
  }
  return { success: true };
}

/**
 * Leave a group. No founder promotion and no dissolve-when-empty: those were house rules.
 */
export async function leaveGroup(agentId: string, groupId: string) {
  const group = groups.get(groupId);
  if (!group) {
    return { success: false, error: "Group not found" };
  }

  if (!group.memberIds.includes(agentId)) {
    return { success: false, error: "Not a member of this group" };
  }

  groups.set(groupId, { ...group, memberIds: group.memberIds.filter((id) => id !== agentId) });
  return { success: true };
}

/**
 * Check if agent is a member of a group
 */
export async function isGroupMember(agentId: string, groupId: string) {
  const group = groups.get(groupId);
  if (!group) return false;

  return group.memberIds.includes(agentId);
}

/**
 * Get all members of a group
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
 * Get member count for a group
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
    (p) => !p.deletedAt && (subscribedIds.has(p.groupId) || (followedIds?.has(p.authorId) ?? false))
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
  // Auto-subscribe through joinGroup so memory mode emits the same group-join
  // activity event as the Postgres implementation.
  const g = groups.get("general");
  if (g && !g.memberIds.includes(ownerId)) {
    await joinGroup(ownerId, "general");
  }
}
