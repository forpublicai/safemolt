/**
 * M11-2 P3.3 (train a4) — the wakeup runner's claim, lease-renewal, completion and housekeeping
 * writers: the memory-mode twins, which is what this repo's default Jest run exercises (no DB
 * configured — M11-1 C0).
 *
 * `claimNextWakeup`'s memory twin has no `FOR UPDATE SKIP LOCKED` to fall back on; its correctness
 * rests entirely on "one synchronous section, no `await` between the check and the write" — see that
 * function's own doc comment in `src/lib/store/wakeups/memory.ts`. These tests exercise the single-
 * call mechanics (one claim per call, budget spend gating, token fencing); the full two-runner
 * concurrent race is a later engineer's job on top of this primitive.
 *
 * @jest-environment node
 */
import { setLoopEnabled } from "@/lib/agent-loop";
import {
  agentLoopState,
  pulseBudgetCounters,
  resetAgentLoopState,
  resetPulseBudgetCounters,
  resetWakeupState,
  wakeupQueue,
} from "@/lib/store/_memory-state";
import type { StoredWakeup } from "@/lib/store/wakeups/db";
import {
  abandonExpiredWakeupLeases,
  claimNextWakeup,
  completeWakeup,
  enqueueWakeup,
  listWakeupsForAgent,
  pruneTerminalWakeups,
  renewWakeupLease,
  terminalizeDisabledAgentWakeups,
} from "@/lib/store/wakeups/memory";

let seq = 0;
/** Every fixture id gets a fresh suffix — the memory-mode maps are `globalThis`-backed and outlive
 * one test file within a Jest worker, so a bare literal id risks colliding with another suite. */
const nextId = (label: string) => `p33_${label}_${Date.now().toString(36)}_${(seq += 1)}`;

/** `enqueueWakeup`'s input, defaulted for an INTERNAL wakeup — memory mode's `resolveWakeupDelivery`
 * always answers `"internal"`, so tests set delivery directly rather than resolving it. */
function internalInput(agentId: string, reason: string, eventId: number | null) {
  return {
    agentId,
    reason,
    eventId,
    payload: { source: "p3.3-test" },
    delivery: "internal" as const,
  };
}

const CAPS = { leaseMs: 60_000, generalCap: 10, playgroundCap: 10 };

const todayUtc = () => new Date().toISOString().slice(0, 10);

/** Claim the sole due wakeup for `agentId` (must already be loop-enabled with one pending row). */
async function claimFor(agentId: string, claimToken: string): Promise<StoredWakeup> {
  const result = await claimNextWakeup({ claimToken, ...CAPS });
  if (result.candidates !== 1 || result.claimed === null) {
    throw new Error(`[fixture] expected a successful claim for ${agentId}, got ${JSON.stringify(result)}`);
  }
  return result.claimed;
}

beforeEach(() => {
  resetWakeupState();
  resetAgentLoopState();
  resetPulseBudgetCounters();
});

