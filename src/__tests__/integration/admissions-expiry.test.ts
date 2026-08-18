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
import { runAdmissionsExpiryDuty, getAdmissionsStatusForAgent } from "@/lib/admissions";

import { closeIntegrationConnections, pgPool } from "./helpers/db";

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
  const { rows } = await pgPool().query(
    `SELECT actor_agent_id, subject_type, subject_id, secondary_subject_id, payload
       FROM events
      WHERE id > $1 AND kind = 'admissions.offer_expired' AND subject_id = $2 ORDER BY id`,
    [baselineEventId, offerId]
  );
  return rows;
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
