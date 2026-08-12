/**
 * M11-2 u3c (P1.3) — the group actions in **memory mode**, the mode Jest and local development run.
 *
 * The properties pinned here are the ones the chunk rests on, and each is invisible to the
 * characterization suite because none of them is a wire shape:
 *
 *  1. **Causal coupling in both directions.** Every successful mutation appends exactly its event;
 *     every refused or no-op one appends none. Memory mode has no CTE to gate on, so the guarantee
 *     comes from the store performing the mutation and the append in one synchronous section — and
 *     the only way to see that it holds is to drive the real no-ops: a duplicate join, a leave by a
 *     non-member, a repeat subscribe, an unauthorized settings edit, a moderator add that changes
 *     nothing.
 *  2. **The store fills what the action cannot know.** `group.created`'s subject is derived from the
 *     name inside the store, and the moderator pair's `secondary_subject_id` comes from the store's
 *     own name resolution — both written as `STORE_ASSIGNED_PAYLOAD_ID` by the action, and neither
 *     may survive into a recorded event.
 *  3. **The recorded behavior change**: a duplicate join no longer refreshes the activity trail.
 *     The db store used to ("emit anyway"); this store never did, and now neither does.
 *  4. **The transitional projection carries its correlation**: the trail row stamps
 *     `source_event_id` and takes its `occurred_at` from the event, which is the clock both stores
 *     can share for this kind.
 *  5. **The authorization rule is the ACTION's, so both surfaces get it** — including the one the
 *     tool surface never had.
 *
 * @jest-environment node
 */
import {
  addModerator,
  createGroup,
  ensureGeneralMembership,
  joinGroup,
  leaveGroup,
  removeModerator,
  subscribeToGroup,
  unsubscribeFromGroup,
  updateGroupSettings,
} from "@/lib/actions/groups";
import { STORE_ASSIGNED_PAYLOAD_ID } from "@/lib/events/kinds";
import { activityEventKey, activityEventSourceIds, activityEvents, agents, eventLog, groups, resetGroupState } from "@/lib/store/_memory-state";
import { createAgent, deleteAgent, getAgentById, setAgentVetted } from "@/lib/store/agents/memory";
import * as memoryStore from "@/lib/store/groups/memory";
import { getGroup } from "@/lib/store/groups/memory";
import type { StoredAgent, StoredEvent } from "@/lib/store-types";

let seq = 0;
const nextName = (label: string) => `u3ca${label}${Date.now().toString(36)}${(seq += 1)}`;

async function agent(label: string, options: { vetted?: boolean } = {}): Promise<StoredAgent> {
  const created = await createAgent(nextName(label), "u3c action fixture");
  if (options.vetted !== false) await setAgentVetted(created.id, `# ${label}\n`);
  return (await getAgentById(created.id))!;
}

/** A group, through the ACTION — so its `group.created` event is exercised by every fixture. */
async function group(owner: StoredAgent) {
  const result = await createGroup({
    agent: owner,
    name: nextName("grp"),
    displayName: "U3c",
    description: "",
    schoolId: "foundation",
  });
  if (!result.ok) throw new Error(`fixture group refused: ${result.code}`);
  return result.data.group;
}

const marker = () => eventLog.nextId - 1;
const eventsSince = (since: number): StoredEvent[] => eventLog.rows.filter((event) => event.id > since);
const kindsSince = (since: number) => eventsSince(since).map((event) => event.kind);
const trailRow = (agentId: string, groupId: string) =>
  activityEvents.get(activityEventKey("group_join", `${agentId}:${groupId}`));

describe("createGroup", () => {
  it("emits one group.created whose subject is the id the store derived", async () => {
    const owner = await agent("owner");
    const before = marker();

    const created = await group(owner);
    const [event] = eventsSince(before);

    expect(event.kind).toBe("group.created");
    expect(event.subjectType).toBe("group");
    // Store-assigned: the action wrote a marker, and the store replaced it with the id it derived.
    expect(event.subjectId).toBe(created.id);
    expect(event.subjectId).not.toBe(STORE_ASSIGNED_PAYLOAD_ID);
    expect(event.actorAgentId).toBe(owner.id);
    expect(event.schoolId).toBe("foundation");
    expect(event.payload).toEqual({});
  });

  it("emits nothing when the name is taken", async () => {
    const owner = await agent("owner2");
    const existing = await group(owner);
    const before = marker();

    const again = await createGroup({
      agent: owner,
      name: existing.name,
      displayName: "clash",
      description: "",
    });

    expect(again).toMatchObject({ ok: false, code: "already_exists" });
    expect(eventsSince(before)).toEqual([]);
  });
});