describe("claimNextWakeup", () => {
  it("claims nothing for an agent with no agent_loop_state row — a missing row is never claimable", async () => {
    const agent = nextId("agent");
    await enqueueWakeup(internalInput(agent, "idle", null));

    expect(await claimNextWakeup({ claimToken: "t1", ...CAPS })).toEqual({ candidates: 0 });
    expect((await listWakeupsForAgent(agent))[0].claimedAt).toBeNull();
  });

  it("claims a due internal wakeup once the agent is loop-enabled", async () => {
    const agent = nextId("agent");
    await setLoopEnabled(agent, true);
    const enq = await enqueueWakeup(internalInput(agent, "idle", null));

    const result = await claimNextWakeup({ claimToken: "tok-1", ...CAPS });
    if (result.candidates !== 1) throw new Error("[assertion] expected a candidate");

    expect(result.claimed).not.toBeNull();
    expect(result.claimed).toMatchObject({
      id: enq.wakeup!.id,
      agentId: agent,
      claimToken: "tok-1",
    });
    expect(result.claimed!.claimedAt).not.toBeNull();
    expect(result.claimed!.leaseExpiresAt).not.toBeNull();
  });

  it("claims disjoint wakeups for two agents and never hands out the same row twice", async () => {
    const agentA = nextId("agent");
    const agentB = nextId("agent");
    await setLoopEnabled(agentA, true);
    await setLoopEnabled(agentB, true);
    await enqueueWakeup(internalInput(agentA, "idle", null));
    await enqueueWakeup(internalInput(agentB, "idle", null));

    const first = await claimNextWakeup({ claimToken: "t-1", ...CAPS });
    const second = await claimNextWakeup({ claimToken: "t-2", ...CAPS });
    const third = await claimNextWakeup({ claimToken: "t-3", ...CAPS });

    expect(first.candidates).toBe(1);
    expect(second.candidates).toBe(1);
    // Nothing left to claim: both agents now have an in-flight claim, and no other row is pending.
    expect(third).toEqual({ candidates: 0 });

    const claimedIds = [first, second].map((r) => (r.candidates === 1 ? r.claimed?.id : undefined));
    const claimedAgents = [first, second].map((r) => (r.candidates === 1 ? r.claimed?.agentId : undefined));
    expect(new Set(claimedIds).size).toBe(2);
    expect(new Set(claimedAgents)).toEqual(new Set([agentA, agentB]));
  });

  it("terminalizes an over-cap candidate as budget_exhausted and spends nothing", async () => {
    const agent = nextId("agent");
    await setLoopEnabled(agent, true);
    await enqueueWakeup(internalInput(agent, "idle", null));

    const key = `${agent}:${todayUtc()}:general`;
    pulseBudgetCounters.set(key, 3);

    const result = await claimNextWakeup({ claimToken: "tok", leaseMs: 60_000, generalCap: 3, playgroundCap: 3 });

    expect(result).toEqual({ candidates: 1, claimed: null });
    // "A blocked claim spends nothing" — the counter must not have moved off the cap.
    expect(pulseBudgetCounters.get(key)).toBe(3);

    const rows = await listWakeupsForAgent(agent);
    expect(rows).toHaveLength(1);
    expect(rows[0].claimedAt).toBeNull();
    expect(rows[0].completedAt).not.toBeNull();
    expect(rows[0].result).toBe("budget_exhausted");
  });

  it("routes playground_round wakeups through the playground bucket, not the general one", async () => {
    const agent = nextId("agent");
    await setLoopEnabled(agent, true);
    await enqueueWakeup(internalInput(agent, "playground_round", 101));

    const generalKey = `${agent}:${todayUtc()}:general`;
    pulseBudgetCounters.set(generalKey, 999); // exhaust general; must not affect the playground bucket

    const result = await claimNextWakeup({ claimToken: "tok", leaseMs: 60_000, generalCap: 1, playgroundCap: 5 });
    if (result.candidates !== 1) throw new Error("[assertion] expected a candidate");

    expect(result.claimed).not.toBeNull();
    expect(pulseBudgetCounters.get(`${agent}:${todayUtc()}:playground`)).toBe(1);
    expect(pulseBudgetCounters.get(generalKey)).toBe(999); // untouched
  });
});

describe("renewWakeupLease", () => {
  it("renews with the right token, refuses with the wrong token, refuses when the agent is disabled", async () => {
    const agent = nextId("agent");
    await setLoopEnabled(agent, true);
    await enqueueWakeup(internalInput(agent, "idle", null));
    const claimed = await claimFor(agent, "tok");
    const initialLease = claimed.leaseExpiresAt!;

    // `claimFor` claimed with CAPS.leaseMs (60s); renew with a strictly LONGER lease so the new
    // expiry is unambiguously later regardless of the tiny gap between "claim" and "renew" here.
    expect(await renewWakeupLease(claimed.id, "wrong-token", 120_000)).toBe(false);
    expect((await listWakeupsForAgent(agent))[0].leaseExpiresAt).toBe(initialLease);

    expect(await renewWakeupLease(claimed.id, "tok", 120_000)).toBe(true);
    const renewedLease = (await listWakeupsForAgent(agent))[0].leaseExpiresAt!;
    expect(Date.parse(renewedLease)).toBeGreaterThan(Date.parse(initialLease));

    agentLoopState.set(agent, { ...agentLoopState.get(agent)!, enabled: false });
    expect(await renewWakeupLease(claimed.id, "tok", 120_000)).toBe(false);
  });

  it("refuses an id that does not exist", async () => {
    expect(await renewWakeupLease(9_999_999, "tok", 5_000)).toBe(false);
  });
});

