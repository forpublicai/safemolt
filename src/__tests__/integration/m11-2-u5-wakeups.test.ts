/**
 * M11-2 P3.2 (train a4, lane C) `[integration]` — the wakeup queue against the real database.
 *
 * What only a database can show, and what this file is for:
 *  - the three dedup rules are **partial unique indexes**, not predicates in application code, so
 *    the only place their exact partiality is observable is Postgres: the event-keyed index is not
 *    partial on `completed_at` (a completed row blocks forever), the idle one is (a completed row
 *    stops blocking), and a bare `ON CONFLICT DO NOTHING` absorbs whichever one fires;
 *  - `completed_at::date < CURRENT_DATE` is evaluated by Postgres in the session time zone, which a
 *    memory twin can only approximate;
 *  - the create-or-re-arm RACE has no memory-mode counterpart at all — its false/false outcome comes
 *    from MVCC snapshotting, and the invariant that survives it is the row count, not either
 *    caller's report.
 *
 * `agent_wakeups.agent_id` and `agent_loop_state.agent_id` both carry `REFERENCES agents(id) ON
 * DELETE CASCADE`, so every fixture row here hangs off a real seeded agent — an unseeded id raises
 * 23503 rather than inserting.
 */
import { emitEvent } from "@/lib/store";
import {
  createOrReArmWakeup,
  enqueueWakeup,
  findRoundOpenedEventId,
  getWakeupByAgentReasonEvent,
  listWakeupsForAgent,
  reArmWakeupById,
  resolveWakeupDelivery,
} from "@/lib/store/wakeups/db";
import { closeIntegrationConnections, pgPool } from "./helpers/db";
import { rejections, runConcurrently } from "./helpers/concurrency";

const RUN = `${Date.now().toString(36)}_${Math.floor(Math.random() * 1e6).toString(36)}`;
let seq = 0;
const nextId = (kind: string) => `u5w_${kind}_${RUN}_${(seq += 1)}`;

const PLAYGROUND_ROUND = "playground_round";

/** Every event this file writes lands above this id, so cleanup needs no marker column. */
let baselineEventId = 0;

/** A fresh BIGINT that is not an events row — the queue's `event_id` has no foreign key. */
let syntheticEventId = 900_000_000;
const nextEventId = () => (syntheticEventId += 1);

async function seedAgent(): Promise<string> {
  const id = nextId("agent");
  await pgPool().query(
    `INSERT INTO agents (id, name, description, api_key, points, vote_points, evaluation_points,
                         legacy_unattributed_points, follower_count, is_claimed, created_at, is_vetted)
     VALUES ($1, $1, '', $2, 0, 0, 0, 0, 0, false, NOW(), true)`,
    [id, `u5w_key_${id}`]
  );
  return id;
}

async function seedLoopState(agentId: string, enabled: boolean): Promise<void> {
  await pgPool().query(`INSERT INTO agent_loop_state (agent_id, enabled) VALUES ($1, $2)`, [
    agentId,
    enabled,
  ]);
}

/**
 * Stamp a row completed, the way a P3.3 runner eventually will.
 *
 * Written with raw SQL deliberately: there is no completion writer in this deliverable, and adding
 * one for the tests would put a claim path in a lane that is supposed to have none. `completedAgo`
 * is an interval so "today" and "yesterday" are decided by the same clock and time zone the re-arm
 * predicate's `CURRENT_DATE` uses.
 */
async function seedCompleted(id: number, result: string | null, completedAgo = "0 days"): Promise<void> {
  await pgPool().query(
    `UPDATE agent_wakeups SET completed_at = NOW() - $2::interval, result = $3 WHERE id = $1`,
    [id, completedAgo, result]
  );
}

async function seedClaim(id: number, token: string): Promise<void> {
  await pgPool().query(
    `UPDATE agent_wakeups
     SET claimed_at = NOW(), claim_token = $2, lease_expires_at = NOW() - INTERVAL '1 minute'
     WHERE id = $1`,
    [id, token]
  );
}

