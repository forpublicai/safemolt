/**
 * M11-2 u3c (P1.3) `[integration]` — groups and membership against a real Postgres.
 *
 * The memory-mode suites prove the shapes; only this one can prove the guarantees, because every
 * one of them is a property of a statement under contention:
 *
 *  - a **concurrent duplicate join** leaves exactly one membership row, one event and one trail
 *    row — the alignment that made the db side agree with the memory side, and with the consumer;
 *  - the **REAL route racing the REAL tool** for the same join admits one and reports the other as
 *    already a member, which the pre-P1.3 `isGroupMember` pre-check could not decide;
 *  - a join naming a group or an agent that is not there is a clean refusal rather than a `23503`
 *    leaking out of `group_members`' two foreign keys, and it emits nothing;
 *  - every no-op — a leave by a non-member, a repeat subscribe, an unauthorized settings edit, a
 *    moderator add that changes nothing — writes no tuple and emits no event;
 *  - the **shadow soak runs through the REAL drain** for `group.joined`, comparing keys AND
 *    canonical payloads with `occurred_at` equal on both sides, which is the obligation that kind
 *    discharged in order to enter `shadow`;
 *  - and karma is untouched throughout, because no group mutation has ever written it.
 *
 * **Concurrent join-vs-group-delete is N/A**: no group deletion path exists anywhere in the tree —
 * no `deleteGroup` in either store, no route, no tool. What can be proven, and is below, is the
 * half that would make such a path safe: the join's locked target turns a missing group into a
 * refusal instead of a foreign-key error.
 *
 * @jest-environment node
 */
import { POST as JOIN_ROUTE } from "@/app/api/v1/groups/[name]/join/route";
import {
  addModerator,
  createGroup,
  joinGroup,
  leaveGroup,
  removeModerator,
  subscribeToGroup,
  unsubscribeFromGroup,
  updateGroupSettings,
} from "@/lib/actions/groups";
import { executors as groupTools } from "@/lib/agent-tools/definitions/groups";
import { activityTrailEffects } from "@/lib/events/consumers/activity-trail";
import { eventConsumers } from "@/lib/events/consumers/registry";
import { getEventById } from "@/lib/store/events/db";
import { activateEventConsumer, drainEventConsumer } from "@/lib/store/events/drain-db";
import { joinGroupWithOutcome } from "@/lib/store/groups/db";
import type { StoredAgent, StoredEvent } from "@/lib/store-types";

import { withMiddlewareHeaders } from "../helpers/middleware-headers";
import { runConcurrently, rejections } from "./helpers/concurrency";
import { closeIntegrationConnections, pgPool } from "./helpers/db";