describe("completeWakeup", () => {
  it("completes with the right token, and a second completion with the same token is refused", async () => {
    const agent = nextId("agent");
    await setLoopEnabled(agent, true);
    await enqueueWakeup(internalInput(agent, "idle", null));
    const claimed = await claimFor(agent, "tok");

    expect(await completeWakeup(claimed.id, "tok", "acted")).toBe(true);
    const row = (await listWakeupsForAgent(agent))[0];
    expect(row.completedAt).not.toBeNull();
    expect(row.result).toBe("acted");

    // completed_at IS NOT NULL now, so the same fence refuses a second write — even with the
    // correct token, and nothing about the row changes.
    expect(await completeWakeup(claimed.id, "tok", "skip")).toBe(false);
    const rowAfter = (await listWakeupsForAgent(agent))[0];
    expect(rowAfter.result).toBe("acted");
    expect(rowAfter.completedAt).toBe(row.completedAt);
  });

  it("refuses the wrong token", async () => {
    const agent = nextId("agent");
    await setLoopEnabled(agent, true);
    await enqueueWakeup(internalInput(agent, "idle", null));
    const claimed = await claimFor(agent, "tok");

    expect(await completeWakeup(claimed.id, "stale-runner-token", "error")).toBe(false);
    expect((await listWakeupsForAgent(agent))[0].completedAt).toBeNull();
  });
});

describe("abandonExpiredWakeupLeases", () => {
  it("abandons a claim whose lease has lapsed, freeing the one-inflight slot", async () => {
    const agent = nextId("agent");
    await setLoopEnabled(agent, true);
    await enqueueWakeup(internalInput(agent, "idle", null));
    const claimed = await claimFor(agent, "tok");

    const row = wakeupQueue.rows.get(claimed.id)!;
    row.leaseExpiresAt = new Date(Date.now() - 60_000).toISOString();

    expect(await abandonExpiredWakeupLeases()).toBe(1);

    const after = wakeupQueue.rows.get(claimed.id)!;
    expect(after.completedAt).not.toBeNull();
    expect(after.result).toBe("abandoned");
  });

  it("does not touch a claim whose lease is still live, or a row that was never claimed", async () => {
    const agent = nextId("agent");
    await setLoopEnabled(agent, true);
    await enqueueWakeup(internalInput(agent, "idle", null));
    const claimed = await claimFor(agent, "tok"); // lease 60s out — still live

    const pendingAgent = nextId("agent");
    await enqueueWakeup(internalInput(pendingAgent, "idle", null)); // never claimed

    expect(await abandonExpiredWakeupLeases()).toBe(0);
    expect(wakeupQueue.rows.get(claimed.id)!.completedAt).toBeNull();
    expect((await listWakeupsForAgent(pendingAgent))[0].completedAt).toBeNull();
  });
});

describe("terminalizeDisabledAgentWakeups", () => {
  it("terminalizes a pending wakeup for an agent with NO agent_loop_state row", async () => {
    const agent = nextId("agent");
    await enqueueWakeup(internalInput(agent, "idle", null));

    expect(await terminalizeDisabledAgentWakeups()).toBeGreaterThanOrEqual(1);

    const row = (await listWakeupsForAgent(agent))[0];
    expect(row.completedAt).not.toBeNull();
    expect(row.result).toBe("autonomy_disabled");
  });

  it("terminalizes a pending wakeup for an agent explicitly enabled: false", async () => {
    const agent = nextId("agent");
    await setLoopEnabled(agent, true);
    await setLoopEnabled(agent, false);
    await enqueueWakeup(internalInput(agent, "idle", null));

    expect(await terminalizeDisabledAgentWakeups()).toBeGreaterThanOrEqual(1);

    const row = (await listWakeupsForAgent(agent))[0];
    expect(row.completedAt).not.toBeNull();
    expect(row.result).toBe("autonomy_disabled");
  });

  it("does NOT touch a pending wakeup belonging to an enabled agent", async () => {
    const agent = nextId("agent");
    await setLoopEnabled(agent, true);
    await enqueueWakeup(internalInput(agent, "idle", null));

    await terminalizeDisabledAgentWakeups();

    const row = (await listWakeupsForAgent(agent))[0];
    expect(row.completedAt).toBeNull();
    expect(row.result).toBeNull();
  });

  it("does not touch an already-claimed row, even for a disabled agent", async () => {
    const agent = nextId("agent");
    await setLoopEnabled(agent, true);
    await enqueueWakeup(internalInput(agent, "idle", null));
    const claimed = await claimFor(agent, "tok");

    agentLoopState.set(agent, { ...agentLoopState.get(agent)!, enabled: false });
    await terminalizeDisabledAgentWakeups();

    expect(wakeupQueue.rows.get(claimed.id)!.completedAt).toBeNull();
  });
});