async function countWakeups(agentId: string, reason: string, eventId: number): Promise<number> {
  const { rows } = await pgPool().query(
    `SELECT count(*)::int AS n FROM agent_wakeups
     WHERE agent_id = $1 AND reason = $2 AND event_id = $3`,
    [agentId, reason, eventId]
  );
  return rows[0].n as number;
}

async function readRow(id: number): Promise<Record<string, unknown>> {
  const { rows } = await pgPool().query(`SELECT * FROM agent_wakeups WHERE id = $1`, [id]);
  return rows[0] as Record<string, unknown>;
}

/**
 * Generic in the event id on purpose: `createOrReArmWakeup` takes a non-null one, so a helper that
 * widened every call to `number | null` would make the compiler stop enforcing that.
 */
function wakeup<E extends number | null>(agentId: string, reason: string, eventId: E) {
  return {
    agentId,
    reason,
    eventId,
    payload: { source: "integration", run: RUN },
    delivery: "internal" as const,
  };
}

beforeAll(async () => {
  const { rows } = await pgPool().query(`SELECT COALESCE(max(id), 0) AS id FROM events`);
  baselineEventId = Number(rows[0].id);
});

afterAll(async () => {
  // Wakeups and loop state cascade from the agents, but they are removed explicitly first so a
  // failed agent cleanup cannot leave the queue holding this run's rows.
  await pgPool().query(`DELETE FROM agent_wakeups WHERE agent_id LIKE $1`, [`u5w_agent_${RUN}%`]);
  await pgPool().query(`DELETE FROM agent_loop_state WHERE agent_id LIKE $1`, [`u5w_agent_${RUN}%`]);
  await pgPool().query(`DELETE FROM events WHERE id > $1`, [baselineEventId]);
  await pgPool().query(`DELETE FROM agents WHERE id LIKE $1`, [`u5w_agent_${RUN}%`]);
  await closeIntegrationConnections();
});

describe("enqueueWakeup", () => {
  it("writes every column and reads it back", async () => {
    const agent = await seedAgent();
    const eventId = nextEventId();
    const dueAt = new Date(Date.now() + 120_000).toISOString();

    const created = await enqueueWakeup({ ...wakeup(agent, PLAYGROUND_ROUND, eventId), dueAt });

    expect(created.created).toBe(true);
    expect(created.wakeup).toMatchObject({
      agentId: agent,
      reason: PLAYGROUND_ROUND,
      eventId,
      delivery: "internal",
      payload: { source: "integration", run: RUN },
      claimedAt: null,
      claimToken: null,
      leaseExpiresAt: null,
      completedAt: null,
      result: null,
    });
    // BIGSERIAL and BIGINT arrive as strings from both drivers; a reader comparing them numerically
    // must never receive one.
    expect(typeof created.wakeup!.id).toBe("number");
    expect(typeof created.wakeup!.eventId).toBe("number");
    expect(created.wakeup!.dueAt).toBe(dueAt);

    expect(await getWakeupByAgentReasonEvent(agent, PLAYGROUND_ROUND, eventId)).toEqual(created.wakeup);
  });

  /** `idx_wakeups_dedup_event` — not partial on `completed_at`, so a completion still occupies it. */
  it("refuses a second row for the same (agent, reason, event), completed or not", async () => {
    const agent = await seedAgent();
    const eventId = nextEventId();
    const first = await enqueueWakeup(wakeup(agent, PLAYGROUND_ROUND, eventId));

    expect(await enqueueWakeup(wakeup(agent, PLAYGROUND_ROUND, eventId))).toEqual({
      created: false,
      wakeup: null,
    });

    await seedCompleted(first.wakeup!.id, "acted");
    expect(await enqueueWakeup(wakeup(agent, PLAYGROUND_ROUND, eventId))).toEqual({
      created: false,
      wakeup: null,
    });
    expect(await countWakeups(agent, PLAYGROUND_ROUND, eventId)).toBe(1);
  });

  /**
   * `idx_wakeups_dedup_idle` — partial on `completed_at IS NULL`, so a completed idle row stops
   * blocking. This is the asymmetry a bare `ON CONFLICT DO NOTHING` has to get right without the
   * caller naming which index it expected.
   */
  it("refuses a second PENDING idle row but admits one after the first completes", async () => {
    const agent = await seedAgent();
    const first = await enqueueWakeup(wakeup(agent, "idle", null));
    expect(first.created).toBe(true);
    expect(first.wakeup!.eventId).toBeNull();

    expect(await enqueueWakeup(wakeup(agent, "idle", null))).toEqual({ created: false, wakeup: null });

    await seedCompleted(first.wakeup!.id, "acted");
    const second = await enqueueWakeup(wakeup(agent, "idle", null));
    expect(second.created).toBe(true);
    expect(second.wakeup!.id).not.toBe(first.wakeup!.id);
    expect((await listWakeupsForAgent(agent, { reason: "idle" })).map((w) => w.id)).toEqual([
      second.wakeup!.id,
      first.wakeup!.id,
    ]);
  });
});