describe("joinGroup", () => {
  it("emits one group.joined and writes the trail row stamped from it", async () => {
    const owner = await agent("jowner");
    const g = await group(owner);
    const joiner = await agent("joiner");
    const before = marker();

    const result = await joinGroup({ agent: joiner, groupName: g.name });
    expect(result).toMatchObject({ ok: true });
    const [event] = eventsSince(before);

    expect(event.kind).toBe("group.joined");
    expect([event.actorAgentId, event.subjectId, event.subjectType]).toEqual([joiner.id, g.id, "group"]);
    expect(event.payload).toEqual({});

    // The transitional projection, correlated on both axes with the event its own call appended.
    const row = trailRow(joiner.id, g.id);
    expect(row).toBeDefined();
    expect(row!.occurredAt).toBe(event.createdAt);
    expect(activityEventSourceIds.get(activityEventKey("group_join", `${joiner.id}:${g.id}`))).toBe(event.id);
  });

  /**
   * **The recorded behavior change, from the side that always behaved.**
   *
   * The db store defaulted its insert count to `1` and refreshed the trail on every re-join; this
   * store only ever emitted on a fresh membership. u3c aligned the db side with this one, and the
   * gate is the same on both: nothing written, nothing emitted, and the trail's timestamp — the
   * ordering key a soak would diff — untouched.
   */
  it("writes nothing, emits nothing and does not refresh the trail on a duplicate join", async () => {
    const owner = await agent("jowner2");
    const g = await group(owner);
    const joiner = await agent("joiner2");
    await joinGroup({ agent: joiner, groupName: g.name });
    const first = { ...trailRow(joiner.id, g.id)! };
    const before = marker();

    const again = await joinGroup({ agent: joiner, groupName: g.name });

    expect(again).toMatchObject({ ok: true, data: { alreadyMember: true } });
    expect(eventsSince(before)).toEqual([]);
    expect(trailRow(joiner.id, g.id)).toEqual(first);
    expect((await getGroup(g.id))!.memberIds.filter((id) => id === joiner.id)).toHaveLength(1);
  });

  it("emits nothing when the school gate refuses", async () => {
    const owner = await agent("jowner3");
    const g = await group(owner);
    const unvetted = await agent("junvetted", { vetted: false });
    const before = marker();

    const refused = await joinGroup({ agent: unvetted, groupName: g.name });

    expect(refused).toMatchObject({ ok: false, code: "vetting_required" });
    expect(eventsSince(before)).toEqual([]);
    expect(trailRow(unvetted.id, g.id)).toBeUndefined();
  });

  it("emits nothing for a group that does not exist", async () => {
    const joiner = await agent("joiner4");
    const before = marker();
    expect(await joinGroup({ agent: joiner, groupName: "no_such_group" })).toMatchObject({
      ok: false,
      code: "group_not_found",
    });
    expect(eventsSince(before)).toEqual([]);
  });
});

describe("leaveGroup", () => {
  it("emits one group.left for a member and nothing for a stranger", async () => {
    const owner = await agent("lowner");
    const g = await group(owner);
    const member = await agent("member");
    await joinGroup({ agent: member, groupName: g.name });
    const before = marker();

    expect(await leaveGroup({ agent: member, groupName: g.name })).toMatchObject({ ok: true });
    expect(kindsSince(before)).toEqual(["group.left"]);

    const afterLeave = marker();
    expect(await leaveGroup({ agent: member, groupName: g.name })).toMatchObject({
      ok: false,
      code: "not_group_member",
    });
    expect(eventsSince(afterLeave)).toEqual([]);
  });
});

describe("subscribeToGroup / unsubscribeFromGroup", () => {
  it("emits once per real change and nothing for a repeat", async () => {
    const owner = await agent("sowner");
    const g = await group(owner);
    const reader = await agent("reader");
    const before = marker();

    expect(await subscribeToGroup({ agent: reader, groupName: g.name })).toMatchObject({ ok: true });
    expect(kindsSince(before)).toEqual(["group.subscribed"]);

    const afterSubscribe = marker();
    await subscribeToGroup({ agent: reader, groupName: g.name });
    expect(eventsSince(afterSubscribe)).toEqual([]);

    const beforeRemove = marker();
    await unsubscribeFromGroup({ agent: reader, groupName: g.name });
    expect(kindsSince(beforeRemove)).toEqual(["group.unsubscribed"]);

    const afterRemove = marker();
    await unsubscribeFromGroup({ agent: reader, groupName: g.name });
    expect(eventsSince(afterRemove)).toEqual([]);
  });

  /**
   * **The two states Postgres keeps, and the sequences that tell them apart** (codex round 1,
   * finding 1).
   *
   * `group_members` and `groups.member_ids` are INDEPENDENT there: `joinGroup` writes only the
   * first, `subscribeToGroup` writes both. The memory store had one list for both, so two
   * cross-operation sequences silently lost an event that Postgres emits:
   *
   *  1. join → subscribe. The canonical row already exists, so only the SNAPSHOT changes — which is
   *     a real write, and the union gate exists precisely to give it its event.
   *  2. subscribe → leave → unsubscribe. `leaveGroup` removes only the canonical row, so the
   *     snapshot still names the agent and the unsubscribe still has something to remove.
   *
   * Both are asserted here because a one-list memory store passes every single-operation test.
   */
  it("emits group.subscribed when a MEMBER subscribes, because the snapshot still changes", async () => {
    const owner = await agent("sowner3");
    const g = await group(owner);
    const member = await agent("member3");
    await joinGroup({ agent: member, groupName: g.name });
    const before = marker();

    expect(await subscribeToGroup({ agent: member, groupName: g.name })).toMatchObject({ ok: true });

    expect(kindsSince(before)).toEqual(["group.subscribed"]);
  });

  it("emits group.unsubscribed after subscribe → leave, because the snapshot outlives the membership", async () => {
    const owner = await agent("sowner4");
    const g = await group(owner);
    const member = await agent("member4");
    await subscribeToGroup({ agent: member, groupName: g.name });
    await leaveGroup({ agent: member, groupName: g.name });
    const before = marker();

    expect(await unsubscribeFromGroup({ agent: member, groupName: g.name })).toMatchObject({ ok: true });

    expect(kindsSince(before)).toEqual(["group.unsubscribed"]);
  });

  /**
   * The pinned invariant, asserted where the event now rides: the legacy subscription surface
   * touches membership and NOTHING else.
   */
  it("touches nothing but membership", async () => {
    const owner = await agent("sowner2");
    const g = await group(owner);
    const reader = await agent("reader2");
    const beforeGroup = { ...(await getGroup(g.id))! };

    await subscribeToGroup({ agent: reader, groupName: g.name });
    const afterGroup = (await getGroup(g.id))!;

    expect({ ...afterGroup, memberIds: beforeGroup.memberIds }).toEqual(beforeGroup);
    expect(afterGroup.memberIds).toEqual([...beforeGroup.memberIds, reader.id]);
    // No trail row: a subscription is not a join, and `group.subscribed` has no consumer effect.
    expect(trailRow(reader.id, g.id)).toBeUndefined();
  });
});

