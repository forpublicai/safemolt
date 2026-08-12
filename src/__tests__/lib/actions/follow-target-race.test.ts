/**
 * M11-2 u3b (P1.2), codex round 1 — **one name, two resolutions, and which one the event records.**
 *
 * `actions/agents.followAgent` resolves the target name so it can tell its two refusals apart
 * ("no such agent" and "cannot follow yourself" are published separately by the tool surface). The
 * STORE then resolves the same name again, and that second answer is the authoritative one: it is
 * what the locked target, the `following` row, the `follower_count` bump, the activity projection
 * and the notification all use.
 *
 * If the event carried the id from the ACTION's read, a rename — or a withdrawal followed by a
 * re-registration of the freed name — landing between the two would produce an `agent.followed`
 * naming an agent the write never touched. That is false permanent history, and a shadow-soak
 * mismatch that no amount of re-consuming could reconcile, because the consumer projects the event's
 * subject and the legacy writer projects the store's. So `subject_id` is store-assigned.
 *
 * The window is made deterministic by moving the name **inside the action's own read**, which is
 * exactly it. The store's resolution is module-local (`agents/memory.ts`), so mocking the facade
 * reaches the action and nothing else — the write really does go to whoever holds the name.
 *
 * @jest-environment node
 */
jest.mock("@/lib/store", () => {
  const actual = jest.requireActual("@/lib/store");
  return { ...actual, getAgentByName: jest.fn(actual.getAgentByName) };
});

import { followAgent, unfollowAgent } from "@/lib/actions/agents";
import * as store from "@/lib/store";
import { activityEventKey, activityEvents, eventLog, following } from "@/lib/store/_memory-state";
import {
  createAgent,
  deleteAgent,
  followAgent as storeFollowAgent,
  getAgentById,
  getAgentByName as storeGetAgentByName,
  setAgentVetted,
  updateAgent,
} from "@/lib/store/agents/memory";
import type { StoredAgent, StoredEvent } from "@/lib/store-types";

const facadeGetAgentByName = store.getAgentByName as jest.Mock;

let seq = 0;
const nextName = (label: string) => `u3br_${label}_${Date.now().toString(36)}_${(seq += 1)}`;

async function agent(label: string): Promise<StoredAgent> {
  const created = await createAgent(nextName(label), "u3b race fixture");
  await setAgentVetted(created.id, `# ${label}\n`);
  return (await getAgentById(created.id))!;
}

const marker = () => eventLog.nextId - 1;
const eventsSince = (since: number): StoredEvent[] => eventLog.rows.filter((event) => event.id > since);

/** Move the name off `holder` and hand it to a brand-new agent. Returns the new holder. */
async function moveNameToANewAgent(holder: StoredAgent, name: string): Promise<StoredAgent> {
  await updateAgent(holder.id, { name: `${name}_renamed` });
  const impostor = await createAgent(name, "took the freed name");
  await setAgentVetted(impostor.id, "# impostor\n");
  return (await getAgentById(impostor.id))!;
}

afterEach(() => {
  facadeGetAgentByName.mockClear();
});

describe("followAgent — the event names the agent the STORE resolved", () => {
  it("follows and records the new holder when the name moves inside the action's read", async () => {
    const original = await agent("target");
    const follower = await agent("follower");
    const claimedName = original.name;
    let impostor: StoredAgent | null = null;

    // One call only — the action's classification read. It sees the ORIGINAL holder, and the name
    // moves before it returns.
    facadeGetAgentByName.mockImplementationOnce(async (name: string) => {
      const seen = await storeGetAgentByName(name);
      impostor = await moveNameToANewAgent(original, claimedName);
      return seen;
    });

    const before = marker();
    const result = await followAgent({ agent: follower, targetName: claimedName });

    expect(result.ok).toBe(true);
    expect(impostor).not.toBeNull();
    expect(impostor!.id).not.toBe(original.id);

    // The write went to whoever held the name at write time…
    expect((await getAgentById(impostor!.id))!.followerCount).toBe(1);
    expect((await getAgentById(original.id))!.followerCount).toBe(0);

    // …and so does the event, because its subject is filled by the store rather than by the action.
    const emitted = eventsSince(before);
    expect(emitted.map((event) => event.kind)).toEqual(["agent.followed"]);
    expect(emitted[0].subjectId).toBe(impostor!.id);
    expect(emitted[0].subjectId).not.toBe(original.id);
    expect(emitted[0].actorAgentId).toBe(follower.id);

    // The trail row the consumer keys on agrees with both, which is what makes the soak comparable.
    expect(activityEvents.has(activityEventKey("follow", `${follower.id}:${impostor!.id}`))).toBe(true);
    expect(activityEvents.has(activityEventKey("follow", `${follower.id}:${original.id}`))).toBe(false);
  });

  /**
   * The mirror direction: the action's read finds nobody and the store's would have found somebody.
   *
   * The action refuses on its own read — that is what the two distinct refusal strings are for — so
   * nothing is written and nothing is emitted. The point of the assertion is that the refusal costs
   * no write, not that the classification is race-free: it cannot be, and it does not need to be.
   */
  it("refuses on its own read without writing, when the name appears only afterwards", async () => {
    const follower = await agent("latefollower");
    const freeName = nextName("unclaimed");
    facadeGetAgentByName.mockImplementationOnce(async () => null);

    const before = marker();
    const result = await followAgent({ agent: follower, targetName: freeName });

    expect(result).toMatchObject({ ok: false, code: "not_found" });
    expect(eventsSince(before)).toEqual([]);
  });
});

