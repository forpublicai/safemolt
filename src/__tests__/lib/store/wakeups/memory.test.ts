/**
 * M11-2 P3.2 (train a4, lane C) — the wakeup queue's memory store.
 *
 * The memory implementation is not a convenience: it is the mode Jest runs, so every rule the
 * database enforces structurally — two partial unique dedup indexes, and the plan's NORMATIVE re-arm
 * predicate — has to be reproduced here or the whole suite is blind to it. These gates check the
 * semantics themselves rather than the mechanics:
 *
 *  - the event-keyed dedup index is NOT partial on `completed_at`, so a completed row blocks a
 *    second insert FOREVER and only a re-arm (which reuses that row) frees the key;
 *  - the idle dedup index IS partial on `completed_at`, so a completed idle row stops blocking;
 *  - the re-arm predicate refuses a live claim, refuses `acted`, and refuses `budget_exhausted`
 *    until the day rolls over.
 *
 * The two REFUSAL clauses (`acted`, and `budget_exhausted` today) were mutation-checked: each was
 * suppressed in `memory.ts` in turn, the corresponding case below failed by wrongly re-arming, and
 * the clause was restored.
 *
 * Nothing here writes `claimed_at`, `completed_at` or `result` through a production function,
 * because no such function exists yet — claiming, leasing and completion are P3.3. A test that needs
 * a completed row seeds one directly through `wakeupQueue`, which is honest about that.
 *
 * @jest-environment node
 */
import { resetWakeupState, wakeupQueue } from "@/lib/store/_memory-state";
import { eventLog } from "@/lib/store/_memory-state";
import { emitEvent } from "@/lib/store/events/memory";
import {
  createOrReArmWakeup,
  enqueueWakeup,
  findRoundOpenedEventId,
  getWakeupByAgentReasonEvent,
  listWakeupsForAgent,
  reArmWakeupById,
  resolveWakeupDelivery,
} from "@/lib/store/wakeups/memory";

let seq = 0;
const nextId = (label: string) => `u5w_${label}_${Date.now().toString(36)}_${(seq += 1)}`;

const PLAYGROUND_ROUND = "playground_round";

/** `enqueueWakeup`'s input with the fixture's defaults filled in. */
function input(
  agentId: string,
  reason: string,
  eventId: number | null,
  extra: { payload?: Record<string, unknown>; dueAt?: string } = {}
) {
  return {
    agentId,
    reason,
    eventId,
    payload: extra.payload ?? { source: "test" },
    delivery: "internal" as const,
    ...(extra.dueAt ? { dueAt: extra.dueAt } : {}),
  };
}

/**
 * Stamp a row completed, the way a P3.3 runner eventually will.
 *
 * Reaching into `wakeupQueue` deliberately: there is no completion writer to call, and inventing one
 * for the tests would put a claim path in a deliverable that is supposed to have none.
 */
function seedCompleted(id: number, result: string | null, completedAt: string): void {
  const row = wakeupQueue.rows.get(id);
  if (!row) throw new Error(`[fixture] no wakeup ${id}`);
  row.completedAt = completedAt;
  row.result = result;
}

const isoDaysAgo = (days: number) => new Date(Date.now() - days * 86_400_000).toISOString();

beforeEach(() => {
  resetWakeupState();
});

afterAll(() => {
  resetWakeupState();
  eventLog.rows.length = 0;
  eventLog.nextId = 1;
});

describe("enqueueWakeup — event-keyed dedup (idx_wakeups_dedup_event)", () => {
  it("creates the first row and refuses a second for the same triple", async () => {
    const agent = nextId("agent");
    const first = await enqueueWakeup(input(agent, PLAYGROUND_ROUND, 101));

    expect(first.created).toBe(true);
    expect(first.wakeup).toMatchObject({
      agentId: agent,
      reason: PLAYGROUND_ROUND,
      eventId: 101,
      delivery: "internal",
      claimedAt: null,
      claimToken: null,
      leaseExpiresAt: null,
      completedAt: null,
      result: null,
    });

    const second = await enqueueWakeup(input(agent, PLAYGROUND_ROUND, 101));
    expect(second).toEqual({ created: false, wakeup: null });
    expect(await listWakeupsForAgent(agent)).toHaveLength(1);
  });

  /**
   * The index is `UNIQUE (agent_id, reason, event_id) WHERE event_id IS NOT NULL` — partial on the
   * event id and on NOTHING else. A completed row therefore still occupies the key.
   */
  it("still refuses after the existing row has COMPLETED", async () => {
    const agent = nextId("agent");
    const created = await enqueueWakeup(input(agent, PLAYGROUND_ROUND, 202));
    seedCompleted(created.wakeup!.id, "acted", new Date().toISOString());

    expect(await enqueueWakeup(input(agent, PLAYGROUND_ROUND, 202))).toEqual({
      created: false,
      wakeup: null,
    });
    expect(await listWakeupsForAgent(agent)).toHaveLength(1);
  });

  it("keys on all three columns, not on the agent alone", async () => {
    const agent = nextId("agent");
    await enqueueWakeup(input(agent, PLAYGROUND_ROUND, 303));

    expect((await enqueueWakeup(input(agent, PLAYGROUND_ROUND, 304))).created).toBe(true);
    expect((await enqueueWakeup(input(agent, "mention", 303))).created).toBe(true);
    expect((await enqueueWakeup(input(nextId("agent"), PLAYGROUND_ROUND, 303))).created).toBe(true);
  });
});

