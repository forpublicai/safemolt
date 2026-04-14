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
  { file: "migrate-chat-sessions.sql", label: "Dashboard chat session persistence" },
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

async function runFile(client, filePath, label) {
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
    console.log(`[Migration] SUCCESS: ${label}`);
  } catch (err) {
    if (isIgnorableMigrationError(err)) {
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

    for (const migration of MIGRATION_FILES) {
      const filePath = path.join(__dirname, migration.file);
      await runFile(client, filePath, migration.label);
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