describe("createOrReArmWakeup — the normative predicate against the real table", () => {
  /** (a) */
  it("creates when no row exists", async () => {
    const agent = await seedAgent();
    const eventId = nextEventId();

    expect(await createOrReArmWakeup(wakeup(agent, PLAYGROUND_ROUND, eventId))).toEqual({
      created: true,
      reArmed: false,
    });
    expect(await countWakeups(agent, PLAYGROUND_ROUND, eventId)).toBe(1);
  });

  /** (b) still pending, and still claimed — a live claim is never touched. */
  it("neither creates nor re-arms a pending or claimed row", async () => {
    const agent = await seedAgent();
    const pendingEvent = nextEventId();
    await enqueueWakeup(wakeup(agent, PLAYGROUND_ROUND, pendingEvent));
    expect(await createOrReArmWakeup(wakeup(agent, PLAYGROUND_ROUND, pendingEvent))).toEqual({
      created: false,
      reArmed: false,
    });

    const claimedEvent = nextEventId();
    const claimed = await enqueueWakeup(wakeup(agent, PLAYGROUND_ROUND, claimedEvent));
    await seedClaim(claimed.wakeup!.id, `token_${RUN}`);
    expect(await createOrReArmWakeup(wakeup(agent, PLAYGROUND_ROUND, claimedEvent))).toEqual({
      created: false,
      reArmed: false,
    });
    expect((await readRow(claimed.wakeup!.id)).claim_token).toBe(`token_${RUN}`);
    expect(await countWakeups(agent, PLAYGROUND_ROUND, claimedEvent)).toBe(1);
  });

  /** (c) */
  it("refuses to re-arm a row completed 'acted'", async () => {
    const agent = await seedAgent();
    const eventId = nextEventId();
    const created = await enqueueWakeup(wakeup(agent, PLAYGROUND_ROUND, eventId));
    await seedCompleted(created.wakeup!.id, "acted");

    expect(await createOrReArmWakeup(wakeup(agent, PLAYGROUND_ROUND, eventId))).toEqual({
      created: false,
      reArmed: false,
    });
    expect((await readRow(created.wakeup!.id)).completed_at).not.toBeNull();
  });

  /** (d) `skip`, `error`, `abandoned` and a NULL result are all re-armable — zero forfeit. */
  it.each(["error", "skip", "abandoned", null])("re-arms a row completed %p", async (result) => {
    const agent = await seedAgent();
    const eventId = nextEventId();
    const created = await enqueueWakeup(wakeup(agent, PLAYGROUND_ROUND, eventId));
    await seedClaim(created.wakeup!.id, `token_${RUN}`);
    await seedCompleted(created.wakeup!.id, result);

    expect(await createOrReArmWakeup(wakeup(agent, PLAYGROUND_ROUND, eventId))).toEqual({
      created: false,
      reArmed: true,
    });

    // The SAME row, with all five columns cleared — never a second row.
    expect(await countWakeups(agent, PLAYGROUND_ROUND, eventId)).toBe(1);
    expect(await readRow(created.wakeup!.id)).toMatchObject({
      claimed_at: null,
      claim_token: null,
      lease_expires_at: null,
      completed_at: null,
      result: null,
    });
  });

  /** (e) */
  it("refuses to re-arm a 'budget_exhausted' row completed TODAY", async () => {
    const agent = await seedAgent();
    const eventId = nextEventId();
    const created = await enqueueWakeup(wakeup(agent, PLAYGROUND_ROUND, eventId));
    await seedCompleted(created.wakeup!.id, "budget_exhausted");

    expect(await createOrReArmWakeup(wakeup(agent, PLAYGROUND_ROUND, eventId))).toEqual({
      created: false,
      reArmed: false,
    });
    expect((await readRow(created.wakeup!.id)).result).toBe("budget_exhausted");
  });

  /** (f) The daily bucket rolls over at midnight, and so does the row's eligibility. */
  it("re-arms a 'budget_exhausted' row completed YESTERDAY", async () => {
    const agent = await seedAgent();
    const eventId = nextEventId();
    const created = await enqueueWakeup(wakeup(agent, PLAYGROUND_ROUND, eventId));
    await seedCompleted(created.wakeup!.id, "budget_exhausted", "1 day");

    expect(await createOrReArmWakeup(wakeup(agent, PLAYGROUND_ROUND, eventId))).toEqual({
      created: false,
      reArmed: true,
    });
    expect(await readRow(created.wakeup!.id)).toMatchObject({ completed_at: null, result: null });
  });

  /**
   * **The create-or-re-arm race, and why the assertion is the ROW COUNT.**
   *
   * Two callers racing this statement for the same triple with no row yet — the wakeup router and
   * the playground sweep reacting to one freshly drained `round_opened` — can BOTH answer
   * `created: false, reArmed: false`: the loser's `ins` correctly no-ops against the winner's
   * now-committed row, while its sibling `rearmed` CTE is evaluated against a statement snapshot
   * taken before that commit and therefore also sees nothing. That is a reporting gap, not a lost
   * write.
   *
   * So this asserts what actually matters — exactly one row exists afterwards, and neither call
   * raised — and deliberately does NOT assert that both callers reported `created: true`, nor that
   * exactly one did. An assertion on either caller's report would fail intermittently against
   * correct code, and "fixing" it would mean adding a `FOR UPDATE` arbiter that buys serialization
   * contention for no correctness payoff.
   */
  it("leaves exactly one row when two callers race the same triple", async () => {
    const agent = await seedAgent();
    const eventId = nextEventId();

    const outcomes = await runConcurrently([
      () => createOrReArmWakeup(wakeup(agent, PLAYGROUND_ROUND, eventId)),
      () => createOrReArmWakeup(wakeup(agent, PLAYGROUND_ROUND, eventId)),
    ]);

    expect(rejections(outcomes)).toEqual([]);
    expect(await countWakeups(agent, PLAYGROUND_ROUND, eventId)).toBe(1);
  });
});