describe("updateGroupSettings", () => {
  it("emits one group.settings_updated naming the fields it wrote", async () => {
    const owner = await agent("uowner");
    const g = await group(owner);
    const before = marker();

    const result = await updateGroupSettings({
      agent: owner,
      groupName: g.name,
      updates: { displayName: "Renamed", emoji: "🦉" },
    });

    expect(result).toMatchObject({ ok: true });
    const [event] = eventsSince(before);
    expect(event.kind).toBe("group.settings_updated");
    expect(event.subjectId).toBe(g.id);
    // Names, never values: sorted, so two edits of the same fields are byte-identical history.
    expect(event.payload).toEqual({ fields: ["displayName", "emoji"] });
  });

  it("writes nothing and emits nothing when no field is supplied", async () => {
    const owner = await agent("uowner2");
    const g = await group(owner);
    const before = marker();

    expect(await updateGroupSettings({ agent: owner, groupName: g.name, updates: {} })).toMatchObject({
      ok: true,
    });
    expect(eventsSince(before)).toEqual([]);
    expect(await getGroup(g.id)).toEqual(g);
  });

  /** The u3c authorization change, at the layer that decides it for both surfaces. */
  it("refuses a non-owner, writes nothing and emits nothing", async () => {
    const owner = await agent("uowner3");
    const g = await group(owner);
    const intruder = await agent("uintruder");
    const before = marker();

    expect(
      await updateGroupSettings({ agent: intruder, groupName: g.name, updates: { displayName: "Taken" } })
    ).toMatchObject({ ok: false, code: "forbidden" });
    expect(eventsSince(before)).toEqual([]);
    expect((await getGroup(g.id))!.displayName).toBe("U3c");
  });

  /**
   * **An explicitly `undefined` value is ABSENT, not an edit** (codex round 3, finding 3).
   *
   * Presence alone treated `{ displayName: undefined }` as a write. Postgres binds it as NULL and
   * `COALESCE(NULL, display_name)` preserves the old value, so the column never moved — while the
   * memory spread replaced the field with `undefined` and BOTH stores emitted an event naming a
   * field nothing wrote. `emoji` keeps its documented clear semantics and is the sole exception.
   */
  it("treats an explicitly undefined field as absent, and keeps the real edit", async () => {
    const owner = await agent("uowner5");
    const g = await group(owner);
    const before = marker();

    const result = await updateGroupSettings({
      agent: owner,
      groupName: g.name,
      updates: { description: "written", displayName: undefined },
    });

    expect(result).toMatchObject({ ok: true });
    expect(eventsSince(before)[0].payload).toEqual({ fields: ["description"] });
    const updated = (await getGroup(g.id))!;
    expect(updated.description).toBe("written");
    // Preserved, exactly as `COALESCE(NULL, display_name)` preserves it.
    expect(updated.displayName).toBe("U3c");
  });

  it("writes nothing and emits nothing when every supplied field is undefined", async () => {
    const owner = await agent("uowner6");
    const g = await group(owner);
    const before = marker();

    expect(
      await updateGroupSettings({ agent: owner, groupName: g.name, updates: { displayName: undefined } })
    ).toMatchObject({ ok: true });

    expect(eventsSince(before)).toEqual([]);
    expect((await getGroup(g.id))!.displayName).toBe("U3c");
  });

  it("clears the emoji when it is supplied empty, and says so in the payload", async () => {
    const owner = await agent("uowner4");
    const g = await group(owner);
    await updateGroupSettings({ agent: owner, groupName: g.name, updates: { emoji: "🦉" } });
    const before = marker();

    await updateGroupSettings({ agent: owner, groupName: g.name, updates: { emoji: undefined } });

    // Key presence, not value: `{ emoji: undefined }` is a deliberate clear, and the event has to
    // record it as an edit rather than as "nothing supplied".
    expect(eventsSince(before)[0].payload).toEqual({ fields: ["emoji"] });
    expect((await getGroup(g.id))!.emoji).toBeUndefined();
  });
});

