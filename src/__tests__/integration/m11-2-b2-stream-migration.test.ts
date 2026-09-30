/**
 * M11-2 b2 lane S (P5.2) — `migrate-m11-stream.sql` + `reconcile-stream-seq.sql` through the REAL
 * reserved DB.
 *
 * The harness bootstrap (`scripts/integration/prepare.js`) already ran `scripts/migrate.js` for
 * real before this file loaded, so the schema assertions below check the ACTUAL applied shape
 * rather than a scratch copy. The idempotency and reconciliation checks then execute the raw SQL
 * text a second time via the shared `pg` pool — a recovery re-run against a live database is
 * exactly what "idempotent" has to survive, so that is what is exercised here.
 *
 * `contract-stream-seq-not-null.sql` is NOT executed: it sets `agent_wakeups.stream_seq NOT NULL`
 * on the shared reserved DB, and no producer writes that column yet in this deploy (that lands in
 * a later chunk, gated on `ai/m11-2-handoff/b1-fixes-landed.md` per the lane spec) — every other
 * lane's concurrently-running wakeup fixtures still insert NULL there. It is reviewed statically.
 */
import { readFileSync } from "fs";
import { join } from "path";
import { pgPool, closeIntegrationConnections } from "./helpers/db";
import { createAgent } from "@/lib/store/agents/db";

const SCRIPTS = join(__dirname, "..", "..", "..", "scripts");
const MIGRATION_SQL = readFileSync(join(SCRIPTS, "migrate-m11-stream.sql"), "utf8");
const RECONCILE_SQL = readFileSync(join(SCRIPTS, "reconcile-stream-seq.sql"), "utf8");

const RUN = `${Date.now().toString(36)}_${Math.floor(Math.random() * 1e6).toString(36)}`;

async function columnShape(table: string, column: string) {
  const { rows } = await pgPool().query(
    `SELECT data_type, is_nullable FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = $1 AND column_name = $2`,
    [table, column]
  );
  return rows[0] ?? null;
}

let wakeupSeq = 0;

// `idx_wakeups_dedup_idle` allows only one pending event-less row per (agent, reason), so each
// fixture row gets its own reason — the fixture's identity, not a real wakeup reason.
async function insertWakeup(agentId: string, streamSeq: number | null = null): Promise<number> {
  wakeupSeq += 1;
  const { rows } = await pgPool().query(
    `INSERT INTO agent_wakeups (agent_id, reason, payload, delivery, stream_seq)
     VALUES ($1, $2, '{}'::jsonb, 'internal', $3)
     RETURNING id`,
    [agentId, `b2_fixture_${RUN}_${wakeupSeq}`, streamSeq]
  );
  return Number(rows[0].id);
}

async function streamSeqOf(id: number): Promise<number | null> {
  const { rows } = await pgPool().query(`SELECT stream_seq FROM agent_wakeups WHERE id = $1`, [id]);
  return rows[0]?.stream_seq === null || rows[0]?.stream_seq === undefined ? null : Number(rows[0].stream_seq);
}

async function counterOf(agentId: string): Promise<number | null> {
  const { rows } = await pgPool().query(`SELECT last_seq FROM agent_stream_counters WHERE agent_id = $1`, [
    agentId,
  ]);
  return rows[0] ? Number(rows[0].last_seq) : null;
}

afterAll(async () => {
  await closeIntegrationConnections();
});