describe("enqueueWakeup — idle dedup (idx_wakeups_dedup_idle)", () => {
  it("refuses a second PENDING idle row for the same agent and reason", async () => {
    const agent = nextId("agent");
    expect((await enqueueWakeup(input(agent, "idle", null))).created).toBe(true);
    expect(await enqueueWakeup(input(agent, "idle", null))).toEqual({ created: false, wakeup: null });
    expect(await listWakeupsForAgent(agent)).toHaveLength(1);
  });

  /**
   * `WHERE event_id IS NULL AND completed_at IS NULL` — the partial predicate is what makes the
   * queue re-enqueueable: once yesterday's idle row completes it stops blocking today's.
   */
  it("ADMITS a new idle row once the prior one is completed", async () => {
    const agent = nextId("agent");
    const first = await enqueueWakeup(input(agent, "idle", null));
    seedCompleted(first.wakeup!.id, "acted", new Date().toISOString());

    const second = await enqueueWakeup(input(agent, "idle", null));
    expect(second.created).toBe(true);
    expect(second.wakeup!.id).not.toBe(first.wakeup!.id);
    expect(await listWakeupsForAgent(agent)).toHaveLength(2);
  });

  it("dedupes per reason, so a different idle reason is admitted", async () => {
    const agent = nextId("agent");
    await enqueueWakeup(input(agent, "idle", null));
    expect((await enqueueWakeup(input(agent, "digest", null))).created).toBe(true);
  });
});

describe("createOrReArmWakeup — the normative predicate", () => {
  /** (a) */
  it("creates when no row exists", async () => {
    const agent = nextId("agent");
    expect(await createOrReArmWakeup({ ...input(agent, PLAYGROUND_ROUND, 11), eventId: 11 })).toEqual({
      created: true,
      reArmed: false,
    });
    expect(await listWakeupsForAgent(agent)).toHaveLength(1);
  });

  /** (b) `completed_at IS NULL` — still pending or claimed. Neither arm may fire. */
  it("neither creates nor re-arms while the existing row is still pending", async () => {
    const agent = nextId("agent");
    await enqueueWakeup(input(agent, PLAYGROUND_ROUND, 12));

    expect(await createOrReArmWakeup({ ...input(agent, PLAYGROUND_ROUND, 12), eventId: 12 })).toEqual({
      created: false,
      reArmed: false,
    });
    expect(await listWakeupsForAgent(agent)).toHaveLength(1);
  });

  it("neither creates nor re-arms while the existing row is CLAIMED", async () => {
    const agent = nextId("agent");
    const created = await enqueueWakeup(input(agent, PLAYGROUND_ROUND, 13));
    const row = wakeupQueue.rows.get(created.wakeup!.id)!;
    row.claimedAt = new Date().toISOString();
    row.claimToken = "token";
    row.leaseExpiresAt = new Date(Date.now() - 60_000).toISOString(); // even a LAPSED lease

    expect(await createOrReArmWakeup({ ...input(agent, PLAYGROUND_ROUND, 13), eventId: 13 })).toEqual({
      created: false,
      reArmed: false,
    });
    expect(wakeupQueue.rows.get(created.wakeup!.id)!.claimToken).toBe("token");
  });

  /** (c) MUTATION-CHECKED: suppressing `result IS DISTINCT FROM 'acted'` makes this re-arm. */
  it("refuses to re-arm a row completed with result 'acted'", async () => {
    const agent = nextId("agent");
    const created = await enqueueWakeup(input(agent, PLAYGROUND_ROUND, 14));
    seedCompleted(created.wakeup!.id, "acted", new Date().toISOString());

    expect(await createOrReArmWakeup({ ...input(agent, PLAYGROUND_ROUND, 14), eventId: 14 })).toEqual({
      created: false,
      reArmed: false,
    });
    expect(wakeupQueue.rows.get(created.wakeup!.id)!.completedAt).not.toBeNull();
  });

  /** (d) `skip`, `error` and `abandoned` are all re-armable — the zero-forfeit rule. */
  it.each(["error", "skip", "abandoned", null])(
    "re-arms a row completed with result %p",
    async (result) => {
      const agent = nextId("agent");
      const created = await enqueueWakeup(input(agent, PLAYGROUND_ROUND, 15));
      seedCompleted(created.wakeup!.id, result, new Date().toISOString());

      expect(await createOrReArmWakeup({ ...input(agent, PLAYGROUND_ROUND, 15), eventId: 15 })).toEqual({
        created: false,
        reArmed: true,
      });

      // The SAME row, reset — never a second row.
      expect(await listWakeupsForAgent(agent)).toHaveLength(1);
      expect(wakeupQueue.rows.get(created.wakeup!.id)).toMatchObject({
        claimedAt: null,
        claimToken: null,
        leaseExpiresAt: null,
        completedAt: null,
        result: null,
      });
    }
  );

  /** (e) MUTATION-CHECKED: suppressing the budget clause makes this re-arm. */
  it("refuses to re-arm a 'budget_exhausted' row completed TODAY", async () => {
    const agent = nextId("agent");
    const created = await enqueueWakeup(input(agent, PLAYGROUND_ROUND, 16));
    seedCompleted(created.wakeup!.id, "budget_exhausted", new Date().toISOString());

    expect(await createOrReArmWakeup({ ...input(agent, PLAYGROUND_ROUND, 16), eventId: 16 })).toEqual({
      created: false,
      reArmed: false,
    });
    expect(wakeupQueue.rows.get(created.wakeup!.id)!.result).toBe("budget_exhausted");
  });

  /** (f) The daily bucket rolls over at midnight, and so does the row's eligibility. */
  it("re-arms a 'budget_exhausted' row completed YESTERDAY", async () => {
    const agent = nextId("agent");
    const created = await enqueueWakeup(input(agent, PLAYGROUND_ROUND, 17));
    seedCompleted(created.wakeup!.id, "budget_exhausted", isoDaysAgo(1));

    expect(await createOrReArmWakeup({ ...input(agent, PLAYGROUND_ROUND, 17), eventId: 17 })).toEqual({
      created: false,
      reArmed: true,
    });
    expect(wakeupQueue.rows.get(created.wakeup!.id)!.result).toBeNull();
  });
});

