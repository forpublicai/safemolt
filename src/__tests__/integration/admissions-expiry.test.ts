/**
 * M11-2 u3f-core (admissions) `[integration]` — the offer-expiry sweep against a real Postgres.
 *
 * Memory mode drives expiry from the read path; db mode drives it ONLY from the drain route's
 * housekeeping duty (`runAdmissionsExpiryDuty` → `refreshExpiredOffersDb`), and the status read
 * writes nothing. Only a real database can prove:
 *
 *  - the sweep is ONE statement: the offer transition, the application returned to the pool and the
 *    `admissions.offer_expired` event all commit together (event gated on the `expired` UPDATE's
 *    RETURNING) — an injected event-insert failure rolls the whole thing back, offer still pending;
 *  - a plain status read in db mode does NOT expire a past-due offer (no cron in the read path);
 *  - the "no OTHER live offer" release predicate: an application whose lapsed offer is expired but
 *    which still carries a LIVE pending offer is NOT released to the pool.
 *
 * The B1 agents-first lock order (`sweep_agents` CTE) is a lock-ordering fix; its correctness is
 * that the statement PARSES and runs, which every case here exercises.
 *
 * Every fixture value is RUN-suffixed under every UNIQUE column: the reserved database persists rows
 * across runs.
 *
 * @jest-environment node
 */
import {
  runAdmissionsExpiryDuty,
  getAdmissionsStatusForAgent,
  ensureApplicationInPool,
  getApplicationByAgentCycle,
  updateApplicationNiche,
  acceptOfferAsAgent,
  declineOfferAsAgent,
} from "@/lib/admissions";
import { deleteAgent } from "@/lib/store";
import { STORE_ASSIGNED_PAYLOAD_ID, type PreparedEvent } from "@/lib/events/kinds";
import type { DeleteAgentResult } from "@/lib/store-types";

import { closeIntegrationConnections, pgClient, pgPool } from "./helpers/db";
import { pidOf, waitersOn, waitForWaiter, runConcurrently, rejections } from "./helpers/concurrency";

const RUN = `${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;
let seq = 0;
const nextId = (kind: string) => `admexp${kind}${RUN}${(seq += 1)}`;
const HOUR = 3_600_000;
const inHours = (h: number) => new Date(Date.now() + h * HOUR).toISOString();
const ONE_PENDING_INDEX = "idx_admissions_offers_one_pending";

let baselineEventId = 0;

async function seedAgent(): Promise<string> {
  const id = nextId("agent");
  await pgPool().query(
    `INSERT INTO agents (id, name, description, api_key, points, follower_count, is_claimed, created_at, is_vetted)
     VALUES ($1, $1, '', $2, 0, 0, false, NOW(), true)`,
    [id, `admexpkey${id}`]
  );
  return id;
}

async function seedCycle(): Promise<string> {
  const id = nextId("cycle");
  await pgPool().query(
    `INSERT INTO admissions_cycles (id, name, opens_at, closes_at, target_size, max_offers, status, diversity_notes)
     VALUES ($1, 'expiry cycle', NOW(), NULL, 500, NULL, 'open', '')`,
    [id]
  );
  return id;
}

/** An agent with an application already in the `offered` state — production's shape once an offer exists. */
async function seedOfferedApp(cycleId: string): Promise<{ agent: string; app: string }> {
  const agent = await seedAgent();
  const app = nextId("app");
  await pgPool().query(
    `INSERT INTO admissions_applications (id, agent_id, cycle_id, state) VALUES ($1, $2, $3, 'offered')`,
    [app, agent, cycleId]
  );
  return { agent, app };
}

async function insertOffer(
  agent: string,
  cycle: string,
  app: string,
  status: string,
  expiresAtIso: string
): Promise<string> {
  const id = nextId("offer");
  await pgPool().query(
    `INSERT INTO admissions_offers (id, agent_id, cycle_id, application_id, status, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [id, agent, cycle, app, status, expiresAtIso]
  );
  return id;
}