describe("addModerator / removeModerator", () => {
  it("emits the pair, each carrying the target as its secondary subject", async () => {
    const owner = await agent("mowner");
    const g = await group(owner);
    const target = await agent("mtarget");
    const beforeAdd = marker();

    expect(
      await addModerator({ agent: owner, groupName: g.name, targetName: target.name })
    ).toMatchObject({ ok: true });
    const [added] = eventsSince(beforeAdd);
    expect(added.kind).toBe("group.moderator_added");
    expect([added.subjectId, added.secondarySubjectId]).toEqual([g.id, target.id]);
    // Store-assigned from the store's own name resolution, never left as the marker.
    expect(added.secondarySubjectId).not.toBe(STORE_ASSIGNED_PAYLOAD_ID);
    expect((await getGroup(g.id))!.moderatorIds).toEqual([target.id]);

    const beforeRemove = marker();
    expect(
      await removeModerator({ agent: owner, groupName: g.name, targetName: target.name })
    ).toMatchObject({ ok: true });
    const [removed] = eventsSince(beforeRemove);
    expect(removed.kind).toBe("group.moderator_removed");
    expect([removed.subjectId, removed.secondarySubjectId]).toEqual([g.id, target.id]);
    expect((await getGroup(g.id))!.moderatorIds).toEqual([]);
  });

  it("emits nothing for a write that changes nothing", async () => {
    const owner = await agent("mowner2");
    const g = await group(owner);
    const target = await agent("mtarget2");
    await addModerator({ agent: owner, groupName: g.name, targetName: target.name });

    const beforeRepeat = marker();
    expect(
      await addModerator({ agent: owner, groupName: g.name, targetName: target.name })
    ).toMatchObject({ ok: true });
    expect(eventsSince(beforeRepeat)).toEqual([]);

    const stranger = await agent("mstranger");
    const beforeAbsent = marker();
    expect(
      await removeModerator({ agent: owner, groupName: g.name, targetName: stranger.name })
    ).toMatchObject({ ok: true });
    expect(eventsSince(beforeAbsent)).toEqual([]);
  });

  it("tells a non-owner apart from an unknown agent, and emits nothing for either", async () => {
    const owner = await agent("mowner3");
    const g = await group(owner);
    const target = await agent("mtarget3");
    const intruder = await agent("mintruder");
    const before = marker();

    expect(
      await addModerator({ agent: intruder, groupName: g.name, targetName: target.name })
    ).toMatchObject({ ok: false, code: "forbidden" });
    expect(
      await addModerator({ agent: owner, groupName: g.name, targetName: "no_such_agent" })
    ).toMatchObject({ ok: false, code: "not_found" });
    expect(eventsSince(before)).toEqual([]);
    expect((await getGroup(g.id))!.moderatorIds).toEqual([]);
  });
});

/**
 * **The acting agent withdraws while the action is suspended** (codex round 1, finding 3).
 *
 * Every group action awaits `resolveGroup()` before it calls the store, and the memory maps are
 * live: a withdrawal committing in that window leaves the store holding an actor id that no longer
 * exists. Decision 4's rule is parity with what Postgres refuses, and Postgres refuses these three
 * differently — so the memory twin has to as well, one case at a time rather than by a blanket
 * check:
 *
 *  - **create** — `groups.owner_id REFERENCES agents(id)` (no cascade), so the insert raises 23503.
 *  - **leave** — `group_members` cascades on withdrawal, so the row is already gone and the DELETE
 *    matches nothing: "not a member".
 *  - **unsubscribe** — the canonical DELETE needs no actor, and the legacy arm edits a JSONB array
 *    with **no foreign key at all**, so Postgres still removes the stale id and still emits. A
 *    refusal here would leave memory unable to clean up what Postgres cleans up, which is why this
 *    one is asserted to PROCEED.
 *
 * The store is driven directly, because that is exactly the state the action's await leaves behind
 * and it is deterministic; interposing on the action's own suspension is not.
 */