describe("reArmWakeupById — the same predicate, by a known id", () => {
  async function completedRow(result: string | null, completedAt: string): Promise<number> {
    const created = await enqueueWakeup(input(nextId("agent"), PLAYGROUND_ROUND, 21));
    seedCompleted(created.wakeup!.id, result, completedAt);
    return created.wakeup!.id;
  }

  it("re-arms an 'error' completion and clears all five columns", async () => {
    const id = await completedRow("error", new Date().toISOString());
    const row = wakeupQueue.rows.get(id)!;
    row.claimedAt = new Date().toISOString();
    row.claimToken = "stale-runner";
    row.leaseExpiresAt = new Date().toISOString();

    expect(await reArmWakeupById(id)).toBe(true);
    expect(wakeupQueue.rows.get(id)).toMatchObject({
      claimedAt: null,
      claimToken: null,
      leaseExpiresAt: null,
      completedAt: null,
      result: null,
    });
  });

  it("refuses a pending row, an 'acted' row and a same-day 'budget_exhausted' row", async () => {
    const pending = await enqueueWakeup(input(nextId("agent"), PLAYGROUND_ROUND, 22));
    expect(await reArmWakeupById(pending.wakeup!.id)).toBe(false);

    expect(await reArmWakeupById(await completedRow("acted", new Date().toISOString()))).toBe(false);
    expect(
      await reArmWakeupById(await completedRow("budget_exhausted", new Date().toISOString()))
    ).toBe(false);
  });

  it("admits a 'budget_exhausted' row completed yesterday", async () => {
    expect(await reArmWakeupById(await completedRow("budget_exhausted", isoDaysAgo(1)))).toBe(true);
  });

  it("answers false for an id that does not exist", async () => {
    expect(await reArmWakeupById(9_999_999)).toBe(false);
  });
});