async function offerStatus(offerId: string): Promise<string> {
  const { rows } = await pgPool().query(`SELECT status FROM admissions_offers WHERE id = $1`, [offerId]);
  return rows[0]?.status;
}

async function appState(appId: string): Promise<string> {
  const { rows } = await pgPool().query(`SELECT state FROM admissions_applications WHERE id = $1`, [appId]);
  return rows[0]?.state;
}

async function expiredEventsFor(offerId: string): Promise<Array<Record<string, unknown>>> {
  return eventsForKind("admissions.offer_expired", offerId);
}

async function eventsForKind(kind: string, subjectId: string): Promise<Array<Record<string, unknown>>> {
  const { rows } = await pgPool().query(
    `SELECT actor_agent_id, subject_type, subject_id, secondary_subject_id, payload
       FROM events
      WHERE id > $1 AND kind = $2 AND subject_id = $3 ORDER BY id`,
    [baselineEventId, kind, subjectId]
  );
  return rows;
}

/** Poll until some backend is blocked by `pid` (a third connection reports it), or time out. */
async function waitForBlockedBy(pid: number, timeoutMs = 5000): Promise<Array<{ pid: number; query: string }>> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const waiters = await waitersOn(pid);
    if (waiters.length > 0) return waiters;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return [];
}

/** Fail every event insert of one kind, so the mutation's own rollback can be observed. */
async function withEventFailure<T>(kind: string, run: () => Promise<T>): Promise<T> {
  const suffix = `${RUN}_${++seq}`;
  const functionName = `admexp_fail_${suffix}`;
  const triggerName = `admexp_fail_trigger_${suffix}`;
  await pgPool().query(`
    CREATE OR REPLACE FUNCTION ${functionName}() RETURNS trigger LANGUAGE plpgsql AS $fn$
    BEGIN
      IF NEW.kind = '${kind}' THEN RAISE EXCEPTION 'admexp injected ${kind} failure'; END IF;
      RETURN NEW;
    END; $fn$;
  `);
  await pgPool().query(
    `CREATE TRIGGER ${triggerName} AFTER INSERT ON events FOR EACH ROW EXECUTE FUNCTION ${functionName}()`
  );
  try {
    return await run();
  } finally {
    await pgPool().query(`DROP TRIGGER IF EXISTS ${triggerName} ON events`);
    await pgPool().query(`DROP FUNCTION IF EXISTS ${functionName}()`);
  }
}

beforeEach(async () => {
  const { rows } = await pgPool().query(`SELECT COALESCE(MAX(id), 0)::bigint AS id FROM events`);
  baselineEventId = Number(rows[0].id);
});

afterAll(async () => {
  await pgPool().query(`DELETE FROM admissions_audit WHERE agent_id LIKE $1`, [`admexpagent${RUN}%`]);
  await pgPool().query(`DELETE FROM events WHERE subject_id LIKE $1`, [`admexpoffer${RUN}%`]);
  await pgPool().query(`DELETE FROM admissions_offers WHERE agent_id LIKE $1`, [`admexpagent${RUN}%`]);
  await pgPool().query(`DELETE FROM admissions_applications WHERE agent_id LIKE $1`, [`admexpagent${RUN}%`]);
  await pgPool().query(`DELETE FROM admissions_cycles WHERE id LIKE $1`, [`admexpcycle${RUN}%`]);
  await pgPool().query(`DELETE FROM agents WHERE id LIKE $1`, [`admexpagent${RUN}%`]);
  await closeIntegrationConnections();
});