describe("migrate-m11-stream.sql — schema, as actually applied", () => {
  it("creates agent_stream_counters with the documented shape", async () => {
    expect(await columnShape("agent_stream_counters", "agent_id")).toEqual({
      data_type: "text",
      is_nullable: "NO",
    });
    expect(await columnShape("agent_stream_counters", "last_seq")).toEqual({
      data_type: "bigint",
      is_nullable: "NO",
    });
  });

  it("creates stream_frames with the documented shape", async () => {
    expect(await columnShape("stream_frames", "id")).toEqual({ data_type: "bigint", is_nullable: "NO" });
    expect(await columnShape("stream_frames", "agent_id")).toEqual({ data_type: "text", is_nullable: "YES" });
    expect(await columnShape("stream_frames", "frame")).toEqual({ data_type: "text", is_nullable: "NO" });
    expect(await columnShape("stream_frames", "ref_id")).toEqual({ data_type: "text", is_nullable: "NO" });
    expect(await columnShape("stream_frames", "frame_key")).toEqual({ data_type: "text", is_nullable: "NO" });
    expect(await columnShape("stream_frames", "created_at")).toEqual({
      data_type: "timestamp with time zone",
      is_nullable: "NO",
    });
  });

  it("adds agent_wakeups.stream_seq, nullable — the expand step; contract lands in a later runbook step", async () => {
    expect(await columnShape("agent_wakeups", "stream_seq")).toEqual({ data_type: "bigint", is_nullable: "YES" });
  });
});

describe("migrate-m11-stream.sql — idempotent re-run", () => {
  it("backfills fresh NULL rows once; a second run changes nothing already assigned", async () => {
    const agent = await createAgent(`m112b2stream_${RUN}`, "b2 stream migration fixture");
    const rowA = await insertWakeup(agent.id);
    const rowB = await insertWakeup(agent.id);

    // First execution against these fresh rows: the harness bootstrap ran the file before these
    // rows existed, so this is their actual backfill (id order within the agent's partition).
    await pgPool().query(MIGRATION_SQL);
    const seqA1 = await streamSeqOf(rowA);
    const seqB1 = await streamSeqOf(rowB);
    const counter1 = await counterOf(agent.id);
    expect(seqA1).not.toBeNull();
    expect(seqB1).toBe((seqA1 as number) + 1);
    expect(counter1).toBe(seqB1);

    // Second execution: nothing left NULL for this agent, so its seqs and counter must not move.
    await pgPool().query(MIGRATION_SQL);
    expect(await streamSeqOf(rowA)).toBe(seqA1);
    expect(await streamSeqOf(rowB)).toBe(seqB1);
    expect(await counterOf(agent.id)).toBe(counter1);
  });
});

describe("reconcile-stream-seq.sql", () => {
  it("assigns a NULL-seq row (an old-version producer's insert) a valid seq and advances the counter", async () => {
    const agent = await createAgent(`m112b2reconcile_${RUN}`, "b2 reconcile fixture");
    // Seed the counter as the expand-step migration would have, from one already-assigned row.
    const seeded = await insertWakeup(agent.id, 5);
    await pgPool().query(
      `INSERT INTO agent_stream_counters (agent_id, last_seq) VALUES ($1, 5)
       ON CONFLICT (agent_id) DO UPDATE SET last_seq = GREATEST(agent_stream_counters.last_seq, EXCLUDED.last_seq)`,
      [agent.id]
    );

    // Simulate an old-version producer's insert during the mixed-version window: no stream_seq.
    const strayA = await insertWakeup(agent.id, null);
    const strayB = await insertWakeup(agent.id, null);

    await pgPool().query(RECONCILE_SQL);

    expect(await streamSeqOf(seeded)).toBe(5); // untouched — it already had a seq
    expect(await streamSeqOf(strayA)).toBe(6); // next after the counter's prior value, id order
    expect(await streamSeqOf(strayB)).toBe(7);
    expect(await counterOf(agent.id)).toBe(7);

    // Re-run: nothing left NULL for this agent, so it is a no-op.
    await pgPool().query(RECONCILE_SQL);
    expect(await streamSeqOf(strayA)).toBe(6);
    expect(await streamSeqOf(strayB)).toBe(7);
    expect(await counterOf(agent.id)).toBe(7);
  });
});

// `contract-stream-seq-not-null.sql` sets a NOT NULL constraint on the SHARED reserved DB's
// `agent_wakeups` table — running it here would break every other lane's concurrently-running
// wakeup fixtures, which still insert NULL (no producer writes stream_seq until a later chunk).
// Reviewed statically instead: it is one guarded ALTER, idempotent by Postgres's own semantics.
describe.skip("contract-stream-seq-not-null.sql (reviewed statically, not run against the shared DB)", () => {
  it("intentionally not executed here", () => {});
});
