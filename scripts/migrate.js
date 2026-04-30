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
  { file: "migrate-drop-houses.sql", label: "Drop legacy houses tables" },
];

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
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) {
      continue;
    }

    const match = line.match(/^([^=]+)=(.*)$/);
    if (!match) {
      continue;
    }

    const key = match[1].trim();
    let value = match[2].trim();

    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }

    if (!process.env[key]) {
      process.env[key] = value;
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

function isIgnorableMigrationError(err) {
  const ignorableCodes = new Set(["42P07", "42701", "42710", "42P01", "42703"]);
  const message = String(err && err.message ? err.message : "").toLowerCase();

  return (
    ignorableCodes.has(err && err.code) ||
    message.includes("already exists") ||
    message.includes("duplicate") ||
    message.includes("does not exist")
  );
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

async function runFile(client, migration) {
  const { file, label } = migration;
  const filePath = path.join(__dirname, file);
  if (await hasMigrationRun(client, file)) {
    console.log(`[Migration] SKIP: ${label} (already recorded)`);
    return;
  }

  if (!fs.existsSync(filePath)) {
    console.log(`[Migration] SKIP: ${label} (file missing)`);
    return;
  }

  const sql = fs.readFileSync(filePath, "utf8").trim();
  if (!sql) {
    console.log(`[Migration] SKIP: ${label} (file empty)`);
    return;
  }

  try {
    await client.query(sql);
    await recordMigration(client, file, label);
    console.log(`[Migration] SUCCESS: ${label}`);
  } catch (err) {
    if (isIgnorableMigrationError(err)) {
      await recordMigration(client, file, label);
      console.log(`[Migration] SKIP: ${label} (already applied or not needed)`);
      return;
    }

    console.error(`[Migration] FAILED: ${label}`);
    throw err;
  }
}

async function migrate() {
  const connectionString = getConnectionString();
  if (!connectionString) {
    console.error("[Migration] FATAL: No POSTGRES_URL or DATABASE_URL found.");
    process.exit(1);
  }

  const client = new Client({ connectionString });

  try {
    console.log(`[Migration] Connecting to: ${maskedConnectionTarget(connectionString)}`);
    await client.connect();
    console.log("[Migration] Database connected.");
    await ensureMigrationTable(client);

    for (const migration of MIGRATION_FILES) {
      await runFile(client, migration);
    }

    console.log("[Migration] All migrations completed.");
  } catch (err) {
    console.error("[Migration] FATAL ERROR:", err.message);
    process.exitCode = 1;
  } finally {
    try {
      await client.end();
    } catch (closeErr) {
      console.error("[Migration] Error while closing database connection:", closeErr.message);
      process.exitCode = process.exitCode || 1;
    }
  }
}

migrate();