describe("runAdmissionsExpiryDuty (db mode)", () => {
  it("expires a past-due offer, returns its application to the pool, and emits offer_expired atomically", async () => {
    const cycle = await seedCycle();
    const { agent, app } = await seedOfferedApp(cycle);
    const offer = await insertOffer(agent, cycle, app, "pending", inHours(-1));

    await runAdmissionsExpiryDuty();

    expect(await offerStatus(offer)).toBe("expired");
    expect(await appState(app)).toBe("in_pool");
    const events = await expiredEventsFor(offer);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      actor_agent_id: null,
      subject_type: "admissions_offer",
      subject_id: offer,
      secondary_subject_id: app,
      payload: {},
    });
  });

  it("rolls the whole sweep back when the offer_expired event cannot be written", async () => {
    const cycle = await seedCycle();
    const { agent, app } = await seedOfferedApp(cycle);
    const offer = await insertOffer(agent, cycle, app, "pending", inHours(-1));

    await withEventFailure("admissions.offer_expired", async () => {
      await expect(runAdmissionsExpiryDuty()).rejects.toThrow(/injected/);
    });

    // The offer transition and the release are gated on the same statement as the event, so both
    // rolled back: nothing moved and nothing was emitted.
    expect(await offerStatus(offer)).toBe("pending");
    expect(await appState(app)).toBe("offered");
    expect(await expiredEventsFor(offer)).toEqual([]);
  });

  it("a plain status read does NOT expire a past-due offer, and writes nothing", async () => {
    const cycle = await seedCycle();
    const { agent, app } = await seedOfferedApp(cycle);
    const offer = await insertOffer(agent, cycle, app, "pending", inHours(-1));

    await getAdmissionsStatusForAgent(agent);

    expect(await offerStatus(offer)).toBe("pending");
    expect(await appState(app)).toBe("offered");
    expect(await expiredEventsFor(offer)).toEqual([]);
  });

  it("does NOT release an application that still carries a live offer", async () => {
    // Two pending offers on one application is a pre-D6 corruption; the unique index normally
    // forbids it, so it is dropped to reconstruct the state. The sweep must expire the lapsed offer
    // but leave the application `offered`, because a LIVE offer still stands against it.
    await pgPool().query(`DROP INDEX IF EXISTS ${ONE_PENDING_INDEX}`);
    try {
      const cycle = await seedCycle();
      const { agent, app } = await seedOfferedApp(cycle);
      const stale = await insertOffer(agent, cycle, app, "pending", inHours(-1));
      const live = await insertOffer(agent, cycle, app, "pending", inHours(48));

      await runAdmissionsExpiryDuty();

      expect(await offerStatus(stale)).toBe("expired");
      expect(await offerStatus(live)).toBe("pending");
      // The application is NOT released: a live offer still stands.
      expect(await appState(app)).toBe("offered");
      expect(await expiredEventsFor(stale)).toHaveLength(1);
    } finally {
      await pgPool().query(
        `CREATE UNIQUE INDEX IF NOT EXISTS ${ONE_PENDING_INDEX} ON admissions_offers (agent_id) WHERE status = 'pending'`
      );
    }
  });
});

/**
 * R2-4 — the expiry sweep raced against a real withdrawal, on two connections.
 *
 * The prior expiry suite only ran the sweep alone, so "it executed" was standing in for "B1's
 * agents-first order holds". This forces the exact concurrent window: the sweep is mid-statement,
 * holding the agent it took FIRST (B1's `sweep_agents FOR KEY SHARE`) and blocked on a held offer,
 * while a `deleteAgent` of that same agent is launched. Under B1 the withdrawal's `DELETE FROM
 * agents` must QUEUE BEHIND the sweep's agent lock — a linear wait chain with no cycle. Without
 * agents-first, the sweep would hold no agent lock and the withdrawal would instead block on the
 * CONTROLLER, never on the sweep — which the `blocked by the sweep` assertion below detects.
 */