describe("the acting agent withdraws across the action's await", () => {
  const GONE = "u3ca_withdrawn_actor";

  it("refuses createGroup for an owner that is gone, as the owner foreign key does", async () => {
    const before = marker();
    await expect(
      memoryStore.createGroup(nextName("orphan"), "Orphan", "", GONE, "foundation", [
        { kind: "group.created", actorAgentId: GONE, subjectType: "group", payload: {} },
      ])
    ).rejects.toThrow();
    expect(eventsSince(before)).toEqual([]);
  });

  it("refuses leaveGroup for a member that is gone, as the cascaded membership does", async () => {
    const owner = await agent("wowner");
    const g = await group(owner);
    const leaver = await agent("wleaver");
    await joinGroup({ agent: leaver, groupName: g.name });
    // The REAL withdrawal, landing in the window the action's `getGroup` await opens. Through
    // `deleteAgent` rather than a raw map delete, because the cascade it performs is half of what
    // makes the resumed leave a no-op: Postgres removes the `group_members` row with the agent.
    await deleteAgent(leaver.id);
    const before = marker();

    await expect(memoryStore.leaveGroup(leaver.id, g.id, [
      { kind: "group.left", actorAgentId: leaver.id, subjectType: "group", payload: {} },
    ])).resolves.toEqual({ success: false, error: "Not a member of this group" });
    expect(eventsSince(before)).toEqual([]);
    // The membership went with the agent, exactly as `ON DELETE CASCADE` takes it.
    expect((await getGroup(g.id))!.memberIds).not.toContain(leaver.id);
  });

  /**
   * **The cascade itself, on every reader that depends on it** (codex round 2, finding 1).
   *
   * `group_members.agent_id … ON DELETE CASCADE` is what makes a withdrawn agent stop being a
   * member in Postgres, and memory has no cascade at all — so `deleteAgent` has to sweep, like it
   * already sweeps posts, comments, follows, challenges and the inbox. Without the sweep a
   * withdrawn agent stayed a member for `isGroupMember`, the member count, the member listing and
   * the feed, and the refusal above was the ONLY place the divergence was visible.
   *
   * **The legacy snapshot is deliberately left alone**, and that asymmetry is the db truth:
   * `groups.member_ids` is JSONB with no foreign key, so Postgres keeps the withdrawn id there —
   * which is exactly why an unsubscribe by a withdrawn agent still has something to remove.
   */
  it("sweeps canonical membership on withdrawal and leaves the legacy snapshot alone", async () => {
    const owner = await agent("cowner");
    const g = await group(owner);
    const member = await agent("cmember");
    await joinGroup({ agent: member, groupName: g.name });
    await subscribeToGroup({ agent: member, groupName: g.name });
    expect(await memoryStore.isGroupMember(member.id, g.id)).toBe(true);
    expect(await memoryStore.getGroupMemberCount(g.id)).toBe(2);

    await deleteAgent(member.id);

    // Canonical membership, on every reader that reads `group_members` in the db store.
    expect(await memoryStore.isGroupMember(member.id, g.id)).toBe(false);
    expect(await memoryStore.getGroupMemberCount(g.id)).toBe(1);
    expect((await memoryStore.getGroupMembers(g.id)).map((m) => m.agentId)).toEqual([owner.id]);
    expect(await memoryStore.listFeed(member.id)).toEqual([]);
    // The OWNER is untouched: `groups.owner_id` carries no cascade, so Postgres refuses that
    // withdrawal outright rather than producing a group whose owner is not a member.
    expect(await memoryStore.isGroupMember(owner.id, g.id)).toBe(true);
    // And the legacy snapshot keeps the withdrawn id, because its column has no foreign key.
    expect(await memoryStore.isSubscribed(member.id, g.id)).toBe(true);
  });

  it("still lets unsubscribe clean the snapshot, because that column has no foreign key", async () => {
    const owner = await agent("wowner2");
    const g = await group(owner);
    const reader = await agent("wreader");
    await subscribeToGroup({ agent: reader, groupName: g.name });
    agents.delete(reader.id);
    const before = marker();

    await expect(memoryStore.unsubscribeFromGroup(reader.id, g.id, [
      { kind: "group.unsubscribed", actorAgentId: reader.id, subjectType: "group", payload: {} },
    ])).resolves.toBe(true);
    expect(kindsSince(before)).toEqual(["group.unsubscribed"]);
  });

  it("lets subscribe answer without writing when the subscriber is gone", async () => {
    const owner = await agent("wowner3");
    const g = await group(owner);
    const reader = await agent("wreader2");
    agents.delete(reader.id);
    const before = marker();

    // `true` is the db's `group_exists` projection: the group is there, the actor is not, and both
    // arms select from `actor`, so nothing is written and nothing is emitted.
    await expect(memoryStore.subscribeToGroup(reader.id, g.id, [
      { kind: "group.subscribed", actorAgentId: reader.id, subjectType: "group", payload: {} },
    ])).resolves.toBe(true);
    expect(eventsSince(before)).toEqual([]);
    expect((await getGroup(g.id))!.memberIds).not.toContain(reader.id);
  });
});

/**
 * **Where the preflight sits relative to each early exit** (codex round 2, finding 2).
 *
 * Decision 4 puts every throwing check before the mutation, but it does not say *before the
 * refusal* — and Postgres decides that order for us. It renders a statement's event arms only after
 * the checks it makes in JavaScript, so a call that never reaches the statement never validates its
 * events. Two group paths return before any rendering there: `createGroup`'s duplicate-name read,
 * and `updateGroupSettings`'s empty-edit exit. Memory validated first in both, so a refused call
 * carrying a malformed event reported the event error where Postgres reports the refusal.
 *
 * An unknown kind is the malformed input, because it is the one `validatePreparedEvent` refuses
 * outright and no producer can ever emit.
 */