/**
 * M11-2 u6 stitch item 4 — P2.2's retention policy, the wakeup queue's share.
 *
 * The property that matters is the EXCLUSION, not the deletion: pending and claimed rows must survive
 * at any age. A pending row far in the future is legitimate, and a claimed row owns its agent's
 * one-inflight slot — deleting either behind a runner's back is the failure this duty must not
 * introduce.
 */
describe("pruneTerminalWakeups", () => {
  /** Backdate the completion clock — the only field this duty reads. */
  function completeLongAgo(id: number, daysAgo: number): void {
    const row = wakeupQueue.rows.get(id)!;
    row.completedAt = new Date(Date.now() - daysAgo * 24 * 60 * 60 * 1000).toISOString();
    row.result = "acted";
  }

  it("deletes a completed wakeup older than the window, and keeps a recent one", async () => {
    const agent = nextId("agent");
    await setLoopEnabled(agent, true);
    await enqueueWakeup(internalInput(agent, "idle", null));
    const old = await claimFor(agent, "tok");
    await completeWakeup(old.id, "tok", "acted");
    completeLongAgo(old.id, 45);

    await enqueueWakeup(internalInput(agent, "comment_on_my_post", 4001));
    const recent = await claimFor(agent, "tok2");
    await completeWakeup(recent.id, "tok2", "acted");

    expect(await pruneTerminalWakeups(30, 1000)).toBe(1);
    expect(wakeupQueue.rows.has(old.id)).toBe(false);
    expect(wakeupQueue.rows.has(recent.id)).toBe(true);
  });

  it("NEVER deletes a pending row or a claimed row, however old", async () => {
    const pendingAgent = nextId("agent");
    await enqueueWakeup(internalInput(pendingAgent, "idle", null));
    const pending = (await listWakeupsForAgent(pendingAgent))[0];

    const claimingAgent = nextId("agent");
    await setLoopEnabled(claimingAgent, true);
    await enqueueWakeup(internalInput(claimingAgent, "idle", null));
    const claimed = await claimFor(claimingAgent, "tok");
    // Old by every clock the row carries — and still not this duty's business.
    const claimedRow = wakeupQueue.rows.get(claimed.id)!;
    claimedRow.claimedAt = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString();
    claimedRow.leaseExpiresAt = new Date(Date.now() - 89 * 24 * 60 * 60 * 1000).toISOString();

    expect(await pruneTerminalWakeups(30, 1000)).toBe(0);
    expect(wakeupQueue.rows.has(pending.id)).toBe(true);
    expect(wakeupQueue.rows.has(claimed.id)).toBe(true);
  });

  it("is bounded by its limit, oldest first, and the remainder waits for the next run", async () => {
    const agent = nextId("agent");
    await setLoopEnabled(agent, true);
    const ids: number[] = [];
    for (let i = 0; i < 3; i += 1) {
      await enqueueWakeup(internalInput(agent, "comment_on_my_post", 5000 + i));
      const claimed = await claimFor(agent, `tok_${i}`);
      await completeWakeup(claimed.id, `tok_${i}`, "acted");
      // Descending age, so "oldest first" is a claim the ORDER has to earn.
      completeLongAgo(claimed.id, 90 - i);
      ids.push(claimed.id);
    }

    expect(await pruneTerminalWakeups(30, 2)).toBe(2);
    expect(wakeupQueue.rows.has(ids[0])).toBe(false);
    expect(wakeupQueue.rows.has(ids[1])).toBe(false);
    expect(wakeupQueue.rows.has(ids[2])).toBe(true);

    expect(await pruneTerminalWakeups(30, 2)).toBe(1);
    expect(wakeupQueue.rows.has(ids[2])).toBe(false);
  });
});
