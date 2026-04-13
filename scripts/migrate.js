const { Client } = require("pg");
const fs = require("fs");
const path = require("path");

// Only load .env.local if not already in environment (Vercel provides these dynamically)
const url = process.env.POSTGRES_URL || process.env.DATABASE_URL;
if (!url) {
  const envPath = path.join(__dirname, "..", ".env.local");
  if (fs.existsSync(envPath)) {
    console.log("Loading connection string from .env.local...");
    const content = fs.readFileSync(envPath, "utf8");
    content.split("\n").forEach((line) => {
      const match = line.match(/^([^#=]+)=(.*)$/);
      if (match) process.env[match[1].trim()] = match[2].trim().replace(/^["']|["']$/g, "");
    });
  }
}

const finalUrl = process.env.POSTGRES_URL || process.env.DATABASE_URL;
if (!finalUrl) {
  console.error("FATAL: No database URL found in environment or .env.local");
  process.exit(1);
}

// Log a masked version of the URL to see which DB we are hitting
const maskedUrl = finalUrl.replace(/:([^:@]+)@/, ":****@");
console.log(`[Migration] Connecting to: ${maskedUrl.split('@')[1] || 'unknown-host'}`);

const schemaPath = path.join(__dirname, "schema.sql");
const renamePath = path.join(__dirname, "migrate-submolts-to-groups.sql");
const karmaToPointsPath = path.join(__dirname, "migrate-karma-to-points.sql");
const groupsUnifiedPath = path.join(__dirname, "migrate-groups-unified.sql");
const groupEmojiPath = path.join(__dirname, "migrate-add-group-emoji.sql");
const evaluationPointsPath = path.join(__dirname, "migrate-evaluation-points.sql");
const verifiedAgentsEvaluationsPath = path.join(__dirname, "migrate-verified-agents-evaluations.sql");
const agentsPointsDecimalPath = path.join(__dirname, "migrate-agents-points-decimal.sql");
const multiAgentSessionsPath = path.join(__dirname, "migrate-multi-agent-sessions.sql");
const evaluationVersionPath = path.join(__dirname, "migrate-evaluation-version.sql");
const atprotoBlobsPath = path.join(__dirname, "migrate-atproto-blobs.sql");
const dashboardMemoryPath = path.join(__dirname, "migrate-dashboard-memory.sql");
const schoolsPath = path.join(__dirname, "migrate-schools.sql");
const evaluationsScopingPath = path.join(__dirname, "migrate-evaluations-scoping.sql");

async function runFile(client, filePath, label) {
  if (fs.existsSync(filePath)) {
    try {
      const sql = fs.readFileSync(filePath, "utf-8");
      // Execute the entire file contents at once
      await client.query(sql);
      console.log(`[Migration] SUCCESS: ${label} applied.`);
      return true;
    } catch (err) {
      if (err.message.includes("already exists") || err.message.includes("duplicate") || err.message.includes("does not exist")) {
        console.log(`[Migration] SKIP: ${label} (already handled or columns missing).`);
        return true;
      }
      console.error(`[Migration] FAILED: ${label}:`, err.message);
      throw err;
    }
  }
  return false;
}

async function migrate() {
  const client = new Client({ connectionString: finalUrl });
  try {
    await client.connect();
    console.log("[Migration] Database connected.");

    // Core Schema
    await runFile(client, schemaPath, "Base Schema");

    // Sequential Migrations
    await runFile(client, renamePath, "Submolts -> Groups rename");
    await runFile(client, karmaToPointsPath, "Karma -> Points rename");
    await runFile(client, groupsUnifiedPath, "Groups unification");
    await runFile(client, groupEmojiPath, "Group emoji support");
    await runFile(client, evaluationPointsPath, "Evaluation points system");
    await runFile(client, verifiedAgentsEvaluationsPath, "Backfill verified agents");
    await runFile(client, agentsPointsDecimalPath, "Points decimal precision");
    await runFile(client, multiAgentSessionsPath, "Multi-agent sessions");
    await runFile(client, evaluationVersionPath, "Evaluation versioning");
    await runFile(client, dashboardMemoryPath, "Dashboard & Memory tables");
    await runFile(client, atprotoBlobsPath, "AT Protocol blobs");
    
    // THE CRITICAL ONES
    await runFile(client, schoolsPath, "Multi-school system");
    await runFile(client, evaluationsScopingPath, "Evaluations scoping");

    console.log("[Migration] ALL MIGRATIONS COMPLETED SUCCESSFULLY.");
  } catch (err) {
    console.error("[Migration] FATAL ERROR:", err.message);
    process.exit(1);
  } finally {
    await client.end();
  }
}

migrate();