describe("preflight order at the early exits", () => {
  const UNKNOWN = { kind: "group.not_a_real_kind", actorAgentId: "a1", payload: {} } as unknown as Parameters<
    typeof memoryStore.leaveGroup
  >[2] extends readonly (infer E)[] | undefined
    ? E
    : never;

  it("answers the duplicate name before it validates the event, as the db read does", async () => {
    const owner = await agent("powner");
    const existing = await group(owner);

    await expect(
      memoryStore.createGroup(existing.name, "clash", "", owner.id, "foundation", [UNKNOWN])
    ).rejects.toThrow(/already exists/);
  });

  it("answers an empty settings edit before it validates the event, as the db return does", async () => {
    const owner = await agent("powner2");
    const g = await group(owner);

    await expect(memoryStore.updateGroupSettings(g.id, {}, [UNKNOWN])).resolves.toMatchObject({ id: g.id });
  });

  /** The other direction, so the reorder cannot become "validation was dropped". */
  it("still refuses a malformed event on the path that actually writes", async () => {
    const owner = await agent("powner3");
    const g = await group(owner);

    await expect(
      memoryStore.updateGroupSettings(g.id, { displayName: "Renamed" }, [UNKNOWN])
    ).rejects.toThrow(/unknown kind/);
    await expect(
      memoryStore.createGroup(nextName("fresh"), "Fresh", "", owner.id, "foundation", [UNKNOWN])
    ).rejects.toThrow(/unknown kind/);
    // Refused before anything was written, which is the half Decision 4 does pin.
    expect((await getGroup(g.id))!.displayName).toBe("U3c");
  });
});

/**
 * **The automatic `general` membership is a real producer** (codex round 4, finding 1).
 *
 * `ensureGeneralGroup` is not a fixture path: vetting completion, public-AI provisioning and the
 * agent loop all call it, so a fresh automatic membership is an ordinary `group_members` row with an
 * ordinary trail row. Calling the store's eventless form left that row with `source_event_id = NULL`
 * and emitted no `group.joined` — uncorrelatable in the soak, and gone entirely once the inline
 * writer is deleted. Worse, it can WIN the insert against a concurrent explicit join, which then
 * reports a duplicate and emits nothing, so the membership change has no event from either side.
 *
 * The action emits both kinds, each gated by the mutation that decides it: `group.created` only
 * when it creates `general`, `group.joined` only on a fresh membership.
 */
describe("ensureGeneralMembership", () => {
  it("emits group.created for the agent that creates it, with the store-filled subject", async () => {
    const founder = await agent("gfounder");
    const before = marker();

    expect(await ensureGeneralMembership({ agentId: founder.id })).toMatchObject({ ok: true });

    // **`group.created` alone**, and the absence of `group.joined` is correct rather than a gap: the
    // creation carries the founder's membership already (element 2 of the db batch, `memberIds` here),
    // so the ensure's join finds them a member and its gate is shut. `group.created` is the event
    // that covers the whole creation, membership included.
    const events = eventsSince(before);
    expect(events.map((event) => event.kind)).toEqual(["group.created"]);
    expect(events[0].actorAgentId).toBe(founder.id);
    // Store-assigned: the action cannot name an id `createGroup` derives.
    expect(events[0].subjectId).toBe("general");
    expect(events[0].subjectId).not.toBe(STORE_ASSIGNED_PAYLOAD_ID);
    expect(events[0].schoolId).toBe("foundation");
    expect(await memoryStore.isGroupMember(founder.id, "general")).toBe(true);
  });

  it("emits only group.joined for a later agent, and nothing at all for a repeat", async () => {
    const founder = await agent("gfounder2");
    await ensureGeneralMembership({ agentId: founder.id });
    const joiner = await agent("gjoiner");
    const before = marker();

    expect(await ensureGeneralMembership({ agentId: joiner.id })).toMatchObject({ ok: true });
    expect(kindsSince(before)).toEqual(["group.joined"]);

    // The duplicate: the group exists and the membership does, so both gates are shut.
    const afterJoin = marker();
    expect(await ensureGeneralMembership({ agentId: joiner.id })).toMatchObject({ ok: true });
    expect(eventsSince(afterJoin)).toEqual([]);
  });

  it("stamps the trail row from the event it emitted, like every other join", async () => {
    const founder = await agent("gfounder3");
    await ensureGeneralMembership({ agentId: founder.id });
    const joiner = await agent("gjoiner2");
    const before = marker();

    await ensureGeneralMembership({ agentId: joiner.id });

    const [event] = eventsSince(before);
    const key = activityEventKey("group_join", `${joiner.id}:general`);
    expect(activityEvents.get(key)).toBeDefined();
    expect(activityEvents.get(key)!.occurredAt).toBe(event.createdAt);
    expect(activityEventSourceIds.get(key)).toBe(event.id);
  });
});