const RUN = `${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;
let seq = 0;
const nextId = (kind: string) => `u3c${kind}${RUN}${(seq += 1)}`;
let baselineEventId = 0;

const REAL_CONSUMERS = eventConsumers.map((consumer) => consumer.name);

async function seedAgent(): Promise<StoredAgent> {
  const id = nextId("agent");
  const apiKey = `u3ckey${id}`;
  await pgPool().query(
    `INSERT INTO agents (id, name, description, api_key, points, vote_points, evaluation_points,
                         legacy_unattributed_points, follower_count, is_claimed, created_at, is_vetted)
     VALUES ($1, $2, '', $3, 0, 0, 0, 0, 0, false, NOW(), true)`,
    [id, `${id}named`, apiKey]
  );
  return { id, name: `${id}named`, apiKey, isVetted: true } as StoredAgent;
}

/** A group through the ACTION, so `group.created` and the founder membership are both exercised. */
async function seedGroup(owner: StoredAgent): Promise<{ id: string; name: string }> {
  const name = nextId("group");
  const created = await createGroup({
    agent: owner,
    name,
    displayName: "U3c integration",
    description: "",
    schoolId: "foundation",
  });
  if (!created.ok) throw new Error(`fixture group refused: ${created.code}`);
  return { id: created.data.group.id, name: created.data.group.name };
}

async function maxEventId(): Promise<number> {
  const { rows } = await pgPool().query<{ max: string | null }>(`SELECT MAX(id)::text AS max FROM events`);
  return Number(rows[0].max ?? 0);
}

async function eventsSince(marker: number): Promise<StoredEvent[]> {
  const { rows } = await pgPool().query<{ id: string }>(
    `SELECT id FROM events WHERE id > $1 ORDER BY id`,
    [marker]
  );
  const out: StoredEvent[] = [];
  for (const row of rows) out.push((await getEventById(Number(row.id)))!);
  return out;
}

async function memberCount(agentId: string, groupId: string): Promise<number> {
  const { rows } = await pgPool().query<{ c: string }>(
    `SELECT COUNT(*)::text AS c FROM group_members WHERE agent_id = $1 AND group_id = $2`,
    [agentId, groupId]
  );
  return Number(rows[0].c);
}

/** The LEGACY snapshot half of membership — `groups.member_ids`, which only subscription writes. */
async function snapshotHas(groupId: string, agentId: string): Promise<boolean> {
  const { rows } = await pgPool().query<{ present: boolean }>(
    `SELECT COALESCE(member_ids, '[]'::jsonb) @> to_jsonb($2::text) AS present FROM groups WHERE id = $1`,
    [groupId, agentId]
  );
  return rows[0]?.present === true;
}

/** The trail row, minus the watermark: `source_event_id` is ordering metadata, not content. */
async function readActivity(entityId: string): Promise<Record<string, unknown> | null> {
  const { rows } = await pgPool().query(
    `SELECT kind, occurred_at, actor_id, actor_name, actor_canonical_name, entity_id, title, href,
            summary, context_hint, search_text, metadata
     FROM activity_events WHERE kind = 'group_join' AND entity_id = $1`,
    [entityId]
  );
  const row = rows[0] as Record<string, unknown> | undefined;
  if (!row) return null;
  return {
    ...row,
    occurred_at: row.occurred_at instanceof Date ? row.occurred_at.toISOString() : row.occurred_at,
  };
}

async function sourceEventId(entityId: string): Promise<number | null> {
  const { rows } = await pgPool().query<{ source_event_id: string | null }>(
    `SELECT source_event_id::text FROM activity_events WHERE kind = 'group_join' AND entity_id = $1`,
    [entityId]
  );
  return rows[0]?.source_event_id == null ? null : Number(rows[0].source_event_id);
}

function joinRequest(caller: StoredAgent, groupName: string): Request {
  return new Request(
    `https://safemolt.com/api/v1/groups/${groupName}/join`,
    withMiddlewareHeaders({
      method: "POST",
      headers: { Authorization: `Bearer ${caller.apiKey}` },
    })
  );
}

beforeAll(async () => {
  baselineEventId = await maxEventId();
});

afterAll(async () => {
  const like = `u3c%${RUN}%`;
  await pgPool().query(`DELETE FROM event_receipts WHERE consumer = ANY($1::text[])`, [REAL_CONSUMERS]);
  await pgPool().query(`DELETE FROM event_consumer_failures WHERE consumer = ANY($1::text[])`, [REAL_CONSUMERS]);
  await pgPool().query(`DELETE FROM event_dead_letters WHERE consumer = ANY($1::text[])`, [REAL_CONSUMERS]);
  await pgPool().query(`DELETE FROM event_consumers WHERE consumer = ANY($1::text[])`, [REAL_CONSUMERS]);
  await pgPool().query(`DELETE FROM event_consumer_shadow WHERE event_id > $1`, [baselineEventId]);
  await pgPool().query(`DELETE FROM events WHERE id > $1`, [baselineEventId]);
  await pgPool().query(`DELETE FROM activity_contexts WHERE activity_id LIKE $1`, [like]);
  await pgPool().query(`DELETE FROM activity_events WHERE actor_id LIKE $1 OR entity_id LIKE $1`, [like]);
  await pgPool().query(`DELETE FROM group_members WHERE agent_id LIKE $1 OR group_id LIKE $1`, [like]);
  await pgPool().query(`DELETE FROM groups WHERE id LIKE $1`, [like]);
  await pgPool().query(`DELETE FROM agents WHERE id LIKE $1`, [like]);
  await closeIntegrationConnections();
});

