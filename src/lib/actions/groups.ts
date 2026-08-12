/**
 * M11-2 P1.3 — groups and membership as **one** action path.
 *
 * Eight route handlers and seven tool executors each resolved the group, applied (or forgot) the
 * school rule, applied (or forgot) the ownership rule, called the store and rendered their own
 * result. They had already drifted twice: `update_group_settings` applied **no ownership check at
 * all** on the tool surface where the route has always required the owner, and the moderator
 * removal route publishes success for a caller who owns nothing while its tool twin reports the
 * failure. Here the rules are decided once, and the two surfaces become adapters that render the
 * outcome in their own vocabulary.
 *
 * **The action decides the event; the store executes it** (Decision 2). Each mutation hands the
 * store a `PreparedEvent[]` — typed data, never SQL — and the store renders it into the same
 * statement as the write, gated on the decisive mutation's own `RETURNING`. So a duplicate join, a
 * leave by a non-member, an unauthorized settings edit and a moderator write that changes nothing
 * all write nothing and emit nothing.
 *
 * **Authorization lives HERE rather than in the statement, and that is deliberate for this domain.**
 * The canonical owner of a group is `COALESCE(founder_id, owner_id)` — the founder-wins rule
 * `rowToGroup` applies at the read boundary — and neither half can be a SQL predicate: `owner_id`
 * alone refuses a promoted founder, and naming `founder_id` breaks the moment
 * `contract-drop-house-columns.sql` runs. So the decision is made from `rowToGroup`'s answer, once,
 * and the statement anchors on the group id.
 */
import {
  addModerator as storeAddModerator,
  createGroup as storeCreateGroup,
  ensureGeneralGroup as storeEnsureGeneralGroup,
  getAgentByName,
  getGroup,
  joinGroupWithOutcome as storeJoinGroup,
  leaveGroup as storeLeaveGroup,
  removeModerator as storeRemoveModerator,
  subscribeToGroup as storeSubscribeToGroup,
  unsubscribeFromGroup as storeUnsubscribeFromGroup,
  updateGroupSettings as storeUpdateGroupSettings,
} from "@/lib/store";
import { STORE_ASSIGNED_PAYLOAD_ID, type PreparedEvent } from "@/lib/events/kinds";
import { groupSchoolAccessDenial, groupSchoolId } from "@/lib/school-context";
import {
  suppliedGroupSettingsFields,
  type GroupSettingsUpdates,
} from "@/lib/store/groups/settings-fields";
import type { StoredAgent, StoredGroup } from "@/lib/store-types";

import { actionError, actionOk, type ActionResult } from "./types";

/** Every group action addresses its subject the same way: by the name the caller used. */
export interface GroupActionInput {
  agent: StoredAgent;
  /** As the caller named it. Resolution and its refusal are this action's, not the adapter's. */
  groupName: string;
}

/** What a group mutation reports: the group it acted on, resolved and canonical. */
export interface GroupActionResult {
  group: StoredGroup;
}

/**
 * Resolve the group and apply the school rule — the two steps every group mutation starts with.
 *
 * Shared rather than repeated because it is the pair that drifted: the school rule is applied by
 * name in seven places today, and `group-school-gate.test.ts` exists precisely because one of them
 * kept being forgotten. One helper, reached by every export, is what the ACTION scan there follows.
 */
type ResolvedGroup = { ok: true; group: StoredGroup } | { ok: false; result: ActionResult<never> };

async function resolveGroup(input: GroupActionInput): Promise<ResolvedGroup> {
  const group = await getGroup(input.groupName);
  if (!group) return { ok: false, result: actionError("group_not_found", `Group "${input.groupName}" not found`) };
  const denial = groupSchoolAccessDenial(input.agent, group);
  if (denial) return { ok: false, result: actionError(denial.code, denial.error) };
  return { ok: true, group };
}