describe("runAdmissionsExpiryDuty vs deleteAgent — B1 agents-first lock order", () => {
  it("the withdrawal queues behind the sweep's agent lock and neither deadlocks", async () => {
    const cycle = await seedCycle();
    const { agent, app } = await seedOfferedApp(cycle);
    const offer = await insertOffer(agent, cycle, app, "pending", inHours(-1)); // past-due

    const holder = await pgClient();
    let sweep: Promise<void> | null = null;
    let withdrawal: Promise<DeleteAgentResult> | null = null;
    try {
      const holderPid = await pidOf(holder);
      await holder.query("BEGIN");
      // Hold the offer row. The sweep, having taken the agent FOR KEY SHARE first (B1), blocks HERE.
      await holder.query(`SELECT id FROM admissions_offers WHERE id = $1 FOR UPDATE`, [offer]);

      sweep = runAdmissionsExpiryDuty();
      sweep.catch(() => {}); // no unhandled rejection while we poll
      expect(await waitForWaiter(holderPid, "adm:expiry-sweep")).toBe(true);

      // The sweep now holds the agent FOR KEY SHARE. The withdrawal must block ON THE SWEEP.
      const sweepPid = (await waitersOn(holderPid, "adm:expiry-sweep"))[0]!.pid;
      withdrawal = deleteAgent(agent);
      withdrawal.catch(() => {});
      const blockedBySweep = await waitForBlockedBy(sweepPid);
      // This is the whole of B1: the withdrawal is queued behind the sweep's agent lock, not behind
      // the controller. Zero here means the sweep never took the agent first.
      expect(blockedBySweep.length).toBeGreaterThan(0);
    } finally {
      await holder.query("COMMIT").catch(() => {});
      await holder.end();
    }

    // Both finish, and NEITHER 40P01s — the chain (withdrawal → sweep → holder) has no cycle.
    const outcomes = await runConcurrently<void | DeleteAgentResult>([() => sweep!, () => withdrawal!]);
    expect(rejections(outcomes)).toEqual([]);

    // The sweep won the agent lock and ran first: it emitted before the withdrawal cascaded the rows
    // away.
    expect(await expiredEventsFor(offer)).toHaveLength(1);
    // The withdrawal then ran: the agent and its cascaded application/offer are gone.
    expect(outcomes[1]).toMatchObject({ ok: true, value: { ok: true } });
    const { rows } = await pgPool().query(`SELECT id FROM agents WHERE id = $1`, [agent]);
    expect(rows).toHaveLength(0);
  });
});

/**
 * R2-4 — every db producer's mutation and its event commit together, so an injected event-insert
 * failure rolls the mutation back. The expiry sweep already proved this; these cover the other three
 * admissions producers.
 */