describe("joinGroup — the gated insert, the alignment and the clock", () => {
  it("writes the membership, emits one event, and stamps the trail row from it", async () => {
    const owner = await seedAgent();
    const group = await seedGroup(owner);
    const joiner = await seedAgent();
    const marker = await maxEventId();

    const result = await joinGroup({ agent: joiner, groupName: group.name });
    expect(result).toMatchObject({ ok: true, data: { alreadyMember: false } });

    const events = await eventsSince(marker);
    expect(events.map((event) => event.kind)).toEqual(["group.joined"]);
    expect([events[0].actorAgentId, events[0].subjectId, events[0].subjectType]).toEqual([
      joiner.id,
      group.id,
      "group",
    ]);
    expect(await memberCount(joiner.id, group.id)).toBe(1);

    // **The clock, and the correlation.** Both are what let this kind enter `shadow`: the inline
    // writer takes the event's own `created_at` (a membership row's `joined_at` exists here but not
    // in the memory store, so the event is the one instant both can project), and it stamps
    // `source_event_id` so the dual-write phase is ordered by which event is newer.
    const entityId = `${joiner.id}:${group.id}`;
    expect((await readActivity(entityId))!.occurred_at).toBe(events[0].createdAt);
    expect(await sourceEventId(entityId)).toBe(events[0].id);
  });

  /**
   * **The recorded behavior change, under contention.**
   *
   * The pre-u3c path defaulted the driver's insert count to `1` and refreshed the trail on every
   * re-join — "emit anyway" — while the memory store emitted only on a fresh membership and the
   * consumer's effect is keyed to the decisive insert. Every duplicate would have logged a false
   * payload mismatch in the shadow soak. A duplicate now writes nothing, emits nothing, and leaves
   * the trail's `occurred_at` — the ordering key a soak diffs — exactly where it was.
   */
  it("leaves a duplicate join with no row, no event and an untouched trail", async () => {
    const owner = await seedAgent();
    const group = await seedGroup(owner);
    const joiner = await seedAgent();
    await joinGroup({ agent: joiner, groupName: group.name });
    const entityId = `${joiner.id}:${group.id}`;
    const first = await readActivity(entityId);
    const firstSource = await sourceEventId(entityId);
    const marker = await maxEventId();

    const again = await joinGroup({ agent: joiner, groupName: group.name });

    expect(again).toMatchObject({ ok: true, data: { alreadyMember: true } });
    expect(await eventsSince(marker)).toEqual([]);
    expect(await memberCount(joiner.id, group.id)).toBe(1);
    expect(await readActivity(entityId)).toEqual(first);
    expect(await sourceEventId(entityId)).toBe(firstSource);
  });

  it("admits exactly one of a concurrent duplicate join, with one event and one trail row", async () => {
    const owner = await seedAgent();
    const group = await seedGroup(owner);
    const joiner = await seedAgent();
    const marker = await maxEventId();

    const outcomes = await runConcurrently(
      Array.from({ length: 4 }, () => () => joinGroup({ agent: joiner, groupName: group.name }))
    );

    expect(rejections(outcomes)).toEqual([]);
    const admitted = outcomes.filter(
      (outcome) => outcome.ok && outcome.value.ok && outcome.value.data.alreadyMember === false
    );
    expect(admitted).toHaveLength(1);
    expect(await memberCount(joiner.id, group.id)).toBe(1);
    const events = await eventsSince(marker);
    expect(events.map((event) => event.kind)).toEqual(["group.joined"]);
    expect(await sourceEventId(`${joiner.id}:${group.id}`)).toBe(events[0].id);
  });

  /**
   * The REAL route racing the REAL tool.
   *
   * This is the pair the pre-P1.3 code could not decide: the route asked `isGroupMember` and
   * answered from that read, so two requests could both see "not a member" and both report a fresh
   * join. Now both go through the same insert, and its `ON CONFLICT` is what answers.
   */
  it("gives one join and one already-a-member when the route races the tool", async () => {
    const owner = await seedAgent();
    const group = await seedGroup(owner);
    const joiner = await seedAgent();
    const marker = await maxEventId();

    const outcomes = await runConcurrently<Record<string, unknown>>([
      () =>
        JOIN_ROUTE(joinRequest(joiner, group.name) as never, {
          params: Promise.resolve({ name: group.name }),
        }).then((response) => response.json() as Promise<Record<string, unknown>>),
      () =>
        groupTools
          .join_group({ group_name: group.name }, { agent: joiner } as never)
          .then((result) => ({ ...result }) as Record<string, unknown>),
    ]);

    expect(rejections(outcomes)).toEqual([]);
    expect(await memberCount(joiner.id, group.id)).toBe(1);
    const events = await eventsSince(marker);
    expect(events.map((event) => event.kind)).toEqual(["group.joined"]);
    // Both surfaces still answer success — the tool cannot tell a duplicate apart by design, and
    // the route's two messages are its own contract.
    const routeBody = (outcomes[0] as { value: Record<string, unknown> }).value;
    expect(routeBody.success).toBe(true);
    expect(["Successfully joined group", "Already a member of this group"]).toContain(routeBody.message);
  });

  /**
   * `group_members` carries a foreign key to `groups` AND to `agents`, both `ON DELETE CASCADE`.
   * A bare insert against a missing parent raises `23503`; the locked-target `INSERT … SELECT`
   * yields zero rows, which is what turns the error into the refusal the surfaces publish.
   */
  it("refuses a missing group and a missing agent cleanly, with no 23503 and no event", async () => {
    const marker = await maxEventId();
    const owner = await seedAgent();
    const group = await seedGroup(owner);

    await expect(joinGroupWithOutcome("u3c_no_such_agent", group.id)).resolves.toEqual({
      success: false,
      error: "Agent not found",
      alreadyMember: false,
    });
    await expect(joinGroupWithOutcome(owner.id, "u3c_no_such_group")).resolves.toEqual({
      success: false,
      error: "Group not found",
      alreadyMember: false,
    });
    // Only the fixture group's own creation event.
    expect((await eventsSince(marker)).map((event) => event.kind)).toEqual(["group.created"]);
  });
});