/**
 * A group event: the actor is the agent, the SUBJECT COLUMN is the group, and the payload is empty.
 *
 * Empty for the reason `agent.followed`'s is (`EventPayloadMap`): a payload copy of an id the
 * columns already carry is a second place for the two to disagree. `school_id` comes from
 * `groupSchoolId`, never from `group.schoolId` directly — NULL means Foundation for every group
 * created before per-school scoping existed, and an event stamped NULL would put the platform's
 * oldest groups in no school at all.
 */
function groupEvent(
  kind: "group.joined" | "group.left" | "group.subscribed" | "group.unsubscribed",
  agent: StoredAgent,
  group: StoredGroup
): PreparedEvent {
  return {
    kind,
    actorAgentId: agent.id,
    subjectType: "group",
    subjectId: group.id,
    schoolId: groupSchoolId(group),
    payload: {},
  };
}

// ---------------------------------------------------------------------------
// createGroup
// ---------------------------------------------------------------------------

export interface CreateGroupInput {
  agent: StoredAgent;
  /** Already normalized by the adapter, which owns the "name is required" refusal. */
  name: string;
  displayName: string;
  description: string;
  /** The requesting school, so the group is listed by it. */
  schoolId?: string;
}

/**
 * Create a group.
 *
 * **No school gate**: there is no group yet to be owned by another school, and the creation is
 * scoped to the school the request arrived on — which is the rule the REST surface already applied.
 *
 * The store throws for a duplicate name, and that throw is the only classification this action can
 * make: `createGroup` derives the id from the name, so "already exists" and a genuine write failure
 * are told apart by the message the store raises, exactly as the route told them apart before.
 * `subject_id` is store-assigned, because the id is derived inside the store.
 */
export async function createGroup(input: CreateGroupInput): Promise<ActionResult<GroupActionResult>> {
  const event: PreparedEvent<"group.created"> = {
    kind: "group.created",
    actorAgentId: input.agent.id,
    subjectType: "group",
    // Store-assigned: the id is derived from the name inside the store's own statement.
    subjectId: STORE_ASSIGNED_PAYLOAD_ID,
    schoolId: groupSchoolId({ schoolId: input.schoolId ?? null }),
    payload: {},
  };
  try {
    const group = await storeCreateGroup(
      input.name,
      input.displayName,
      input.description,
      input.agent.id,
      input.schoolId,
      [event]
    );
    return actionOk({ group });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to create group";
    return message.includes("already exists")
      ? actionError("already_exists", "Group already exists")
      : actionError("bad_request", message);
  }
}

// ---------------------------------------------------------------------------
// ensureGeneralMembership
// ---------------------------------------------------------------------------

/**
 * The platform's automatic `general` membership — **a producer, not a fixture helper**.
 *
 * Vetting completion, public-AI provisioning and the agent loop all reach this, so the row it writes
 * is an ordinary membership with an ordinary trail row. The store's eventless form emitted nothing,
 * which left that trail row uncorrelatable during the soak and, once the inline writer is deleted,
 * absent altogether — and an ensure that won the insert against a concurrent explicit join turned
 * the action's join into a duplicate, so the membership change had no event from either side.
 *
 * **It takes an id, not a `StoredAgent`, and it applies NO school gate** — deliberately, and the
 * two facts are the same fact. This is the platform granting a membership rather than an agent
 * asking for one: `general` is the default group every agent gets, the callers grant it at
 * vetting/provisioning time, and gating it would change who ends up in it. What the action owns here
 * is the EVENTS, which is what was missing.
 *
 * Both kinds are gated by the mutation that decides them, so a repeat ensure emits nothing.
 * `subject_id` is store-assigned on both: the store owns the `general` id.
 */
export async function ensureGeneralMembership(input: {
  agentId: string;
}): Promise<ActionResult<Record<string, never>>> {
  // `general` predates per-school scoping and carries `school_id IS NULL`, which `groupSchoolId`
  // reads as Foundation — named here rather than read back, because resolving the group would be a
  // second read of a row the store is about to resolve authoritatively anyway.
  const schoolId = groupSchoolId({ schoolId: null });
  const subjects = {
    actorAgentId: input.agentId,
    subjectType: "group" as const,
    subjectId: STORE_ASSIGNED_PAYLOAD_ID,
    schoolId,
    payload: {},
  };
  await storeEnsureGeneralGroup(input.agentId, {
    created: [{ ...subjects, kind: "group.created" } satisfies PreparedEvent<"group.created">],
    joined: [{ ...subjects, kind: "group.joined" } satisfies PreparedEvent<"group.joined">],
  });
  return actionOk({});
}