/**
 * **A group that predates the sidecar** (codex round 3, finding 1).
 *
 * The sidecar is new state, and `groups` survives a hot reload — so in development an existing group
 * has membership but no snapshot entry, and a fixture that plants a group with `groups.set` is the
 * same shape. Seeding the snapshot from `memberIds` is right, but seeding it as an ALIAS was not: a
 * later join mutates `memberIds` in place, so the "snapshot" moved with it and the first subscribe
 * saw neither state change. Postgres never touches `member_ids` on a join, so it still emits.
 *
 * The snapshot must therefore be MATERIALIZED — copied — before anything mutates canonical
 * membership, which is what `materializeGroupSubscriptionSnapshot` does at every such site.
 */
describe("a group planted without a subscription snapshot", () => {
  /** A group as a hot reload (or a bare fixture) leaves it: membership, and no sidecar entry. */
  function plantGroup(ownerId: string, memberIds: string[]): string {
    const id = nextName("planted");
    groups.set(id, {
      id,
      name: id,
      displayName: "Planted",
      description: "",
      type: "group",
      ownerId,
      memberIds,
      moderatorIds: [],
      pinnedPostIds: [],
      createdAt: new Date().toISOString(),
    });
    return id;
  }

  it("emits group.subscribed for a first subscribe that follows a join", async () => {
    const owner = await agent("plowner");
    const member = await agent("plmember");
    const id = plantGroup(owner.id, [owner.id]);

    await joinGroup({ agent: member, groupName: id });
    const before = marker();

    expect(await subscribeToGroup({ agent: member, groupName: id })).toMatchObject({ ok: true });
    expect(kindsSince(before)).toEqual(["group.subscribed"]);
  });

  it("emits group.unsubscribed for a first unsubscribe that follows a leave", async () => {
    const owner = await agent("plowner2");
    const member = await agent("plmember2");
    // The pre-sidecar representation of "a member who is also in the legacy snapshot".
    const id = plantGroup(owner.id, [owner.id, "PLACEHOLDER"]);
    groups.set(id, { ...groups.get(id)!, memberIds: [owner.id, member.id] });

    await leaveGroup({ agent: member, groupName: id });
    const before = marker();

    expect(await unsubscribeFromGroup({ agent: member, groupName: id })).toMatchObject({ ok: true });
    expect(kindsSince(before)).toEqual(["group.unsubscribed"]);
  });

  it("emits group.unsubscribed after a WITHDRAWAL swept the same member", async () => {
    // The third canonical-only mutation, and the one that runs outside the groups module.
    const owner = await agent("plowner3");
    const member = await agent("plmember3");
    const id = plantGroup(owner.id, [owner.id, "PLACEHOLDER"]);
    groups.set(id, { ...groups.get(id)!, memberIds: [owner.id, member.id] });

    await deleteAgent(member.id);
    const before = marker();

    // The snapshot still names them, because `groups.member_ids` has no foreign key.
    await expect(memoryStore.unsubscribeFromGroup(member.id, id, [
      { kind: "group.unsubscribed", actorAgentId: member.id, subjectType: "group", payload: {} },
    ])).resolves.toBe(true);
    expect(kindsSince(before)).toEqual(["group.unsubscribed"]);
  });
});

/**
 * **A mixed-version group with a promoted founder** (codex round 4, finding 2).
 *
 * The houses removal left one compatibility rule alive: `rowToGroup` and `normalizeGroup` both read
 * a group's owner as `founder_id ?? owner_id`, because a house an undrained instance created after
 * the conversion is administered by its promoted founder while `owner_id` still names whoever
 * created it. Every authorization path has to use that effective owner, and every reference has to
 * count as a reference — the memory store did neither:
 *
 *  - `writeModerator` compared the RAW `ownerId`, so it refused the promoted founder the action had
 *    just authorized through `getGroup` — and accepted the departed creator it had just refused.
 *  - `assertAgentOwnsNoGroups` looked only at `ownerId`, so the promoted founder could withdraw
 *    while Postgres's `founder_id REFERENCES agents(id)` refuses that delete.
 */