describe("reArmWakeupById", () => {
  async function completed(result: string | null, completedAgo = "0 days"): Promise<number> {
    const agent = await seedAgent();
    const created = await enqueueWakeup(wakeup(agent, PLAYGROUND_ROUND, nextEventId()));
    await seedClaim(created.wakeup!.id, `token_${RUN}`);
    await seedCompleted(created.wakeup!.id, result, completedAgo);
    return created.wakeup!.id;
  }

  it("re-arms an 'error' completion and clears all five columns", async () => {
    const id = await completed("error");
    expect(await reArmWakeupById(id)).toBe(true);
    expect(await readRow(id)).toMatchObject({
      claimed_at: null,
      claim_token: null,
      lease_expires_at: null,
      completed_at: null,
      result: null,
    });
  });

  it("refuses a pending row, an 'acted' row and a same-day 'budget_exhausted' row", async () => {
    const agent = await seedAgent();
    const pending = await enqueueWakeup(wakeup(agent, PLAYGROUND_ROUND, nextEventId()));
    expect(await reArmWakeupById(pending.wakeup!.id)).toBe(false);
    expect(await reArmWakeupById(await completed("acted"))).toBe(false);
    expect(await reArmWakeupById(await completed("budget_exhausted"))).toBe(false);
  });

  it("admits a 'budget_exhausted' row completed yesterday", async () => {
    expect(await reArmWakeupById(await completed("budget_exhausted", "1 day"))).toBe(true);
  });

  it("answers false for an id that does not exist", async () => {
    expect(await reArmWakeupById(-1)).toBe(false);
  });
});

