const { Client } = require("pg");
const fs = require("fs");
const path = require("path");

const MIGRATION_FILES = [
  { file: "schema.sql", label: "Base schema" },
  { file: "migrate-submolts-to-groups.sql", label: "Submolts to groups rename" },
  { file: "migrate-karma-to-points.sql", label: "Karma to points rename" },
  { file: "migrate-groups-unified.sql", label: "Groups unification" },
  { file: "migrate-add-group-emoji.sql", label: "Group emoji support" },
  { file: "migrate-evaluation-points.sql", label: "Evaluation points system" },
  { file: "migrate-verified-agents-evaluations.sql", label: "Verified agents backfill" },
  { file: "migrate-agents-points-decimal.sql", label: "Points decimal precision" },
  { file: "migrate-multi-agent-sessions.sql", label: "Multi-agent sessions" },
  { file: "migrate-evaluation-version.sql", label: "Evaluation versioning" },
  { file: "migrate-dashboard-memory.sql", label: "Dashboard and memory tables" },
  { file: "migrate-memory-fts.sql", label: "Memory FTS sidecar" },
  { file: "migrate-memory-ingestion.sql", label: "Memory ingestion watermark" },
  { file: "migrate-inference-multi-provider.sql", label: "Inference multi-provider" },
  { file: "migrate-atproto-blobs.sql", label: "AT protocol blobs" },
  { file: "migrate-schools.sql", label: "Multi-school system" },
  { file: "migrate-evaluations-scoping.sql", label: "Evaluations scoping" },
  { file: "migrate-admissions.sql", label: "Platform admissions" },
  { file: "migrate-agent-loop.sql", label: "Agent autonomous loop" },
  { file: "migrate-activity-contexts.sql", label: "Activity context cache" },
  { file: "migrate-activity-feed-indexes.sql", label: "Activity feed indexes" },
  { file: "migrate-activity-feed-indexes-2.sql", label: "Activity feed covering indexes" },
  { file: "migrate-activity-events.sql", label: "Activity events denormalized feed" },
  { file: "migrate-chat-sessions.sql", label: "Dashboard chat session persistence" },
  { file: "migrate-professor-users.sql", label: "Professor human user linking" },
  { file: "migrate-class-slugs.sql", label: "Class UUID and slug migration" },
  { file: "migrate-ao-stanford.sql", label: "Stanford AO companies and fellowship" },
  { file: "migrate-ao-seed-moiraine.sql", label: "Stanford AO admitted agent Moiraine" },
  { file: "migrate-ao-working-papers.sql", label: "Stanford AO working papers archive" },
  { file: "migrate-ao-company-updates.sql", label: "Stanford AO weekly company updates" },
  { file: "migrate-ao-demo-day.sql", label: "Stanford AO demo days and pitches" },
  { file: "migrate-about-timeline-reactions.sql", label: "About timeline emoji reactions" },
  { file: "migrate-drop-houses.sql", label: "Drop legacy houses tables" },
  { file: "migrate-classes-base-repair.sql", label: "Classes base schema repair" },
  { file: "migrate-notifications.sql", label: "Agent inbox notifications" },
  { file: "migrate-class-evaluation-kind.sql", label: "Class evaluation kind taxonomy" },
  { file: "migrate-group-members-single-house.sql", label: "Single-house partial unique index" },
  { file: "migrate-house-founder-repair.sql", label: "House founder repair after dedupe" },
  { file: "migrate-rotate-published-professor-keys.sql", label: "Rotate published professor API keys" },
  { file: "migrate-post-soft-delete.sql", label: "Post soft delete (anti-veto)" },
  { file: "migrate-evaluation-school-provenance.sql", label: "Evaluation school provenance and transcript ordering" },
  { file: "migrate-evaluation-result-unique.sql", label: "Unique evaluation result per registration" },
  { file: "migrate-certification-job-lease.sql", label: "Certification job lease and live-job uniqueness" },
  { file: "migrate-evaluation-one-pass.sql", label: "One passed result per agent and evaluation" },
  { file: "migrate-rate-windows.sql", label: "Durable public-endpoint rate windows" },
  { file: "migrate-agent-name-ci-unique.sql", label: "Case-insensitive agent name uniqueness" },
  { file: "migrate-vetting-challenges.sql", label: "Durable vetting challenges" },
  { file: "migrate-playground-resolution-claim.sql", label: "Playground resolution claim and action uniqueness" },
  { file: "migrate-playground-cancellation.sql", label: "Playground cancellation as attributed transition" },
  { file: "migrate-playground-live-session-unique.sql", label: "One live playground session per school" },
  { file: "migrate-neutralize-seeded-credentials.sql", label: "Neutralize seeded literal credentials" },
  { file: "migrate-rotate-stale-claim-tokens.sql", label: "Rotate stale unclaimed claim tokens" },
  { file: "migrate-playground-agent-memories.sql", label: "Durable playground episodic memories" },
];

/** `KEY=value` from one .env line, or null for a blank, a comment, or anything malformed. */
function parseEnvLine(rawLine) {
  const line = rawLine.trim();
  if (!line || line.startsWith("#")) return null;

  const match = line.match(/^([^=]+)=(.*)$/);
  if (!match) return null;

  let value = match[2].trim();
  const quoted =
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"));
  return { key: match[1].trim(), value: quoted ? value.slice(1, -1) : value };
}

function loadEnvLocalIfNeeded() {
  if (process.env.POSTGRES_URL || process.env.DATABASE_URL) {
    return;
  }

  const envPath = path.join(__dirname, "..", ".env.local");
  if (!fs.existsSync(envPath)) {
    return;
  }

  console.log("[Migration] Loading connection string from .env.local...");
  const content = fs.readFileSync(envPath, "utf8");

  for (const rawLine of content.split("\n")) {
    const entry = parseEnvLine(rawLine);
    if (entry && !process.env[entry.key]) {
      process.env[entry.key] = entry.value;
    }
  }
}