describe("every other group mutation: one event per real change, none otherwise", () => {
  it("emits group.left once and nothing for a non-member", async () => {
    const owner = await seedAgent();
    const group = await seedGroup(owner);
    const member = await seedAgent();
    await joinGroup({ agent: member, groupName: group.name });
    const marker = await maxEventId();

    expect(await leaveGroup({ agent: member, groupName: group.name })).toMatchObject({ ok: true });
    expect((await eventsSince(marker)).map((event) => event.kind)).toEqual(["group.left"]);
    expect(await memberCount(member.id, group.id)).toBe(0);

    const afterLeave = await maxEventId();
    expect(await leaveGroup({ agent: member, groupName: group.name })).toMatchObject({
      ok: false,
      code: "not_group_member",
    });
    expect(await eventsSince(afterLeave)).toEqual([]);
  });

  /**
   * Subscribe's event gates on the UNION of its two writes, and this is the case that needs it: an
   * agent who has already JOINED still writes the legacy `member_ids` snapshot, because `joinGroup`
   * writes only `group_members`. Gating on the canonical insert alone would leave that write with
   * no event at all.
   */
  it("emits group.subscribed for a member's first subscribe, then nothing", async () => {
    const owner = await seedAgent();
    const group = await seedGroup(owner);
    const member = await seedAgent();
    await joinGroup({ agent: member, groupName: group.name });
    const marker = await maxEventId();

    expect(await subscribeToGroup({ agent: member, groupName: group.name })).toMatchObject({ ok: true });
    expect((await eventsSince(marker)).map((event) => event.kind)).toEqual(["group.subscribed"]);
    const { rows } = await pgPool().query<{ member_ids: string[] }>(
      `SELECT member_ids FROM groups WHERE id = $1`,
      [group.id]
    );
    expect(rows[0].member_ids).toContain(member.id);

    const afterSubscribe = await maxEventId();
    await subscribeToGroup({ agent: member, groupName: group.name });
    expect(await eventsSince(afterSubscribe)).toEqual([]);

    const beforeRemove = await maxEventId();
    await unsubscribeFromGroup({ agent: member, groupName: group.name });
    expect((await eventsSince(beforeRemove)).map((event) => event.kind)).toEqual(["group.unsubscribed"]);
    const afterRemove = await maxEventId();
    await unsubscribeFromGroup({ agent: member, groupName: group.name });
    expect(await eventsSince(afterRemove)).toEqual([]);
  });

  /**
   * **The mirror image of the union gate, against real Postgres** (codex round 6). A subscriber who
   * LEAVES sheds only canonical membership — `leaveGroup` never touches the snapshot — so the later
   * unsubscribe still has the snapshot half to remove and must emit for it. This is the sequence the
   * memory sidecar exists to reproduce, pinned here on the db side so the two cannot diverge again.
   */
  it("emits group.unsubscribed for subscribe→leave→unsubscribe, removing the snapshot leftover", async () => {
    const owner = await seedAgent();
    const group = await seedGroup(owner);
    const reader = await seedAgent();
    await subscribeToGroup({ agent: reader, groupName: group.name });
    await leaveGroup({ agent: reader, groupName: group.name });
    expect(await memberCount(reader.id, group.id)).toBe(0);
    expect(await snapshotHas(group.id, reader.id)).toBe(true);
    const marker = await maxEventId();

    expect(await unsubscribeFromGroup({ agent: reader, groupName: group.name })).toMatchObject({ ok: true });
    expect((await eventsSince(marker)).map((event) => event.kind)).toEqual(["group.unsubscribed"]);
    expect(await snapshotHas(group.id, reader.id)).toBe(false);
  });

  /**
   * **The actor-withdrawal split, against real Postgres** (codex round 6; the memory twins assert
   * the same pair). A withdrawn actor's SUBSCRIBE writes nothing — `group_members.agent_id` is a
   * real foreign key, and the statement's actor CTE gates both arms rather than letting the insert
   * raise 23503. Their UNSUBSCRIBE proceeds — its delete needs no actor row and the snapshot is
   * JSONB with no key to refuse on, so the leftover their withdrawal could not cascade away is
   * still removable.
   */
  it("refuses a withdrawn actor's subscribe but lets their unsubscribe clean the snapshot", async () => {
    const owner = await seedAgent();
    const group = await seedGroup(owner);
    const ghost = await seedAgent();
    await subscribeToGroup({ agent: ghost, groupName: group.name });
    // Withdrawal mid-flight: the caller resolved its agent, then the row went away. The cascade
    // takes `group_members`; the snapshot has no FK and survives.
    await pgPool().query(`DELETE FROM agents WHERE id = $1`, [ghost.id]);
    expect(await memberCount(ghost.id, group.id)).toBe(0);
    expect(await snapshotHas(group.id, ghost.id)).toBe(true);

    const beforeUnsub = await maxEventId();
    expect(await unsubscribeFromGroup({ agent: ghost, groupName: group.name })).toMatchObject({ ok: true });
    expect((await eventsSince(beforeUnsub)).map((event) => event.kind)).toEqual(["group.unsubscribed"]);
    expect(await snapshotHas(group.id, ghost.id)).toBe(false);

    const beforeResub = await maxEventId();
    await subscribeToGroup({ agent: ghost, groupName: group.name });
    expect(await eventsSince(beforeResub)).toEqual([]);
    expect(await memberCount(ghost.id, group.id)).toBe(0);
    expect(await snapshotHas(group.id, ghost.id)).toBe(false);
  });

  /**
   * **The subscription union under contention** (codex round 1, finding 2).
   *
   * `legacy` and `canonical` are sibling data-modifying CTEs, and PostgreSQL leaves their execution
   * order unspecified. The group row is therefore taken `FOR NO KEY UPDATE` — self-conflicting — and
   * BOTH arms select from that locked target, so a second caller waits there and then finds both
   * arms applied. Without the arbiter two callers could enter the arms in opposite orders and take
   * the same two row locks the other way round.
   *
   * What is asserted is what the arbiter guarantees: no `40P01`, exactly one event for one logical
   * subscription, and a state in which the two halves AGREE.
   */
  it("admits exactly one of a concurrent duplicate subscribe, with one event", async () => {
    const owner = await seedAgent();
    const group = await seedGroup(owner);
    const reader = await seedAgent();
    const marker = await maxEventId();

    const outcomes = await runConcurrently(
      Array.from({ length: 4 }, () => () => subscribeToGroup({ agent: reader, groupName: group.name }))
    );

    expect(rejections(outcomes)).toEqual([]);
    expect((await eventsSince(marker)).map((event) => event.kind)).toEqual(["group.subscribed"]);
    expect(await memberCount(reader.id, group.id)).toBe(1);
    expect(await snapshotHas(group.id, reader.id)).toBe(true);
  });

  it("leaves the two membership halves agreeing when subscribe races unsubscribe", async () => {
    const owner = await seedAgent();
    const group = await seedGroup(owner);
    const reader = await seedAgent();

    // Repeated, because the interleaving the arbiter rules out is narrow: each round starts from a
    // different half-state, so both orders get a turn.
    for (let round = 0; round < 6; round += 1) {
      const outcomes = await runConcurrently([
        () => subscribeToGroup({ agent: reader, groupName: group.name }),
        () => unsubscribeFromGroup({ agent: reader, groupName: group.name }),
      ]);
      // A `40P01` here is the lock-order defect itself, not a race the driver retries.
      expect(rejections(outcomes)).toEqual([]);
      // The snapshot and the canonical row describe ONE subscription state, never half of each.
      expect(await snapshotHas(group.id, reader.id)).toBe((await memberCount(reader.id, group.id)) === 1);
    }
  });

  it("emits group.settings_updated for the owner's edit, and nothing for a stranger or an empty edit", async () => {
    const owner = await seedAgent();
    const group = await seedGroup(owner);
    const intruder = await seedAgent();
    const marker = await maxEventId();

    expect(
      await updateGroupSettings({ agent: owner, groupName: group.name, updates: { description: "written" } })
    ).toMatchObject({ ok: true });
    const events = await eventsSince(marker);
    expect(events.map((event) => event.kind)).toEqual(["group.settings_updated"]);
    expect(events[0].payload).toEqual({ fields: ["description"] });

    const afterEdit = await maxEventId();
    expect(
      await updateGroupSettings({ agent: intruder, groupName: group.name, updates: { description: "taken" } })
    ).toMatchObject({ ok: false, code: "forbidden" });
    expect(await updateGroupSettings({ agent: owner, groupName: group.name, updates: {} })).toMatchObject({
      ok: true,
    });
    expect(await eventsSince(afterEdit)).toEqual([]);

    const { rows } = await pgPool().query<{ description: string }>(
      `SELECT description FROM groups WHERE id = $1`,
      [group.id]
    );
    expect(rows[0].description).toBe("written");
  });

  /**
   * An explicitly `undefined` field is ABSENT, against real Postgres (codex round 3, finding 3).
   *
   * `COALESCE(NULL, display_name)` preserves the column, so an event naming `displayName` would
   * describe a write that did not happen — and the memory store's object spread would have replaced
   * the field with `undefined`, making the two stores disagree about the row as well as the event.
   */
  it("keeps a column an explicitly undefined field names, and leaves it out of the payload", async () => {
    const owner = await seedAgent();
    const group = await seedGroup(owner);
    await updateGroupSettings({ agent: owner, groupName: group.name, updates: { displayName: "Named" } });
    const marker = await maxEventId();

    expect(
      await updateGroupSettings({
        agent: owner,
        groupName: group.name,
        updates: { description: "written", displayName: undefined },
      })
    ).toMatchObject({ ok: true });

    const events = await eventsSince(marker);
    expect(events.map((event) => event.kind)).toEqual(["group.settings_updated"]);
    expect(events[0].payload).toEqual({ fields: ["description"] });
    const { rows } = await pgPool().query<{ display_name: string; description: string }>(
      `SELECT display_name, description FROM groups WHERE id = $1`,
      [group.id]
    );
    expect(rows[0]).toEqual({ display_name: "Named", description: "written" });

    // And an update whose every field is undefined writes nothing and emits nothing.
    const afterEdit = await maxEventId();
    expect(
      await updateGroupSettings({ agent: owner, groupName: group.name, updates: { displayName: undefined } })
    ).toMatchObject({ ok: true });
    expect(await eventsSince(afterEdit)).toEqual([]);
  });

  it("emits the moderator pair once each, with the target as secondary subject", async () => {
    const owner = await seedAgent();
    const group = await seedGroup(owner);
    const target = await seedAgent();
    const marker = await maxEventId();

    expect(
      await addModerator({ agent: owner, groupName: group.name, targetName: target.name })
    ).toMatchObject({ ok: true });
    const added = await eventsSince(marker);
    expect(added.map((event) => event.kind)).toEqual(["group.moderator_added"]);
    expect([added[0].subjectId, added[0].secondarySubjectId]).toEqual([group.id, target.id]);

    // A repeat add changes no row, so it emits nothing.
    const afterAdd = await maxEventId();
    expect(
      await addModerator({ agent: owner, groupName: group.name, targetName: target.name })
    ).toMatchObject({ ok: true });
    expect(await eventsSince(afterAdd)).toEqual([]);

    const beforeRemove = await maxEventId();
    expect(
      await removeModerator({ agent: owner, groupName: group.name, targetName: target.name })
    ).toMatchObject({ ok: true });
    const removed = await eventsSince(beforeRemove);
    expect(removed.map((event) => event.kind)).toEqual(["group.moderator_removed"]);
    expect([removed[0].subjectId, removed[0].secondarySubjectId]).toEqual([group.id, target.id]);

    const afterRemove = await maxEventId();
    expect(
      await removeModerator({ agent: owner, groupName: group.name, targetName: target.name })
    ).toMatchObject({ ok: true });
    expect(await eventsSince(afterRemove)).toEqual([]);

    const { rows } = await pgPool().query<{ moderator_ids: string[] }>(
      `SELECT moderator_ids FROM groups WHERE id = $1`,
      [group.id]
    );
    expect(rows[0].moderator_ids).toEqual([]);
  });

  /**
   * No group mutation has ever written karma, and the event arm must not change that — the
   * component invariant M11-1C pins is `points = legacy + vote + evaluation`, and a group flow that
   * moved any of them would be a fourth writer the ownership scan does not know about.
   */
  it("moves no karma at all", async () => {
    const owner = await seedAgent();
    const group = await seedGroup(owner);
    const member = await seedAgent();

    await joinGroup({ agent: member, groupName: group.name });
    await subscribeToGroup({ agent: member, groupName: group.name });
    await addModerator({ agent: owner, groupName: group.name, targetName: member.name });
    await updateGroupSettings({ agent: owner, groupName: group.name, updates: { emoji: "🦉" } });
    await leaveGroup({ agent: member, groupName: group.name });

    const { rows } = await pgPool().query(
      `SELECT points, vote_points, evaluation_points, legacy_unattributed_points
       FROM agents WHERE id = ANY($1::text[]) ORDER BY id`,
      [[owner.id, member.id]]
    );
    for (const row of rows) {
      expect([
        Number(row.points),
        Number(row.vote_points),
        Number(row.evaluation_points),
        Number(row.legacy_unattributed_points),
      ]).toEqual([0, 0, 0, 0]);
    }
  });
});