describe("findRoundOpenedEventId", () => {
  /** Seeded through the real event-emission path, so the read is proved against real rows. */
  it("finds the newest event for (session, round) and nothing else", async () => {
    const sessionA = nextId("session");
    const sessionB = nextId("session");

    await emitEvent({ kind: "system.activation_fence", payload: { consumer: `u5w_${RUN}` } });
    const round2 = await emitEvent({
      kind: "playground.round_opened",
      subjectType: "playground_session",
      subjectId: sessionA,
      payload: { session_id: sessionA, round: 2 },
    });
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
    expect(await findRoundOpenedEventId(nextId("session"), 2)).toBeNull();

    // Defensive read: a history holding two for one (session, round) answers with the newer one.
    const reconstructed = await emitEvent({
      kind: "playground.round_opened",
      subjectType: "playground_session",
      subjectId: sessionA,
      payload: { session_id: sessionA, round: 2, reconstructed: true },
    });
    expect(await findRoundOpenedEventId(sessionA, 2)).toBe(reconstructed.id);
  });

  it("answers null for a non-integer round rather than rounding it into another round", async () => {
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
  it("resolves 'internal' only for a loop-ENABLED agent", async () => {
    const enabled = await seedAgent();
    await seedLoopState(enabled, true);
    expect(await resolveWakeupDelivery(enabled)).toBe("internal");
  });

  /** `enabled = false` is the owner-facing kill switch: no wakeup may be created for that agent. */
  it("resolves null for a loop-DISABLED agent", async () => {
    const disabled = await seedAgent();
    await seedLoopState(disabled, false);
    expect(await resolveWakeupDelivery(disabled)).toBeNull();
  });

  it("resolves null when the agent has no loop-state row at all", async () => {
    expect(await resolveWakeupDelivery(await seedAgent())).toBeNull();
    expect(await resolveWakeupDelivery(`u5w_absent_${RUN}`)).toBeNull();
  });
});

describe("the agent foreign key", () => {
  /**
   * `agent_wakeups.agent_id REFERENCES agents(id) ON DELETE CASCADE` (PLAN_M11_2 pin 10): no
   * nonterminal row outlives its agent, and a wakeup for an agent that never existed is refused
   * outright rather than queued for nobody.
   */
  it("refuses a wakeup for an unknown agent and cascades on withdrawal", async () => {
    await expect(
      enqueueWakeup(wakeup(`u5w_agent_${RUN}_never_seeded`, PLAYGROUND_ROUND, nextEventId()))
    ).rejects.toThrow(/foreign key|23503/i);

    const agent = await seedAgent();
    const eventId = nextEventId();
    await enqueueWakeup(wakeup(agent, PLAYGROUND_ROUND, eventId));
    await pgPool().query(`DELETE FROM agents WHERE id = $1`, [agent]);
    expect(await countWakeups(agent, PLAYGROUND_ROUND, eventId)).toBe(0);
  });
});