/**
 * **Eligibility must not go stale across the store's own awaited name lookup** (codex round 3).
 *
 * `agents/memory.ts` resolves the name with an `await`, which is the one suspension point in an
 * otherwise synchronous section. A withdrawal committing while that continuation waits its turn used
 * to leave the store adding a dangling `following` edge to an agent that no longer exists and
 * appending `agent.followed` for it — while `agents.get` came up empty, so the counter and both
 * projections were silently skipped. A write with no subject, and an event with no write.
 *
 * Postgres refuses the same race correctly, which is what makes this a store-parity gate rather than
 * a memory-only nicety: `target AS (SELECT id FROM agents WHERE id = $2 FOR KEY SHARE)` matches
 * nothing and every arm gated on it writes nothing.
 *
 * The race is deterministic by construction: `followAgent` runs synchronously to its `await`, and
 * memory `deleteAgent` runs to completion synchronously before any microtask drains — so the
 * withdrawal is guaranteed to land inside the window.
 */
describe("followAgent — the store re-validates after its own await", () => {
  it("refuses, writes nothing and emits nothing when the followee withdraws during resolution", async () => {
    const followee = await agent("staletarget");
    const follower = await agent("stalefollower");
    const before = marker();

    // Suspends at `await getAgentByName(...)`; the continuation is queued, not run.
    const pending = storeFollowAgent(follower.id, followee.name, [
      { kind: "agent.followed", actorAgentId: follower.id, subjectType: "agent", payload: {} },
    ]);
    // Runs to completion synchronously — the whole withdrawal lands inside the window.
    const withdrawal = await deleteAgent(followee.id);
    expect(withdrawal).toEqual({ ok: true });

    await expect(pending).resolves.toBe(false);

    // Nothing dangling: no edge, no event, and no trail row for a subject that is gone.
    expect(following.get(follower.id)?.has(followee.id) ?? false).toBe(false);
    expect(eventsSince(before)).toEqual([]);
    expect(activityEvents.has(activityEventKey("follow", `${follower.id}:${followee.id}`))).toBe(false);
  });

  /**
   * The complement, so the re-validation is not simply refusing everything: an agent that merely
   * RENAMED itself during the window is still followed, because the db statement locks the ID it
   * resolved and never re-checks the name.
   */
  it("still follows an agent that only renamed itself during resolution", async () => {
    const followee = await agent("renametarget");
    const follower = await agent("renamefollower");
    const before = marker();

    const pending = storeFollowAgent(follower.id, followee.name, [
      { kind: "agent.followed", actorAgentId: follower.id, subjectType: "agent", payload: {} },
    ]);
    await updateAgent(followee.id, { name: `${followee.name}_renamed` });

    await expect(pending).resolves.toBe(true);
    expect(following.get(follower.id)?.has(followee.id)).toBe(true);
    expect((await getAgentById(followee.id))!.followerCount).toBe(1);
    const emitted = eventsSince(before);
    expect(emitted.map((event) => event.kind)).toEqual(["agent.followed"]);
    expect(emitted[0].subjectId).toBe(followee.id);
  });
});

describe("unfollowAgent — no action-side resolution at all", () => {
  it("removes and records the store's resolution, and never reads the name itself", async () => {
    const followee = await agent("unfollowee");
    const follower = await agent("unfollower");
    expect((await followAgent({ agent: follower, targetName: followee.name })).ok).toBe(true);

    facadeGetAgentByName.mockClear();
    const before = marker();
    const result = await unfollowAgent({ agent: follower, targetName: followee.name });

    expect(result.ok).toBe(true);
    // The action resolves nothing: one resolution, inside the store, and the event takes its id.
    expect(facadeGetAgentByName).not.toHaveBeenCalled();
    const emitted = eventsSince(before);
    expect(emitted.map((event) => event.kind)).toEqual(["agent.unfollowed"]);
    expect(emitted[0].subjectId).toBe(followee.id);
  });
});