describe("reads", () => {
  it("getWakeupByAgentReasonEvent finds by triple and answers null otherwise", async () => {
    const agent = nextId("agent");
    await enqueueWakeup(input(agent, PLAYGROUND_ROUND, 31, { payload: { round: 4 } }));

    expect(await getWakeupByAgentReasonEvent(agent, PLAYGROUND_ROUND, 31)).toMatchObject({
      agentId: agent,
      reason: PLAYGROUND_ROUND,
      eventId: 31,
      payload: { round: 4 },
    });
    expect(await getWakeupByAgentReasonEvent(agent, PLAYGROUND_ROUND, 32)).toBeNull();
    expect(await getWakeupByAgentReasonEvent(agent, "mention", 31)).toBeNull();
    expect(await getWakeupByAgentReasonEvent(nextId("agent"), PLAYGROUND_ROUND, 31)).toBeNull();
  });

  it("listWakeupsForAgent filters by reason, limits, and answers newest first", async () => {
    const agent = nextId("agent");
    await enqueueWakeup(input(agent, PLAYGROUND_ROUND, 41));
    await enqueueWakeup(input(agent, PLAYGROUND_ROUND, 42));
    await enqueueWakeup(input(agent, "mention", 43));
    await enqueueWakeup(input(nextId("agent"), PLAYGROUND_ROUND, 44));

    expect((await listWakeupsForAgent(agent)).map((w) => w.eventId)).toEqual([43, 42, 41]);
    expect((await listWakeupsForAgent(agent, { reason: PLAYGROUND_ROUND })).map((w) => w.eventId)).toEqual([
      42, 41,
    ]);
    expect((await listWakeupsForAgent(agent, { limit: 1 })).map((w) => w.eventId)).toEqual([43]);
  });

  /** A caller that mutated what it read would rewrite stored state. */
  it("hands out copies, not the stored rows", async () => {
    const agent = nextId("agent");
    const created = await enqueueWakeup(input(agent, PLAYGROUND_ROUND, 51, { payload: { round: 1 } }));
    (created.wakeup!.payload as { round: number }).round = 99;
    created.wakeup!.result = "tampered";

    expect(await getWakeupByAgentReasonEvent(agent, PLAYGROUND_ROUND, 51)).toMatchObject({
      payload: { round: 1 },
      result: null,
    });
  });
});

describe("findRoundOpenedEventId", () => {
  /**
   * Seeded through the events domain's own `emitEvent` rather than by pushing rows into
   * `eventLog.rows` by hand, so the read is proved against events written the way production writes
   * them.
   */
  it("finds the event for (session, round) and nothing else", async () => {
    const sessionA = nextId("session");
    const sessionB = nextId("session");

    await emitEvent({ kind: "system.activation_fence", payload: { consumer: "wakeup-router" } });
    const round2 = await emitEvent({
      kind: "playground.round_opened",
      subjectType: "playground_session",
      subjectId: sessionA,
      payload: { session_id: sessionA, round: 2 },
    });
    await emitEvent({ kind: "system.activation_fence", payload: { consumer: "notifications" } });
    const round3 = await emitEvent({
      kind: "playground.round_opened",
      subjectType: "playground_session",
      subjectId: sessionA,
      payload: { session_id: sessionA, round: 3 },
    });
    const otherSession = await emitEvent({
      kind: "playground.round_opened",
      subjectType: "playground_session",
      subjectId: sessionB,
      payload: { session_id: sessionB, round: 2 },
    });

    expect(await findRoundOpenedEventId(sessionA, 2)).toBe(round2.id);
    expect(await findRoundOpenedEventId(sessionA, 3)).toBe(round3.id);
    expect(await findRoundOpenedEventId(sessionB, 2)).toBe(otherSession.id);

    expect(await findRoundOpenedEventId(sessionA, 1)).toBeNull();
    expect(await findRoundOpenedEventId(sessionA, 4)).toBeNull();
    expect(await findRoundOpenedEventId(nextId("session"), 2)).toBeNull();
  });

  /** Defensive: history holding two for one (session, round) answers with the newer one. */
  it("answers newest first", async () => {
    const session = nextId("session");
    await emitEvent({
      kind: "playground.round_opened",
      subjectType: "playground_session",
      subjectId: session,
      payload: { session_id: session, round: 1 },
    });
    const newer = await emitEvent({
      kind: "playground.round_opened",
      subjectType: "playground_session",
      subjectId: session,
      payload: { session_id: session, round: 1, reconstructed: true },
    });

    expect(await findRoundOpenedEventId(session, 1)).toBe(newer.id);
  });

  it("answers null for a non-integer round rather than rounding it", async () => {
    const session = nextId("session");
    const opened = await emitEvent({
      kind: "playground.round_opened",
      subjectType: "playground_session",
      subjectId: session,
      payload: { session_id: session, round: 3 },
    });

    expect(await findRoundOpenedEventId(session, 3)).toBe(opened.id);
    expect(await findRoundOpenedEventId(session, 2.7)).toBeNull();
  });
});

describe("resolveWakeupDelivery", () => {
  /**
   * The documented, deliberate memory-mode behavior: `agent_loop_state` has no memory store anywhere
   * in this codebase, and nothing in this lane branches on `delivery` yet.
   */
  it("resolves 'internal' for any agent id, with no setup at all", async () => {
    expect(await resolveWakeupDelivery(nextId("agent"))).toBe("internal");
    expect(await resolveWakeupDelivery("an-agent-that-was-never-created")).toBe("internal");
  });
});