describe("shadow parity through the real drain", () => {
  async function shadowRows(
    eventId: number
  ): Promise<Array<{ consumer: string; effect_key: string; payload: Record<string, unknown> }>> {
    const { rows } = await pgPool().query(
      `SELECT consumer, effect_key, payload FROM event_consumer_shadow WHERE event_id = $1
       ORDER BY consumer, effect_key`,
      [eventId]
    );
    return rows as Array<{ consumer: string; effect_key: string; payload: Record<string, unknown> }>;
  }

  async function receipted(eventId: number): Promise<string[]> {
    const { rows } = await pgPool().query<{ consumer: string }>(
      `SELECT consumer FROM event_receipts WHERE event_id = $1 ORDER BY consumer`,
      [eventId]
    );
    return rows.map((row) => row.consumer);
  }

  async function drainAll(): Promise<void> {
    for (const consumer of eventConsumers) await drainEventConsumer(consumer, { batchSize: 200 });
  }

  /** Drop the paths a shadow row legitimately may not match — the consumer's own declaration. */
  function strip(row: Record<string, unknown>): Record<string, unknown> {
    const copy = { ...row };
    for (const path of activityTrailEffects.volatileShadowFields?.["group.joined"] ?? []) delete copy[path];
    return copy;
  }

  beforeAll(async () => {
    for (const consumer of eventConsumers) await activateEventConsumer(consumer.name);
  });

  it("records a group.joined shadow row matching the legacy projection, occurred_at included", async () => {
    const owner = await seedAgent();
    const group = await seedGroup(owner);
    const joiner = await seedAgent();
    const marker = await maxEventId();

    await joinGroup({ agent: joiner, groupName: group.name });
    const [event] = (await eventsSince(marker)).filter((row) => row.kind === "group.joined");
    const entityId = `${joiner.id}:${group.id}`;
    const legacy = await readActivity(entityId);
    expect(legacy).not.toBeNull();

    await drainAll();

    // Every consumer receipted it — `shadow` and `none` both receipt, which is what keeps the scan
    // floor moving.
    expect(await receipted(event.id)).toEqual([...REAL_CONSUMERS].sort());
    const shadow = await shadowRows(event.id);
    // Only the activity trail has an effect for this kind; the other two are `none`.
    expect(shadow.map((row) => row.consumer)).toEqual(["activity-trail"]);
    expect(shadow[0].effect_key).toBe(`group_join:${entityId}`);
    // The shadow payload IS the canonical projection, so it equals the legacy row field for field
    // once the consumer's own declared volatile paths are set aside on both sides.
    expect(shadow[0].payload).toEqual(strip(legacy!));
    // **`occurred_at` is NOT one of them**, and it is asserted outright: it is the trail's ordering
    // key, and sharing it is the obligation this kind discharged in order to enter `shadow`.
    expect(shadow[0].payload.occurred_at).toBe(event.createdAt);
    expect(shadow[0].payload.occurred_at).toBe(legacy!.occurred_at);
    // The structural fields a soak exists to compare are all still in the shadow row.
    expect(shadow[0].payload).toMatchObject({
      kind: "group_join",
      entity_id: entityId,
      actor_id: joiner.id,
      href: `/g/${group.name}`,
      metadata: { group_id: group.id, group_name: group.name },
    });
  });

  /**
   * The consumer's own write, against the legacy row it will replace.
   *
   * `apply` re-fetches the group and the actor at ITS write time, so a rename in between moves the
   * volatile presentation fields and nothing else. Stripped, the two writers agree — which is what
   * the dual-write phase needs.
   */
  it("applies the same projection the inline writer wrote, and survives a rename", async () => {
    const owner = await seedAgent();
    const group = await seedGroup(owner);
    const joiner = await seedAgent();
    const marker = await maxEventId();

    await joinGroup({ agent: joiner, groupName: group.name });
    const [event] = (await eventsSince(marker)).filter((row) => row.kind === "group.joined");
    const entityId = `${joiner.id}:${group.id}`;
    const legacy = (await readActivity(entityId))!;

    await pgPool().query(`DELETE FROM activity_events WHERE kind = 'group_join' AND entity_id = $1`, [
      entityId,
    ]);
    const described = (await activityTrailEffects.describe(event))[0];
    await activityTrailEffects.apply(event);
    const applied = (await readActivity(entityId))!;

    expect(applied.occurred_at).toBe(event.createdAt);
    expect(applied).toEqual(legacy);
    expect(described.payload).toEqual(applied);

    // The ACTOR renames between the two writes. `href` and `metadata` are group-built, so they must
    // still match exactly — a group's canonical name has no rename path at all.
    await pgPool().query(`DELETE FROM activity_events WHERE kind = 'group_join' AND entity_id = $1`, [
      entityId,
    ]);
    await pgPool().query(`UPDATE agents SET name = $2 WHERE id = $1`, [joiner.id, `${joiner.name}renamed`]);
    await activityTrailEffects.apply(event);
    const renamed = (await readActivity(entityId))!;

    expect(renamed).not.toEqual(legacy);
    expect(strip(renamed)).toEqual(strip(legacy));
    expect([renamed.href, renamed.metadata]).toEqual([legacy.href, legacy.metadata]);
  });

  /** The subject is gone: describe nothing, apply nothing, receipt anyway. */
  it("skips the effect when the group no longer exists", async () => {
    const owner = await seedAgent();
    const group = await seedGroup(owner);
    const joiner = await seedAgent();
    const marker = await maxEventId();

    await joinGroup({ agent: joiner, groupName: group.name });
    const [event] = (await eventsSince(marker)).filter((row) => row.kind === "group.joined");
    const entityId = `${joiner.id}:${group.id}`;

    await pgPool().query(`DELETE FROM activity_events WHERE kind = 'group_join' AND entity_id = $1`, [
      entityId,
    ]);
    // No deletion path exists in the application; this is the raw removal such a path would perform.
    await pgPool().query(`DELETE FROM groups WHERE id = $1`, [group.id]);

    expect(await activityTrailEffects.describe(event)).toEqual([]);
    await activityTrailEffects.apply(event);
    expect(await readActivity(entityId)).toBeNull();
  });
});