function getConnectionString() {
  loadEnvLocalIfNeeded();
  return process.env.POSTGRES_URL || process.env.DATABASE_URL;
}

function maskedConnectionTarget(connectionString) {
  const masked = connectionString.replace(/:([^:@]+)@/, ":****@");
  return masked.split("@")[1] || "unknown-host";
}

async function ensureMigrationTable(client) {
  await client.query(`
    CREATE TABLE IF NOT EXISTS _migrations (
      filename text PRIMARY KEY,
      label text NOT NULL,
      applied_at timestamptz NOT NULL DEFAULT now()
    )
  `);
}

async function hasMigrationRun(client, filename) {
  const result = await client.query("SELECT 1 FROM _migrations WHERE filename = $1 LIMIT 1", [filename]);
  return result.rowCount > 0;
}

async function recordMigration(client, filename, label) {
  await client.query(
    "INSERT INTO _migrations (filename, label) VALUES ($1, $2) ON CONFLICT (filename) DO NOTHING",
    [filename, label]
  );
}

/**
 * Apply one migration file.
 *
 * M11-1 C1 — three fail-open paths were removed here, and the reasoning matters because each one
 * looked harmless:
 *
 *  1. **An object-exists error used to record the file as applied.** A migration file runs as one
 *     implicit transaction, so a collision halfway through rolls back every earlier statement and
 *     prevents every later one. Recording it left the file *recorded yet almost entirely absent*;
 *     later migrations then built on a schema that was not there, and nothing ever re-applied it.
 *     Migrations run inside the build (`node scripts/migrate.js && next build`), so exit-0-with-
 *     unrecorded-file would serve application code against a schema its own migration rolled back.
 *  2. **A bare `"duplicate"` substring match** swallowed data-level 23505s along with DDL
 *     collisions. Those are real failures and now surface.
 *  3. **A listed file that was missing or empty was silently skipped**, which deploys application
 *     code without its schema just as surely as a rolled-back file.
 *
 * Nothing is recorded on any error, and any error stops the deploy. Every new migration is written
 * fully idempotent (`IF NOT EXISTS` / conditional `DO` blocks), so re-running after a genuine
 * partial failure is safe and is the recovery path.
 *
 * An in-run retry was considered and rejected as a no-op: the runner would re-execute the same
 * file against the same database state, so an idempotent file never raised the error and a
 * non-idempotent one raises it identically. A retry can only help if external state changes
 * between attempts, and nothing here does. If *concurrent* runners (two deploys racing) turn out
 * to be the real failure mode, the fix is a Postgres advisory lock around the runner — a named
 * follow-up, not implemented on speculation.
 */
async function runFile(client, migration, dir) {
  const { file, label } = migration;
  const filePath = path.join(dir, file);

  // The artifact is checked **before** the `_migrations` lookup, not after.
  //
  // An earlier version checked "already recorded" first and argued that a recorded file whose SQL
  // has applied may safely disappear. That reasoning only holds for the database in front of you:
  // migrations are append-only and a *fresh* database still needs the file, so a deployment whose
  // schema is already current would go green while the repository had silently lost a migration
  // every new environment depends on. A listed file that is missing or empty is fatal, full stop —
  // which is what `agents.md` says.
  if (!fs.existsSync(filePath)) {
    throw new Error(`[Migration] ${label}: listed file ${file} is missing`);
  }

  const sql = fs.readFileSync(filePath, "utf8").trim();
  if (!sql) {
    throw new Error(`[Migration] ${label}: listed file ${file} is empty`);
  }

  if (await hasMigrationRun(client, file)) {
    console.log(`[Migration] SKIP: ${label} (already recorded)`);
    return;
  }

  try {
    await client.query(sql);
  } catch (err) {
    console.error(`[Migration] FAILED: ${label} (${err.code || "no code"}) — recording nothing`);
    throw err;
  }

  await recordMigration(client, file, label);
  console.log(`[Migration] SUCCESS: ${label}`);
}

/**
 * @param {{ files?: Array<{file: string, label: string}>, dir?: string, connectionString?: string }} options
 * Options exist so the integration suite can drive the *real* runner over fixture files. Production
 * always calls it with no arguments.
 */
async function migrate(options = {}) {
  const files = options.files || MIGRATION_FILES;
  const dir = options.dir || __dirname;
  const connectionString = options.connectionString || getConnectionString();

  if (!connectionString) {
    throw new Error("[Migration] FATAL: No POSTGRES_URL or DATABASE_URL found.");
  }

  const client = new Client({ connectionString });
  console.log(`[Migration] Connecting to: ${maskedConnectionTarget(connectionString)}`);
  await client.connect();

  try {
    console.log("[Migration] Database connected.");
    await ensureMigrationTable(client);

    for (const migration of files) {
      await runFile(client, migration, dir);
    }

    console.log("[Migration] All migrations completed.");
  } finally {
    // A close failure must never mask a migration failure: by this point every applied file is
    // committed, so a dangling socket is a diagnostic, not a deploy blocker.
    try {
      await client.end();
    } catch (closeErr) {
      console.error("[Migration] Error while closing database connection:", closeErr.message);
    }
  }
}

module.exports = { MIGRATION_FILES, migrate, runFile };

if (require.main === module) {
  migrate().catch((err) => {
    console.error("[Migration] FATAL ERROR:", err.message);
    process.exit(1);
  });
}
