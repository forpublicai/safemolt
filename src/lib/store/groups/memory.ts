import type { StoredAgent, StoredGroup } from "@/lib/store-types";
import type { PreparedEvent } from "@/lib/events/kinds";
import {
  agents,
  following,
  groups,
  effectiveGroupOwnerId,
  groupSubscriptionSnapshots,
  materializeGroupSubscriptionSnapshot,
  posts,
} from "../_memory-state";
import { getAgentByName } from "../agents/memory";
import { recordGroupJoinActivityEvent } from "../activity/events";
import { appendPreparedBatch, prepareEventBatch, validatePreparedEvents } from "../events/memory";
import { suppliedGroupSettingsFields, type GroupSettingsUpdates } from "./settings-fields";
import type { EnsureGeneralGroupEvents } from "./db";

/**
 * The memory twin of the db statements' `subject_id` override: the store's OWN group id.
 *
 * Positional, on the primary event only, for the reason `substitutePrimaryEvent` gives in
 * `posts/memory.ts` — the db side applies `overrides[0]` and leaves every later event alone, so a
 * kind-keyed rule here would agree for one event and diverge for two.
 */
function withGroupSubject(
  events: readonly PreparedEvent[] | undefined,
  groupId: string,
  secondarySubjectId?: string
): PreparedEvent[] {
  return (events ?? []).map((event, index) =>
    index === 0
      ? {
          ...event,
          subjectId: groupId,
          ...(secondarySubjectId === undefined ? {} : { secondarySubjectId }),
        }
      : event
  );
}

/**
 * The group's LEGACY subscription snapshot — memory's `groups.member_ids` (codex round 1, finding 1).
 *
 * A missing entry seeds from the group's canonical membership, because that is what the two db
 * states hold at creation: `createGroup` writes the owner into `member_ids` AND into `group_members`.
 * A group built directly by a fixture (`groups.set`) therefore reads as if it had just been created,
 * which is the only honest default.
 *
 * The seed is a COPY, taken before any canonical mutation — see
 * `materializeGroupSubscriptionSnapshot` for what an aliased seed cost.
 */
function subscriptionSnapshot(group: StoredGroup): string[] {
  return materializeGroupSubscriptionSnapshot(group);
}

/**
 * Create a group — the memory twin of the db store's creation batch (M11-2 P1.3).
 *
 * Decision 4's order: validate → decide eligibility → refuse → preflight → mutate and append with no
 * `await` in between. There is no `await` before the mutation at all here, which is why nothing needs
 * re-checking across one.
 */