describe("a group whose founder was promoted (mixed-version row)", () => {
  /** The shape an undrained instance leaves behind: a live `founderId` beside a stale `ownerId`. */
  function plantPromotedGroup(creatorId: string, founderId: string): string {
    const id = nextName("promoted");
    groups.set(id, {
      id,
      name: id,
      displayName: "Promoted",
      description: "",
      type: "group",
      ownerId: creatorId,
      memberIds: [founderId],
      moderatorIds: [],
      pinnedPostIds: [],
      createdAt: new Date().toISOString(),
      // Not on `StoredGroup`; the map holds objects an older build wrote, which is the whole case.
      founderId,
    } as never);
    return id;
  }

  it("lets the promoted founder add and remove a moderator, and refuses the departed creator", async () => {
    const creator = await agent("pcreator");
    const founder = await agent("pfounder");
    const target = await agent("ptarget");
    const id = plantPromotedGroup(creator.id, founder.id);
    // The read boundary already answers "the founder owns it" — this is the rule the writer broke.
    expect((await getGroup(id))!.ownerId).toBe(founder.id);
    const before = marker();

    expect(await addModerator({ agent: founder, groupName: id, targetName: target.name })).toMatchObject({
      ok: true,
    });
    expect(kindsSince(before)).toEqual(["group.moderator_added"]);
    expect((await getGroup(id))!.moderatorIds).toEqual([target.id]);

    expect(await addModerator({ agent: creator, groupName: id, targetName: target.name })).toMatchObject({
      ok: false,
      code: "forbidden",
    });

    const beforeRemove = marker();
    expect(
      await removeModerator({ agent: founder, groupName: id, targetName: target.name })
    ).toMatchObject({ ok: true });
    expect(kindsSince(beforeRemove)).toEqual(["group.moderator_removed"]);
  });

  it("refuses the withdrawal of the promoted founder AND of the creator the column still names", async () => {
    const creator = await agent("pcreator2");
    const founder = await agent("pfounder2");
    const id = plantPromotedGroup(creator.id, founder.id);

    // Both columns are foreign keys in Postgres until the contract script drops `founder_id`, so
    // either reference refuses the delete there.
    expect(await deleteAgent(founder.id)).toEqual({ ok: false, reason: "foreign_key" });
    expect(await deleteAgent(creator.id)).toEqual({ ok: false, reason: "foreign_key" });
    expect(agents.has(founder.id)).toBe(true);
    expect(agents.has(creator.id)).toBe(true);
    expect(await getGroup(id)).not.toBeNull();
  });

  it("reports the promoted founder as owner through getYourRole, never the departed creator", async () => {
    const creator = await agent("pcreator3");
    const founder = await agent("pfounder3");
    const id = plantPromotedGroup(creator.id, founder.id);

    // Founder-wins at the ROLE read too (codex round 5): the raw column would hand owner controls
    // to the departed creator while every mutation path refuses their writes.
    expect(await memoryStore.getYourRole(id, founder.id)).toBe("owner");
    expect(await memoryStore.getYourRole(id, creator.id)).toBeNull();
  });
});

/**
 * **The owner foreign key has no cascade, so Postgres refuses the withdrawal outright**
 * (codex round 3, finding 2). Skipping the owner's membership was only half the rule: the agent row
 * was still deleted, leaving `groups.owner_id` pointing at nobody — a state `DELETE FROM agents`
 * cannot produce, because it raises `23503`.
 */
describe("withdrawing a group's owner", () => {
  it("refuses, and leaves the agent, the group and every membership untouched", async () => {
    const owner = await agent("fkowner");
    const g = await group(owner);
    const member = await agent("fkmember");
    await joinGroup({ agent: member, groupName: g.name });

    expect(await deleteAgent(owner.id)).toEqual({ ok: false, reason: "foreign_key" });

    expect(agents.has(owner.id)).toBe(true);
    expect(await getGroup(g.id)).not.toBeNull();
    expect(await memoryStore.isGroupMember(owner.id, g.id)).toBe(true);
    // The sweep must not have run at all — a refused withdrawal changes nothing.
    expect(await memoryStore.isGroupMember(member.id, g.id)).toBe(true);
  });

  it("still withdraws an agent who owns nothing", async () => {
    const owner = await agent("fkowner2");
    const g = await group(owner);
    const member = await agent("fkmember2");
    await joinGroup({ agent: member, groupName: g.name });

    expect(await deleteAgent(member.id)).toEqual({ ok: true });
    expect(agents.has(member.id)).toBe(false);
    expect(await memoryStore.isGroupMember(member.id, g.id)).toBe(false);
  });
});

/**
 * **The snapshot is an independent map, so resetting groups must reset it too** (codex round 2,
 * finding 3). A group id reused after a bare `groups.clear()` would otherwise read a previous
 * fixture's subscribers — `isSubscribed` answering for somebody who never subscribed, and a real
 * subscription emitting nothing because the sidecar already names the agent.
 */
describe("resetGroupState", () => {
  it("clears both halves of membership, so a reused group id starts empty", async () => {
    const owner = await agent("rowner");
    const g = await group(owner);
    const reader = await agent("rreader");
    await subscribeToGroup({ agent: reader, groupName: g.name });
    expect(await memoryStore.isSubscribed(reader.id, g.id)).toBe(true);

    resetGroupState();
    // The same id, re-created by a later fixture exactly as a test file's `beforeEach` would.
    groups.set(g.id, { ...g, memberIds: [owner.id] });

    expect(await memoryStore.isSubscribed(reader.id, g.id)).toBe(false);
  });
});

/**
 * Memory mode must not block, and its projection must be visible on return.
 *
 * The dispatcher runs the consumers in process; the trail row a join writes has to exist when the
 * action resolves, exactly as it does against the inline writer today.
 */
describe("memory-mode delivery", () => {
  it("returns with the join's trail row already visible", async () => {
    const owner = await agent("downer");
    const g = await group(owner);
    const joiner = await agent("djoiner");

    await joinGroup({ agent: joiner, groupName: g.name });

    expect(trailRow(joiner.id, g.id)).toBeDefined();
  });
});
