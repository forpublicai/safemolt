/**
 * M11-2 u1 `[integration]` — the emit primitives against the real database.
 *
 * What only a database can show, and what this file is for:
 *  - `emitEventStatement` renders a fragment that COMPOSES: the placeholders it emits must line up
 *    behind the caller's own parameters inside one real statement;
 *  - the coupling is causal, not merely atomic — the same statement raced to zero decisive rows
 *    writes no event (the no-ghost-events check every domain chunk reuses);
 *  - db and memory answer the same cursor questions the same way, which is what lets Jest's
 *    memory-mode suites stand in for production semantics.
 */
import { closeIntegrationConnections, neonSql, pgPool } from "./helpers/db";
import { expectNoGhostEvent, runCoupledMutation } from "./helpers/causal-coupling";
import { emitEvent, getEventById, listEventsAfter } from "@/lib/store/events/db";
import * as memory from "@/lib/store/events/memory";
import { eventLog } from "@/lib/store/_memory-state";
import type { PreparedEvent } from "@/lib/events/kinds";
import type { StoredEvent } from "@/lib/store-types";

const RUN = `${Date.now().toString(36)}_${Math.floor(Math.random() * 1e6).toString(36)}`;
let seq = 0;
const nextId = (kind: string) => `u1e_${kind}_${RUN}_${(seq += 1)}`;

/** Every event this file writes lands above this id, so cleanup needs no marker column. */
let baselineEventId = 0;

const fence = (consumer: string): PreparedEvent<"system.activation_fence"> => ({
  kind: "system.activation_fence",
  payload: { consumer },
});

async function seedAgent(): Promise<string> {
  const id = nextId("agent");
  await pgPool().query(
    `INSERT INTO agents (id, name, description, api_key, points, vote_points, evaluation_points,
                         legacy_unattributed_points, follower_count, is_claimed, created_at, is_vetted)
     VALUES ($1, $1, '', $2, 0, 0, 0, 0, 0, false, NOW(), true)`,
    [id, `u1e_key_${id}`]
  );
  return id;
}

async function maxEventId(): Promise<number> {
  const { rows } = await pgPool().query(`SELECT COALESCE(max(id), 0) AS id FROM events`);
  return Number(rows[0].id);
}

/** Compare two logs by everything except the ids and timestamps the two modes cannot share. */
function shapeOf(events: StoredEvent[]) {
  return events.map((event) => ({
    kind: event.kind,
    actorAgentId: event.actorAgentId,
    subjectType: event.subjectType,
    subjectId: event.subjectId,
    secondarySubjectId: event.secondarySubjectId,
    schoolId: event.schoolId,
    idemKey: event.idemKey,
    payload: event.payload,
  }));
}

beforeAll(async () => {
  baselineEventId = await maxEventId();
});

afterAll(async () => {
  await pgPool().query(`DELETE FROM events WHERE id > $1`, [baselineEventId]);
  await pgPool().query(`DELETE FROM agents WHERE id LIKE $1`, [`u1e_agent_${RUN}%`]);
  eventLog.rows.length = 0;
  eventLog.nextId = 1;
  await closeIntegrationConnections();
});