export async function createGroup(
  name: string,
  displayName: string,
  description: string,
  ownerId: string,
  schoolId?: string,
  events?: readonly PreparedEvent[]) {
  const id = name.toLowerCase().replace(/\s+/g, "");
  // **The duplicate read comes FIRST, because that is where the db store puts it.** Its
  // `getGroup` pre-check throws before `emitEventCtes` renders anything, so a duplicate creation
  // carrying a malformed event reports "already exists" there. Validating ahead of it reported the
  // event error instead — the same refusal decided by a different rule in the two stores.
  if (groups.has(id)) throw new Error("Group already exists");
  const prepared = withGroupSubject(events, id);
  // Kind and payload here, where the db store renders.
  validatePreparedEvents(prepared);
  // **The owner is re-checked by id, and Postgres is the standard**: `groups.owner_id REFERENCES
  // agents(id)` carries no cascade, so an insert naming an agent that withdrew while the action was
  // suspended raises 23503 there and the action renders it as a refusal. Without this the memory
  // store would create a group owned by nobody, which nothing afterwards can authorize or clean up.
  if (!agents.has(ownerId)) throw new Error("Owner agent not found");
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
  const batch = prepareEventBatch(prepared);
  groups.set(id, group);
  // Both membership states start with the owner, exactly as the db batch writes them: `member_ids`
  // in element 1 and the `group_members` row in element 2. Set rather than seeded, so a group id
  // reused after a fixture cleared `groups` cannot inherit a previous snapshot.
  groupSubscriptionSnapshots.set(id, [ownerId]);
  await appendPreparedBatch(batch).dispatched;

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
  void founderId;
  void points;
  void requiredEvaluationIds;
  // Through the shared rule, so the read boundary and every authorization path cannot drift.
  return { ...rest, type: "group", ownerId: effectiveGroupOwnerId(group) };
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
 * Join a group — the memory twin of the db store's single statement (M11-2 P1.3).
 *
 * A duplicate join writes nothing, emits nothing and refreshes nothing, which is what this store
 * already did; u3c brought the db side into line with it (see `joinGroupWithOutcome` there for the
 * recorded behavior change). The transitional projection is stamped from the event this call
 * appended, on both axes — the id, and the `created_at` that becomes `occurred_at`.
 */
export async function joinGroup(agentId: string, groupId: string, events?: readonly PreparedEvent[]) {
  const { success, error } = await joinGroupWithOutcome(agentId, groupId, events);
  return error === undefined ? { success } : { success, error };
}

/** The db twin's richer form: "already a member" is a fact only the membership check knows. */
export async function joinGroupWithOutcome(
  agentId: string,
  groupId: string,
  events?: readonly PreparedEvent[]
): Promise<{ success: boolean; error?: string; alreadyMember: boolean }> {
  const group = groups.get(groupId);
  const prepared = withGroupSubject(events, groupId);
  validatePreparedEvents(prepared);
  if (!group) {
    return { success: false, error: "Group not found", alreadyMember: false };
  }

  // **Both ids**, matching the db statement's two locked targets: `group_members` carries a foreign
  // key to each, so Postgres refuses a join by or into an agent or group that is gone rather than
  // writing a dangling row. There is no `await` above this point, so nothing here is stale — the
  // check is the twin of those locks, not a re-validation across a suspension.
  const agent = agents.get(agentId);
  if (!agent) {
    return { success: false, error: "Agent not found", alreadyMember: false };
  }

  if (group.memberIds.includes(agentId)) return { success: true, alreadyMember: true };

  const batch = prepareEventBatch(prepared);
  // The synchronous section: the membership and the append, with no `await` between them.
  // The snapshot is pinned FIRST, because this push mutates `memberIds` in place and an unpinned
  // snapshot would follow it — see `materializeGroupSubscriptionSnapshot`.
  materializeGroupSubscriptionSnapshot(group);
  group.memberIds.push(agentId);
  groups.set(groupId, group);
  const { stored, dispatched } = appendPreparedBatch(batch);
  const sourceEventId = stored[0]?.id;
  void recordGroupJoinActivityEvent(
    {
      agentId,
      groupId: group.id,
      groupName: group.name,
      groupDisplayName: group.displayName,
      // The event's own `created_at` — the one clock both stores can share for this kind, because
      // memory-mode membership carries no timestamp of its own at all.
      createdAt: stored[0]?.createdAt ?? new Date().toISOString(),
    },
    { sourceEventId }
  );
  await dispatched;
  return { success: true, alreadyMember: false };
}

/**
 * Leave a group. No founder promotion and no dissolve-when-empty: those were house rules.
 *
 * `group.left` is gated on the membership actually being removed, exactly as the db `DELETE …
 * RETURNING` is: a non-member's leave writes nothing and emits nothing.
 *
 * **A withdrawn agent counts as a non-member, and that is parity rather than strictness.**
 * `group_members.agent_id … ON DELETE CASCADE` removes the row with the agent, so by the time a
 * leave suspended across the action's `getGroup` await reaches Postgres there is nothing to delete
 * and the statement answers "not a member". Memory has no cascade — `deleteAgent` never swept group
 * membership — so without this check the resumed call would remove a membership and emit
 * `group.left` for an actor that no longer exists.
 */
export async function leaveGroup(agentId: string, groupId: string, events?: readonly PreparedEvent[]) {
  const group = groups.get(groupId);
  const prepared = withGroupSubject(events, groupId);
  validatePreparedEvents(prepared);
  if (!group) {
    return { success: false, error: "Group not found" };
  }

  if (!group.memberIds.includes(agentId) || !agents.has(agentId)) {
    return { success: false, error: "Not a member of this group" };
  }

  const batch = prepareEventBatch(prepared);
  // Pinned before the canonical list loses this agent, so a later unsubscribe still has a snapshot
  // entry to remove — which is exactly what Postgres leaves behind.
  materializeGroupSubscriptionSnapshot(group);
  groups.set(groupId, { ...group, memberIds: group.memberIds.filter((id) => id !== agentId) });
  await appendPreparedBatch(batch).dispatched;
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

/**
 * The legacy feed-subscription surface — membership and nothing else, over BOTH states.
 *
 * **It writes the canonical membership AND the legacy snapshot, and the event gates on their
 * UNION** — the memory twin of the db statement's `changed` CTE, and the fix for codex round 1's
 * finding 1. A member who subscribes changes only the snapshot, and that is still a write: gating on
 * the canonical list alone lost the event Postgres emits for it.
 *
 * **The boolean means what the db store's means: "the group exists".** It used to answer `false`
 * for an agent who was already a member, where the db twin answered `true`. The EVENT is what
 * distinguishes the cases, not the return value.
 */
export async function subscribeToGroup(agentId: string, groupId: string, events?: readonly PreparedEvent[]) {
  const g = groups.get(groupId);
  const prepared = withGroupSubject(events, groupId);
  validatePreparedEvents(prepared);
  if (!g) return false;
  // The db statement's second locked target. BOTH arms select from `actor` there, so a subscribe by
  // an agent that is gone writes neither the canonical row (its foreign key would refuse) nor the
  // snapshot (which would otherwise gain a dangling id). The group still exists, so the answer is
  // `true` — matching the db's `group_exists` projection — with nothing written and nothing emitted.
  if (!agents.has(agentId)) return true;
  const snapshot = subscriptionSnapshot(g);
  const canonicalChanges = !g.memberIds.includes(agentId);
  const legacyChanges = !snapshot.includes(agentId);
  if (!canonicalChanges && !legacyChanges) return true;
  const batch = prepareEventBatch(prepared);
  if (canonicalChanges) groups.set(groupId, { ...g, memberIds: [...g.memberIds, agentId] });
  if (legacyChanges) groupSubscriptionSnapshots.set(groupId, [...snapshot, agentId]);
  await appendPreparedBatch(batch).dispatched;
  return true;
}

/**
 * The mirror image, over the same two states.
 *
 * **The acting agent is deliberately NOT re-checked here**, and that is parity rather than an
 * omission (codex round 1, finding 3). The db's canonical arm is a `DELETE`, which needs no actor to
 * exist, and its legacy arm edits a JSONB array that has no foreign key at all — so a withdrawn
 * agent's stale id is still removed from `member_ids` there, and the event still fires. Refusing
 * here would leave memory unable to clean up what Postgres cleans up.
 */
export async function unsubscribeFromGroup(agentId: string, groupId: string, events?: readonly PreparedEvent[]) {
  const g = groups.get(groupId);
  const prepared = withGroupSubject(events, groupId);
  validatePreparedEvents(prepared);
  if (!g) return false;
  const snapshot = subscriptionSnapshot(g);
  const canonicalChanges = g.memberIds.includes(agentId);
  const legacyChanges = snapshot.includes(agentId);
  if (!canonicalChanges && !legacyChanges) return true;
  const batch = prepareEventBatch(prepared);
  if (canonicalChanges) groups.set(groupId, { ...g, memberIds: g.memberIds.filter((id) => id !== agentId) });
  if (legacyChanges) groupSubscriptionSnapshots.set(groupId, snapshot.filter((id) => id !== agentId));
  await appendPreparedBatch(batch).dispatched;
  return true;
}

/** The LEGACY snapshot, which is the column the db twin reads (`groups.member_ids`), not membership. */
export async function isSubscribed(agentId: string, groupId: string) {
  const g = groups.get(groupId);
  return g ? subscriptionSnapshot(g).includes(agentId) : false;
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

/** Sorted, for the reason the db twin is ordered: a capped audience must not depend on map order. */
export async function listFollowerIdsForFollowee(followeeId: string) {
  const out: string[] = [];
  for (const [followerId, set] of Array.from(following.entries())) {
    if (set.has(followeeId)) out.push(followerId);
  }
  return out.sort();
}

export async function getYourRole(groupId: string, agentId: string) {
  const g = groups.get(groupId);
  if (!g) return null;
  // Founder-wins, like every other reader: a mixed-version row's promoted founder IS the owner
  // (`effectiveGroupOwnerId`), and the raw column would show owner controls to a departed creator
  // whose writes the mutation paths refuse.
  if (effectiveGroupOwnerId(g) === agentId) return "owner";
  if (g.moderatorIds?.includes(agentId)) return "moderator";
  return null;
}

/**
 * Update settings — the memory twin, with the same "no field, no write, no event" rule.
 *
 * `emoji: ""` clears, exactly as the db `CASE WHEN $6 THEN $7` does; every other field is applied
 * only when the caller supplied it, which is what `...updates` already gave (an absent key is not
 * spread) and what `COALESCE(param, column)` gives on the other side.
 */
export async function updateGroupSettings(
  groupId: string,
  updates: GroupSettingsUpdates,
  events?: readonly PreparedEvent[]) {
  const g = groups.get(groupId);
  // **The empty-edit exit comes FIRST, because the db store returns before it renders.** Key
  // presence, not value — see `suppliedGroupSettingsFields`: `{ emoji: undefined }` is a deliberate
  // clear, and a value test reads it as "nothing supplied". A call with no field is a READ on both
  // sides, so it must not be the place a malformed event surfaces.
  const supplied = suppliedGroupSettingsFields(updates);
  if (supplied.length === 0) return g ?? null;
  const prepared = withGroupSubject(events, groupId);
  validatePreparedEvents(prepared);
  if (!g) return null;
  const batch = prepareEventBatch(prepared);
  // **Only the SUPPLIED keys are applied**, never a bare `...updates` spread. A spread writes
  // `displayName: undefined` for a key the caller left explicitly undefined, where the db's
  // `COALESCE(NULL, display_name)` preserves it — the divergence `suppliedGroupSettingsFields` now
  // rules out at the source, and this is the write side of the same rule. The emoji is normalized
  // the way the db `CASE` normalizes it: supplied-but-empty clears, absent leaves alone.
  const applied: GroupSettingsUpdates = {};
  for (const field of supplied) {
    if (field === "emoji") applied.emoji = updates.emoji || undefined;
    else Object.assign(applied, { [field]: updates[field as keyof GroupSettingsUpdates] });
  }
  groups.set(groupId, { ...g, ...applied });
  await appendPreparedBatch(batch).dispatched;
  return groups.get(groupId) ?? null;
}

export async function addModerator(
  groupId: string,
  ownerId: string,
  agentName: string,
  events?: readonly PreparedEvent[]
) {
  return writeModerator("add", groupId, ownerId, agentName, events);
}

export async function removeModerator(
  groupId: string,
  ownerId: string,
  agentName: string,
  events?: readonly PreparedEvent[]
) {
  return writeModerator("remove", groupId, ownerId, agentName, events);
}

/**
 * The shared body, mirroring the db twin's.
 *
 * **The group is re-read by id after the `await`, and the actor deliberately is not.** Decision 4's
 * rule is parity with what Postgres refuses, and there the `UPDATE groups` names neither the owner
 * nor the target in a foreign key — an owner or a target that withdrew while the name resolved
 * still lands the write. The group is different: the update anchors on its id, so a group that
 * vanished in the window matches nothing.
 *
 * `true` for a no-op — an already-moderator add, a removal of somebody who was not one — is the
 * answer both surfaces publish today. The event is gated on the array actually changing, so the two
 * facts stay separate.
 */
async function writeModerator(
  operation: "add" | "remove",
  groupId: string,
  ownerId: string,
  agentName: string,
  events?: readonly PreparedEvent[]
): Promise<boolean> {
  const g = groups.get(groupId);
  // The EFFECTIVE owner, never the raw column: the action authorized the caller through `getGroup`,
  // which applies founder-wins, so comparing `ownerId` here refused the promoted founder it had just
  // admitted — and admitted the departed creator it had just refused (codex round 4, finding 2).
  if (!g || effectiveGroupOwnerId(g) !== ownerId) return false;
  const agent = await getAgentByName(agentName);
  if (!agent) return false;
  // ---- Re-checked after the ONLY await, by id. ----
  const current = groups.get(groupId);
  if (!current) return false;
  const prepared = withGroupSubject(events, groupId, agent.id);
  validatePreparedEvents(prepared);
  const mods = current.moderatorIds ?? [];
  const isModerator = mods.includes(agent.id);
  // The no-op cases, matching the db predicates: an add of a current moderator, a removal of an
  // agent who is not one. Nothing written, nothing emitted, success reported.
  if (operation === "add" ? isModerator : !isModerator) return true;
  const next = operation === "add" ? [...mods, agent.id] : mods.filter((id) => id !== agent.id);
  const batch = prepareEventBatch(prepared);
  groups.set(groupId, { ...current, moderatorIds: next });
  await appendPreparedBatch(batch).dispatched;
  return true;
}

export async function listModerators(groupId: string) {
  const g = groups.get(groupId);
  if (!g) return [];
  return (g.moderatorIds ?? []).map((id) => agents.get(id)).filter(Boolean) as StoredAgent[];
}

/** The memory twin — see the db store for why this path carries events at all. */
export async function ensureGeneralGroup(ownerId: string, events: EnsureGeneralGroupEvents = {}) {
  if (!groups.has("general")) {
    await createGroup("general", "General", "General discussion for all agents.", ownerId, undefined, events.created);
  }
  // Auto-subscribe through joinGroup so memory mode emits the same group-join
  // activity event as the Postgres implementation.
  const g = groups.get("general");
  if (g && !g.memberIds.includes(ownerId)) {
    await joinGroup(ownerId, "general", events.joined);
  }
}