// ---------------------------------------------------------------------------
// joinGroup / leaveGroup
// ---------------------------------------------------------------------------

export interface JoinGroupResult extends GroupActionResult {
  /**
   * The caller was already a member: nothing written, nothing emitted.
   *
   * It is a MEASUREMENT from the insert's own `ON CONFLICT`, not a pre-read — the route used to ask
   * `isGroupMember` first and answer from that, which a concurrent join could contradict between
   * the two statements.
   */
  alreadyMember: boolean;
}

export async function joinGroup(input: GroupActionInput): Promise<ActionResult<JoinGroupResult>> {
  const resolved = await resolveGroup(input);
  if (!resolved.ok) return resolved.result;

  const outcome = await storeJoinGroup(input.agent.id, resolved.group.id, [
    groupEvent("group.joined", input.agent, resolved.group),
  ]);
  if (!outcome.success) return actionError("bad_request", outcome.error ?? "Failed to join group");
  return actionOk({ group: resolved.group, alreadyMember: outcome.alreadyMember });
}

/**
 * Leave a group.
 *
 * `not_group_member` rather than a bare validation error: both surfaces publish the store's own
 * wording, and the code is what lets them keep doing so while the action stays honest about which
 * of the two refusals happened.
 */
export async function leaveGroup(input: GroupActionInput): Promise<ActionResult<GroupActionResult>> {
  const resolved = await resolveGroup(input);
  if (!resolved.ok) return resolved.result;

  const left = await storeLeaveGroup(input.agent.id, resolved.group.id, [
    groupEvent("group.left", input.agent, resolved.group),
  ]);
  if (!left.success) {
    const message = left.error ?? "Failed to leave group";
    return message === "Not a member of this group"
      ? actionError("not_group_member", message)
      : actionError("bad_request", message);
  }
  return actionOk({ group: resolved.group });
}

// ---------------------------------------------------------------------------
// subscribeToGroup / unsubscribeFromGroup — the legacy feed-subscription surface
// ---------------------------------------------------------------------------

/**
 * Subscribe: membership and **nothing else**, which is the pinned invariant this surface carries.
 *
 * The store's boolean means "the group still existed"; both surfaces have always published success
 * regardless, so it is not classified here either — the group was already resolved, and a group
 * that vanished in between is not a refusal either surface has ever produced.
 */
export async function subscribeToGroup(input: GroupActionInput): Promise<ActionResult<GroupActionResult>> {
  const resolved = await resolveGroup(input);
  if (!resolved.ok) return resolved.result;
  await storeSubscribeToGroup(input.agent.id, resolved.group.id, [
    groupEvent("group.subscribed", input.agent, resolved.group),
  ]);
  return actionOk({ group: resolved.group });
}

export async function unsubscribeFromGroup(input: GroupActionInput): Promise<ActionResult<GroupActionResult>> {
  const resolved = await resolveGroup(input);
  if (!resolved.ok) return resolved.result;
  await storeUnsubscribeFromGroup(input.agent.id, resolved.group.id, [
    groupEvent("group.unsubscribed", input.agent, resolved.group),
  ]);
  return actionOk({ group: resolved.group });
}

// ---------------------------------------------------------------------------
// updateGroupSettings
// ---------------------------------------------------------------------------

export interface UpdateGroupSettingsInput extends GroupActionInput {
  updates: GroupSettingsUpdates;
}

/**
 * Update a group's settings — **owner only, on both surfaces**.
 *
 * That is the u3c behavior change, and it is a live authorization hole rather than a tidy-up: the
 * `update_group_settings` TOOL applied no ownership check whatsoever, so any agent could rename any
 * group, rewrite its description and change its emoji. The REST route has always required the
 * owner. One decision, here, and both surfaces inherit it.
 *
 * The ownership test is `group.ownerId`, which is `rowToGroup`'s founder-wins answer — see this
 * module's header for why it cannot be a SQL predicate.
 */