describe("emit primitives", () => {
  it("writes every column and reads it back", async () => {
    const actor = await seedAgent();
    const { id } = await emitEvent({
      kind: "system.activation_fence",
      actorAgentId: actor,
      subjectType: "consumer",
      subjectId: "notifications",
      secondarySubjectId: "second",
      schoolId: "safemolt",
      idemKey: nextId("idem"),
      payload: { consumer: "notifications" },
    });

    expect(await getEventById(id)).toMatchObject({
      id,
      kind: "system.activation_fence",
      actorAgentId: actor,
      subjectType: "consumer",
      subjectId: "notifications",
      secondarySubjectId: "second",
      schoolId: "safemolt",
      payload: { consumer: "notifications" },
    });
    // JSONB, not a quoted JSON string: the payload has to come back as an object or every consumer
    // reads `payload.x` off a string.
    expect(typeof (await getEventById(id))?.payload).toBe("object");
  });

  it("returns null for an id that does not exist", async () => {
    expect(await getEventById(baselineEventId + 10_000_000)).toBeNull();
  });

  /**
   * `idem_key` is the deterministic domain key some producers stamp (playground actions). The
   * partial unique index is what makes a retried producer idempotent, and it must NOT collapse the
   * overwhelmingly common NULL case.
   */
  it("rejects a duplicate idem_key and admits any number of NULL ones", async () => {
    const key = nextId("idem");
    await emitEvent({ kind: "system.activation_fence", idemKey: key, payload: { consumer: "a" } });
    await expect(
      emitEvent({ kind: "system.activation_fence", idemKey: key, payload: { consumer: "b" } })
    ).rejects.toThrow();

    await emitEvent(fence("null-key-1"));
    await emitEvent(fence("null-key-2"));
  });

  it("refuses a kind this build does not know, before writing anything", async () => {
    const before = await maxEventId();
    // A kind that enters the union with its own consumer coverage in a LATER train. Emitting one
    // this build cannot describe would wedge every consumer's scan floor at that id, because a
    // drain skips an unknown kind without a receipt.
    await expect(
      emitEvent({ kind: "playground.round_opened" as never, payload: {} as never })
    ).rejects.toThrow(/unknown kind/);
    expect(await maxEventId()).toBe(before);
  });
});

describe("cursor parity between db and memory", () => {
  it("answers listEventsAfter identically in both modes", async () => {
    const cursor = await maxEventId();
    eventLog.rows.length = 0;
    eventLog.nextId = 1;

    const prepared = [fence("one"), fence("two"), fence("three")];
    for (const event of prepared) {
      await emitEvent(event);
      await memory.emitEvent(event);
    }

    const fromDb = await listEventsAfter(cursor);
    const fromMemory = await memory.listEventsAfter(0);

    expect(shapeOf(fromDb)).toEqual(shapeOf(fromMemory));
    // Ordered by id in both, and the cursor is exclusive in both.
    expect(fromDb.map((e) => e.id)).toEqual([...fromDb.map((e) => e.id)].sort((a, b) => a - b));
    expect((await listEventsAfter(fromDb[0].id)).map((e) => e.kind)).toEqual(
      (await memory.listEventsAfter(fromMemory[0].id)).map((e) => e.kind)
    );

    // Same kind filter, same limit, same answer.
    expect(shapeOf(await listEventsAfter(cursor, ["system.activation_fence"], 2))).toEqual(
      shapeOf(await memory.listEventsAfter(0, ["system.activation_fence"], 2))
    );
    expect(await listEventsAfter(cursor, ["post.created"])).toEqual([]);
    expect(await memory.listEventsAfter(0, ["post.created"])).toEqual([]);
  });

  /**
   * `idem_key` is a deterministic producer key, and its whole value is that the SECOND write is
   * refused. Memory mode used to append the duplicate happily, so a retry that is idempotent in
   * production silently doubled in Jest — the exact divergence the dual store exists to prevent.
   * NULL keys stay unconstrained on both sides, which is what the partial index buys.
   */
  it("refuses a duplicate idem_key in both modes, and admits any number of NULL ones in both", async () => {
    eventLog.rows.length = 0;
    eventLog.nextId = 1;
    const key = nextId("idem");
    const withKey = { kind: "system.activation_fence" as const, idemKey: key, payload: { consumer: "k" } };

    await emitEvent(withKey);
    await memory.emitEvent(withKey);

    await expect(emitEvent(withKey)).rejects.toMatchObject({ code: "23505" });
    await expect(memory.emitEvent(withKey)).rejects.toMatchObject({ code: "23505" });

    const dbCount = await pgPool().query(`SELECT count(*)::int AS c FROM events WHERE idem_key = $1`, [key]);
    expect(dbCount.rows[0].c).toBe(1);
    expect(eventLog.rows.filter((event) => event.idemKey === key)).toHaveLength(1);

    await emitEvent(fence("null-a"));
    await emitEvent(fence("null-b"));
    await memory.emitEvent(fence("null-a"));
    await memory.emitEvent(fence("null-b"));
    expect(eventLog.rows.filter((event) => event.idemKey === null)).toHaveLength(2);
  });
});