describe("db event-insert failure rolls the producer back", () => {
  const submitEvent = (agentId: string): PreparedEvent<"admissions.application_submitted"> => ({
    kind: "admissions.application_submitted",
    actorAgentId: agentId,
    subjectType: "admissions_application",
    subjectId: STORE_ASSIGNED_PAYLOAD_ID,
    payload: { lazy: false },
  });

  it("application creation: application_submitted failure leaves no application and no event", async () => {
    const cycle = await seedCycle();
    const agent = await seedAgent();

    await withEventFailure("admissions.application_submitted", async () => {
      await expect(ensureApplicationInPool(agent, cycle, [submitEvent(agent)])).rejects.toThrow(/injected/);
    });

    expect(await getApplicationByAgentCycle(agent, cycle)).toBeNull();
    const { rows } = await pgPool().query(
      `SELECT id FROM events WHERE id > $1 AND kind = 'admissions.application_submitted' AND actor_agent_id = $2`,
      [baselineEventId, agent]
    );
    expect(rows).toHaveLength(0);
  });

  it("acceptance: offer_accepted failure leaves the offer pending, unaccepted, and the agent not admitted", async () => {
    const cycle = await seedCycle();
    const { agent, app } = await seedOfferedApp(cycle);
    const offer = await insertOffer(agent, cycle, app, "pending", inHours(48)); // live
    const acceptEvent: PreparedEvent<"admissions.offer_accepted"> = {
      kind: "admissions.offer_accepted", actorAgentId: agent, subjectType: "admissions_offer",
      subjectId: offer, secondarySubjectId: app, payload: {},
    };

    await withEventFailure("admissions.offer_accepted", async () => {
      await expect(acceptOfferAsAgent(offer, agent, [acceptEvent])).rejects.toThrow(/injected/);
    });

    expect(await offerStatus(offer)).toBe("pending");
    const { rows: offerRows } = await pgPool().query(
      `SELECT accepted_at_agent FROM admissions_offers WHERE id = $1`,
      [offer]
    );
    expect(offerRows[0].accepted_at_agent).toBeNull();
    expect(await appState(app)).toBe("offered"); // the finalize's app transition rolled back too
    const { rows: agentRows } = await pgPool().query(`SELECT is_admitted FROM agents WHERE id = $1`, [agent]);
    expect(agentRows[0].is_admitted).toBe(false); // the finalize's admit rolled back too
    const { rows: audit } = await pgPool().query(
      `SELECT id FROM admissions_audit WHERE offer_id = $1 AND action = 'accept_agent'`,
      [offer]
    );
    expect(audit).toHaveLength(0);
    expect(await eventsForKind("admissions.offer_accepted", offer)).toEqual([]);
  });

  it("decline: offer_declined failure leaves the offer pending and the application offered", async () => {
    const cycle = await seedCycle();
    const { agent, app } = await seedOfferedApp(cycle);
    const offer = await insertOffer(agent, cycle, app, "pending", inHours(48)); // live
    const declineEvent: PreparedEvent<"admissions.offer_declined"> = {
      kind: "admissions.offer_declined", actorAgentId: agent, subjectType: "admissions_offer",
      subjectId: offer, secondarySubjectId: app, payload: {},
    };

    await withEventFailure("admissions.offer_declined", async () => {
      await expect(declineOfferAsAgent(offer, agent, [declineEvent])).rejects.toThrow(/injected/);
    });

    expect(await offerStatus(offer)).toBe("pending");
    expect(await appState(app)).toBe("offered");
    const { rows: audit } = await pgPool().query(
      `SELECT id FROM admissions_audit WHERE offer_id = $1 AND action = 'decline'`,
      [offer]
    );
    expect(audit).toHaveLength(0);
    expect(await eventsForKind("admissions.offer_declined", offer)).toEqual([]);
  });
});

/**
 * R2-3 — the niche edit is ONE conditional UPDATE whose `state NOT IN ('rejected','admitted')`
 * predicate is the authoritative editability gate. A decided application matches zero rows and is
 * left untouched, so a staff decision that lands after the action's pre-read cannot be overwritten.
 */
describe("updateApplicationNiche (db) — decided applications are not editable", () => {
  async function seedApp(cycle: string, state: string, primaryDomain: string | null): Promise<string> {
    const agent = await seedAgent();
    const appId = nextId("app");
    await pgPool().query(
      `INSERT INTO admissions_applications (id, agent_id, cycle_id, state, primary_domain) VALUES ($1,$2,$3,$4,$5)`,
      [appId, agent, cycle, state, primaryDomain]
    );
    return appId;
  }

  it("edits an OPEN application and returns the updated row", async () => {
    const cycle = await seedCycle();
    const appId = await seedApp(cycle, "in_pool", null);

    const updated = await updateApplicationNiche(appId, { primaryDomain: "robotics" });
    expect(updated).not.toBeNull();
    expect(updated!.primaryDomain).toBe("robotics");
  });

  it("refuses a REJECTED application and writes nothing", async () => {
    const cycle = await seedCycle();
    const appId = await seedApp(cycle, "rejected", "orig");

    const updated = await updateApplicationNiche(appId, { primaryDomain: "robotics" });
    expect(updated).toBeNull();
    const { rows } = await pgPool().query(`SELECT primary_domain FROM admissions_applications WHERE id = $1`, [appId]);
    expect(rows[0].primary_domain).toBe("orig");
  });

  it("refuses an ADMITTED application and writes nothing", async () => {
    const cycle = await seedCycle();
    const appId = await seedApp(cycle, "admitted", "orig");

    const updated = await updateApplicationNiche(appId, { primaryDomain: "robotics" });
    expect(updated).toBeNull();
    const { rows } = await pgPool().query(`SELECT primary_domain FROM admissions_applications WHERE id = $1`, [appId]);
    expect(rows[0].primary_domain).toBe("orig");
  });
});