export async function updateGroupSettings(
  input: UpdateGroupSettingsInput
): Promise<ActionResult<GroupActionResult>> {
  const resolved = await resolveGroup(input);
  if (!resolved.ok) return resolved.result;
  if (resolved.group.ownerId !== input.agent.id) {
    return actionError("forbidden", "Only the owner can update settings");
  }

  const fields = suppliedGroupSettingsFields(input.updates);
  const updated = await storeUpdateGroupSettings(resolved.group.id, input.updates, [
    {
      kind: "group.settings_updated",
      actorAgentId: input.agent.id,
      subjectType: "group",
      subjectId: resolved.group.id,
      schoolId: groupSchoolId(resolved.group),
      // WHICH fields, never their values — see `EventPayloadMap`. A call that supplies none writes
      // nothing and emits nothing, so this list is never empty in a recorded event.
      payload: { fields },
    } satisfies PreparedEvent<"group.settings_updated">,
  ]);
  // The group vanished between the resolution and the update. Same refusal as a name that never
  // resolved; the statement wrote nothing and emitted nothing.
  if (!updated) return actionError("group_not_found", `Group "${input.groupName}" not found`);
  return actionOk({ group: updated });
}

// ---------------------------------------------------------------------------
// addModerator / removeModerator
// ---------------------------------------------------------------------------

export interface ModeratorInput extends GroupActionInput {
  /** The agent to promote or demote, as the caller named it. */
  targetName: string;
}

export interface ModeratorResult extends GroupActionResult {
  targetName: string;
}

/**
 * Promote or demote a moderator.
 *
 * **The two refusals stay distinct at this layer even though both surfaces collapse them.** The
 * route publishes one "Forbidden or agent not found" string and the tool one "must be group owner"
 * string, for a caller who is not the owner AND for a name that does not exist — the same
 * conflation `followAgent` keeps apart for the same reason: an action that merged them would force
 * a surface that wanted to separate them to re-read the name.
 *
 * The store resolves the target name again, and ITS resolution is the authoritative one — the id it
 * writes and the id in the event's `secondary_subject_id` both come from there. This read only
 * chooses between two refusals, so a rename landing in between costs at worst a stale refusal
 * rather than an event naming an agent nobody touched.
 */
export function addModerator(input: ModeratorInput): Promise<ActionResult<ModeratorResult>> {
  return writeModerator(input, "add");
}

export function removeModerator(input: ModeratorInput): Promise<ActionResult<ModeratorResult>> {
  return writeModerator(input, "remove");
}

async function writeModerator(
  input: ModeratorInput,
  operation: "add" | "remove"
): Promise<ActionResult<ModeratorResult>> {
  const resolved = await resolveGroup(input);
  if (!resolved.ok) return resolved.result;
  if (resolved.group.ownerId !== input.agent.id) {
    return actionError("forbidden", `Only the owner can ${operation} moderators`);
  }
  if (!(await getAgentByName(input.targetName))) {
    return actionError("not_found", `Agent "@${input.targetName}" not found`);
  }

  const event: PreparedEvent = {
    kind: operation === "add" ? "group.moderator_added" : "group.moderator_removed",
    actorAgentId: input.agent.id,
    subjectType: "group",
    subjectId: resolved.group.id,
    // Store-assigned from the store's OWN name resolution — see the note above.
    secondarySubjectId: STORE_ASSIGNED_PAYLOAD_ID,
    schoolId: groupSchoolId(resolved.group),
    payload: {},
  };
  const write = operation === "add" ? storeAddModerator : storeRemoveModerator;
  const ok = await write(resolved.group.id, input.agent.id, input.targetName, [event]);
  // The store re-checks ownership and the name under its own reads; a `false` here means one of
  // them changed since this action asked, and it is the same refusal either way.
  if (!ok) return actionError("forbidden", `Only the owner can ${operation} moderators`);
  return actionOk({ group: resolved.group, targetName: input.targetName });
}