describe("causal coupling (Decision 2)", () => {
  it("emits exactly one event when the decisive mutation matched", async () => {
    const agent = await seedAgent();
    const ids = await runCoupledMutation({
      decisiveSql: `UPDATE agents SET description = 'coupled' WHERE id = $1 AND description = '' RETURNING id`,
      decisiveParams: [agent],
      event: fence("coupled"),
    });

    expect(ids).toHaveLength(1);
    expect(await getEventById(ids[0])).toMatchObject({ payload: { consumer: "coupled" } });
    const { rows } = await pgPool().query(`SELECT description FROM agents WHERE id = $1`, [agent]);
    expect(rows[0].description).toBe("coupled");
  });

  /**
   * The ghost check. The mutation is well-formed and simply matches nothing — the shape a
   * concurrent racer produces when it gets there first (already deleted, already voted, already
   * left). A free-standing insert beside this statement would still write the event.
   */
  it("emits NOTHING when the decisive mutation matched zero rows", async () => {
    await expectNoGhostEvent({
      decisiveSql: `UPDATE agents SET description = 'coupled' WHERE id = $1 RETURNING id`,
      decisiveParams: [`u1e_absent_${RUN}`],
      event: fence("ghost"),
    });
  });

  /** A mutation that changed several rows still emits ONE event, gated on the whole of it. */
  it("emits one event for a multi-row mutation, and none when it matched nothing", async () => {
    const first = await seedAgent();
    const second = await seedAgent();

    const ids = await runCoupledMutation({
      decisiveSql: `UPDATE agents SET description = 'multi-row' WHERE id = ANY($1::text[]) RETURNING id`,
      decisiveParams: [[first, second]],
      event: fence("multi-row"),
    });
    expect(ids).toHaveLength(1);

    await expectNoGhostEvent({
      decisiveSql: `UPDATE agents SET description = 'multi-row' WHERE id = ANY($1::text[]) RETURNING id`,
      decisiveParams: [[`u1e_absent_${RUN}`]],
      event: fence("multi-row"),
    });
  });

  /**
   * The fragment is plumbing for producers that already have parameters of their own, so its
   * placeholders must start where the caller says. An off-by-one here would silently bind the
   * caller's values into the event row.
   */
  it("offsets its placeholders behind the caller's parameters", async () => {
    const agent = await seedAgent();
    const ids = await runCoupledMutation({
      decisiveSql: `UPDATE agents SET description = $2 WHERE id = $1 RETURNING id`,
      decisiveParams: [agent, "two-params"],
      event: { kind: "system.activation_fence", subjectId: "offset-check", payload: { consumer: "offset" } },
    });

    expect(await getEventById(ids[0])).toMatchObject({
      subjectId: "offset-check",
      payload: { consumer: "offset" },
    });
  });

  it("refuses a CTE name that is not an identifier", async () => {
    await expect(
      runCoupledMutation({
        // The renderer interpolates the CTE name as an identifier, so the shape is enforced rather
        // than trusted — "callers are in-repo today" is not a property it can check later.
        decisiveSql: `SELECT 1`,
        event: fence("x"),
      })
    ).resolves.toBeDefined();

    const { emitEventStatement } = await import("@/lib/store/events/statement");
    expect(() => emitEventStatement(fence("x"), "decisive; DROP TABLE events")).toThrow(/usable CTE name/);
  });

  it("is visible through the neon driver the application actually runs", async () => {
    const rows = await neonSql()(`SELECT count(*)::int AS c FROM events WHERE id > $1`, [baselineEventId]);
    expect((rows[0] as { c: number }).c).toBeGreaterThan(0);
  });
});
