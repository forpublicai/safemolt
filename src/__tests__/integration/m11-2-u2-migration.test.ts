/**
 * M11-2 u2 `[integration]` — `migrate-m11-consumers.sql` through the REAL runner.
 *
 * The migration is three small statements, and every one of them is a place a text-matching unit
 * test would pass while production broke:
 *
 *  - `ADD COLUMN IF NOT EXISTS` is a no-op against a pre-existing column of the WRONG type, so the
 *    postconditions are the only thing that catches a schema that arrived by some other route;
 *  - `CREATE UNIQUE INDEX` has to produce a **non-partial** index, because `ON CONFLICT (dedup_key)`
 *    cannot infer a partial one and every consumer insert would raise 42P10 instead of deduplicating
 *    — a property visible only in `pg_index`;
 *  - and a fresh database bootstrapped from `schema.sql` must reach the SAME catalog state as an
 *    older one upgraded by this file, or "it works on a new database" and "it works in production"
 *    stop meaning the same thing.
 *
 * Everything here runs against a scratch schema built to the PRE-u2 shape, so the assertions are
 * about what the migration does rather than about what the harness database already happens to be.
 */
import { readFileSync } from "fs";
import { join } from "path";
import { mkdtempSync, writeFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { closeIntegrationConnections, pgPool } from "./helpers/db";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { migrate } = require("../../../scripts/migrate.js");

const SCRIPTS = join(__dirname, "..", "..", "..", "scripts");
const MIGRATION_FILE = "migrate-m11-consumers.sql";
const MIGRATION_SQL = readFileSync(join(SCRIPTS, MIGRATION_FILE), "utf8");
const SCHEMA_SQL = readFileSync(join(SCRIPTS, "schema.sql"), "utf8");

const connectionString = process.env.POSTGRES_URL as string;
const RUN = `${Date.now().toString(36)}_${Math.floor(Math.random() * 1e6).toString(36)}`;
/** The upgrade path's scratch schema, and the fresh path's. Both dropped in `afterAll`. */
const UPGRADED = `u2m_upgraded_${RUN}`;
const FRESH = `u2m_fresh_${RUN}`;

let fixtureDir: string;

/**
 * The three tables the migration touches, in their PRE-u2 shape.
 *
 * Copied from `schema.sql` minus exactly what this migration adds — that omission is the point:
 * running the migration against a schema that already had the column would assert nothing.
 */
const PRE_U2_SHAPE = `
  CREATE TABLE activity_events (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    kind TEXT NOT NULL,
    occurred_at TIMESTAMPTZ NOT NULL,
    actor_id TEXT,
    entity_id TEXT NOT NULL,
    title TEXT NOT NULL,
    summary TEXT NOT NULL,
    metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
    UNIQUE (kind, entity_id)
  );
  CREATE TABLE notifications (
    id TEXT PRIMARY KEY,
    agent_id TEXT NOT NULL,
    type TEXT NOT NULL,
    priority TEXT NOT NULL DEFAULT 'normal',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    metadata JSONB NOT NULL DEFAULT '{}'::jsonb
  );
  -- An EARLIER shape of this file's own table, as a development database that applied a previous
  -- version already has it: per-recipient claim columns, which the event-level claim replaced. The
  -- migration must ALTER it — adding \`completed_at\`, dropping the claim columns — rather than
  -- silently no-op on a \`CREATE TABLE IF NOT EXISTS\` and leave the old shape in place.
  CREATE TABLE ingest_progress (
    event_id BIGINT NOT NULL,
    recipient_agent_id TEXT NOT NULL,
    claim_token TEXT,
    lease_expires_at TIMESTAMPTZ,
    PRIMARY KEY (event_id, recipient_agent_id)
  );
`;

async function withSchema(schema: string, sql: string): Promise<void> {
  await pgPool().query(`SET search_path TO ${schema}`);
  try {
    await pgPool().query(sql);
  } finally {
    await pgPool().query(`SET search_path TO public`);
  }
}

/** Column type and nullability, from the catalog rather than from the file that claimed it. */
async function columnShape(schema: string, table: string, column: string) {
  const { rows } = await pgPool().query(
    `SELECT data_type, is_nullable FROM information_schema.columns
     WHERE table_schema = $1 AND table_name = $2 AND column_name = $3`,
    [schema, table, column]
  );
  return rows[0] ?? null;
}

/** Every unique index on a table, with the two properties that decide whether it can be conflicted on. */
async function uniqueIndexes(schema: string, table: string) {
  const { rows } = await pgPool().query(
    `SELECT c.relname AS name,
            i.indisunique AS is_unique,
            (i.indpred IS NOT NULL) AS is_partial,
            pg_get_expr(i.indpred, i.indrelid) AS predicate,
            (SELECT array_agg(a.attname::text ORDER BY k.ord)
             FROM unnest(i.indkey) WITH ORDINALITY AS k(attnum, ord)
             JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = k.attnum) AS columns
     FROM pg_index i
     JOIN pg_class c ON c.oid = i.indexrelid
     WHERE i.indrelid = ($1 || '.' || $2)::regclass AND i.indisunique
     ORDER BY c.relname`,
    [schema, table]
  );
  return rows as Array<{
    name: string;
    is_unique: boolean;
    is_partial: boolean;
    predicate: string | null;
    columns: string[];
  }>;
}

/** A schema's tables and columns, for the upgrade-vs-fresh equivalence check. */
async function catalogShape(schema: string, tables: string[]) {
  const { rows } = await pgPool().query(
    `SELECT table_name, column_name, data_type, is_nullable
     FROM information_schema.columns
     WHERE table_schema = $1 AND table_name = ANY($2::text[])
     ORDER BY table_name, column_name`,
    [schema, tables]
  );
  return rows;
}

beforeAll(async () => {
  fixtureDir = mkdtempSync(join(tmpdir(), "u2m-"));
  await pgPool().query(`CREATE SCHEMA ${UPGRADED}`);
  await pgPool().query(`CREATE SCHEMA ${FRESH}`);
  await withSchema(UPGRADED, PRE_U2_SHAPE);
});

afterAll(async () => {
  await pgPool().query(`DROP SCHEMA IF EXISTS ${UPGRADED} CASCADE`);
  await pgPool().query(`DROP SCHEMA IF EXISTS ${FRESH} CASCADE`);
  rmSync(fixtureDir, { recursive: true, force: true });
  await closeIntegrationConnections();
});

/**
 * Run the migration through the real runner, in a scratch schema.
 *
 * The runner is used rather than a raw `query` for the same reason C1's suite uses it: the file runs
 * as one implicit transaction, records itself only on success, and the `DO $$ … $$` postcondition
 * blocks behave differently under a driver that splits statements. A fixture copy with a
 * `SET search_path` prologue is what points it at the scratch schema.
 */
async function runMigrationInSchema(schema: string, label: string): Promise<void> {
  const filename = `u2m_${label}_${RUN}.sql`;
  // The prologue points the file at the scratch schema; the epilogue puts the session back, because
  // the runner records the applied filename in `public._migrations` on the SAME connection.
  writeFileSync(
    join(fixtureDir, filename),
    `SET search_path TO ${schema}, public;\n${MIGRATION_SQL}\nSET search_path TO public;\n`
  );
  await migrate({
    files: [{ file: filename, label }],
    dir: fixtureDir,
    connectionString,
  });
}

describe("migrate-m11-consumers.sql", () => {
  it("upgrades a pre-u2 schema, and is idempotent when run again", async () => {
    await runMigrationInSchema(UPGRADED, "first");

    expect(await columnShape(UPGRADED, "activity_events", "source_event_id")).toEqual({
      data_type: "bigint",
      is_nullable: "YES",
    });
    expect(await columnShape(UPGRADED, "notifications", "dedup_key")).toEqual({
      data_type: "text",
      is_nullable: "YES",
    });
    expect(await columnShape(UPGRADED, "ingest_progress", "event_id")).toEqual({
      data_type: "bigint",
      is_nullable: "NO",
    });
    // `completed_at` nullable: NULL is "registered, not finished", which is what the outstanding
    // query tests for.
    expect(await columnShape(UPGRADED, "ingest_progress", "completed_at")).toEqual({
      data_type: "timestamp with time zone",
      is_nullable: "YES",
    });
    // And the per-recipient claim columns are GONE — the event-level claim replaced them, and a
    // database that kept them would let a reader believe recipients are individually owned.
    expect(await columnShape(UPGRADED, "ingest_progress", "claim_token")).toBeNull();
    expect(await columnShape(UPGRADED, "ingest_progress", "lease_expires_at")).toBeNull();

    // The fan-out claim table, both columns NOT NULL: a claim with no token cannot be fenced and one
    // with no lease can never be reclaimed, so neither is a representable state.
    expect(await columnShape(UPGRADED, "ingest_event_claims", "event_id")).toEqual({
      data_type: "bigint",
      is_nullable: "NO",
    });
    expect(await columnShape(UPGRADED, "ingest_event_claims", "claim_token")).toEqual({
      data_type: "text",
      is_nullable: "NO",
    });
    expect(await columnShape(UPGRADED, "ingest_event_claims", "lease_expires_at")).toEqual({
      data_type: "timestamp with time zone",
      is_nullable: "NO",
    });

    // Run number two. `migrate.js` skips a RECORDED filename without reading it, so the second run
    // uses a different fixture name — the guards inside the file are what must make it a no-op, not
    // the runner's bookkeeping. A `CREATE UNIQUE INDEX` without `IF NOT EXISTS` would raise here.
    await expect(runMigrationInSchema(UPGRADED, "second")).resolves.toBeUndefined();
    expect(await columnShape(UPGRADED, "activity_events", "source_event_id")).toEqual({
      data_type: "bigint",
      is_nullable: "YES",
    });
  });

  /**
   * The dedup index must be UNIQUE, on `dedup_key`, and **NOT partial**.
   *
   * Each half is load-bearing and none follows from the others: not unique ⇒ two drainers each write
   * the notification; wrong column ⇒ the deduplication is on something else; PARTIAL ⇒
   * `ON CONFLICT (dedup_key)` cannot infer the index and every consumer insert raises 42P10.
   */
  it("creates a FULL unique index on dedup_key, and Postgres admits many NULLs under it", async () => {
    const indexes = await uniqueIndexes(UPGRADED, "notifications");
    const dedup = indexes.find((row) => row.name === "idx_notifications_dedup");
    expect(dedup).toBeDefined();
    expect(dedup!.is_unique).toBe(true);
    expect(dedup!.is_partial).toBe(false);
    expect(dedup!.predicate).toBeNull();
    expect(dedup!.columns).toEqual(["dedup_key"]);

    // The behaviour the shape is for: many NULL keys coexist (every pre-u2 row), one keyed value
    // wins, and the second insert of that key is refused.
    await withSchema(
      UPGRADED,
      `INSERT INTO notifications (id, agent_id, type) VALUES
         ('n1', 'a', 'comment_on_my_post'), ('n2', 'a', 'comment_on_my_post')`
    );
    await withSchema(
      UPGRADED,
      `INSERT INTO notifications (id, agent_id, type, dedup_key)
       VALUES ('n3', 'a', 'comment_on_my_post', 'k')`
    );
    await expect(
      withSchema(
        UPGRADED,
        `INSERT INTO notifications (id, agent_id, type, dedup_key)
         VALUES ('n4', 'a', 'comment_on_my_post', 'k')`
      )
    ).rejects.toThrow(/duplicate key|unique/i);
  });

  /**
   * The upgrade path and the fresh path must agree.
   *
   * `schema.sql` carries all three shapes inline so a new database gets them without the migration;
   * this file carries them for databases that predate it. If the two ever diverge, every gate that
   * runs on a fresh harness database certifies a schema production does not have.
   */
  it("reaches the same catalog shape as a fresh schema.sql bootstrap", async () => {
    // The fresh path: `schema.sql` alone, no migration.
    await withSchema(FRESH, SCHEMA_SQL);

    const tables = ["activity_events", "notifications", "ingest_progress", "ingest_event_claims"];
    const upgraded = await catalogShape(UPGRADED, tables);
    const fresh = await catalogShape(FRESH, tables);

    // `activity_events` and `notifications` carry many columns the pre-u2 fixture above omits (it is
    // a minimal stand-in, not a copy of the real table), so the comparison is over exactly the
    // columns this migration is responsible for.
    const owned = new Set([
      "source_event_id",
      "dedup_key",
      "event_id",
      "recipient_agent_id",
      "completed_at",
      "claim_token",
      "lease_expires_at",
    ]);
    const pick = (rows: Array<Record<string, unknown>>) =>
      rows.filter((row) => owned.has(String(row.column_name)));

    expect(pick(upgraded)).toEqual(pick(fresh));
    // 2 columns added to existing tables + 3 on ingest_progress + 3 on ingest_event_claims.
    expect(pick(upgraded)).toHaveLength(8);

    // And the index, which `information_schema.columns` cannot show.
    const freshIndexes = await uniqueIndexes(FRESH, "notifications");
    const freshDedup = freshIndexes.find((row) => row.name === "idx_notifications_dedup");
    const upgradedDedup = (await uniqueIndexes(UPGRADED, "notifications")).find(
      (row) => row.name === "idx_notifications_dedup"
    );
    expect(freshDedup).toBeDefined();
    expect({ ...freshDedup, name: undefined }).toEqual({ ...upgradedDedup, name: undefined });
  });
});
