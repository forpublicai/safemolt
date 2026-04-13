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
const inferenceMultiProviderPath = path.join(__dirname, "migrate-inference-multi-provider.sql");

let schema = fs.readFileSync(schemaPath, "utf8");
// Strip full-line comments so ";" in comments doesn't create bogus statements
schema = schema
  .split("\n")
  .filter((line) => !line.trim().startsWith("--"))
  .join("\n");
const schoolsPath = path.join(__dirname, "migrate-schools.sql");
const evaluationsScopingPath = path.join(__dirname, "migrate-evaluations-scoping.sql");

async function migrate() {
  const client = new Client({ connectionString: url });
  try {
    await client.connect();

    // One-time rename: submolts -> groups, submolt_id -> group_id (no-op if already done)
    if (fs.existsSync(renamePath)) {
      try {
        const renameSql = fs.readFileSync(renamePath, "utf8");
        await client.query(renameSql);
        console.log("Rename migration (submolts -> groups) applied.");
      } catch (err) {
        // Ignore if columns don't exist (already migrated)
        if (!err.message.includes("does not exist")) {
          throw err;
        }
      }
    }

    // One-time rename: karma -> points, karma_at_join -> points_at_join (no-op if already done)
    if (fs.existsSync(karmaToPointsPath)) {
      try {
        const karmaToPointsSql = fs.readFileSync(karmaToPointsPath, "utf8");
        await client.query(karmaToPointsSql);
        console.log("Rename migration (karma -> points) applied.");
      } catch (err) {
        // Ignore if columns don't exist (already migrated)
        if (!err.message.includes("does not exist")) {
          throw err;
        }
      }
    }

    // One-time migration: Unify houses into groups table (no-op if already done)
    if (fs.existsSync(groupsUnifiedPath)) {
      try {
        const groupsUnifiedSql = fs.readFileSync(groupsUnifiedPath, "utf8");
        await client.query(groupsUnifiedSql);
        console.log("Groups unification migration applied.");
      } catch (err) {
        // Ignore if columns already exist (already migrated)
        if (!err.message.includes("already exists") && !err.message.includes("duplicate")) {
          throw err;
        }
        console.log("Groups unification migration already applied (skipping).");
      }
    }

    // One-time migration: Add emoji column to groups table (no-op if already done)
    if (fs.existsSync(groupEmojiPath)) {
      try {
        const groupEmojiSql = fs.readFileSync(groupEmojiPath, "utf8");
        await client.query(groupEmojiSql);
        console.log("Group emoji migration applied.");
      } catch (err) {
        // Ignore if column already exists (already migrated)
        if (!err.message.includes("already exists") && !err.message.includes("duplicate")) {
          throw err;
        }
        console.log("Group emoji migration already applied (skipping).");
      }
    }

    // One-time migration: Add evaluation points system (no-op if already done)
    if (fs.existsSync(evaluationPointsPath)) {
      try {
        const evaluationPointsSql = fs.readFileSync(evaluationPointsPath, "utf8");
        await client.query(evaluationPointsSql);
        console.log("Evaluation points migration applied.");
      } catch (err) {
        // Ignore if columns already exist (already migrated)
        if (!err.message.includes("already exists") && !err.message.includes("duplicate")) {
          throw err;
        }
        console.log("Evaluation points migration already applied (skipping).");
      }
    }

    // One-time migration: Backfill evaluation results for verified agents (no-op if already done)
    if (fs.existsSync(verifiedAgentsEvaluationsPath)) {
      try {
        const verifiedAgentsSql = fs.readFileSync(verifiedAgentsEvaluationsPath, "utf8");
        await client.query(verifiedAgentsSql);
        console.log("Verified agents evaluations migration applied.");
      } catch (err) {
        // This migration can be run multiple times safely (uses NOT EXISTS checks)
        // But log if there's a real error
        if (!err.message.includes("duplicate key") && !err.message.includes("already exists")) {
          console.error("Verified agents evaluations migration error:", err.message);
          // Don't throw - allow migration to continue
        } else {
          console.log("Verified agents evaluations migration already applied (skipping).");
        }
      }
    }

    // One-time migration: Store agent/house points as decimal (e.g. 0.5 for evaluations)
    if (fs.existsSync(agentsPointsDecimalPath)) {
      try {
        const agentsPointsDecimalSql = fs.readFileSync(agentsPointsDecimalPath, "utf8");
        await client.query(agentsPointsDecimalSql);
        console.log("Agents points decimal migration applied.");
      } catch (err) {
        if (!err.message.includes("already exists") && !err.message.includes("duplicate")) {
          throw err;
        }
        console.log("Agents points decimal migration already applied (skipping).");
      }
    }

    const statements = schema
      .split(";")
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
    for (const st of statements) {
      if (st) {
        await client.query(st + ";");
      }
    }

    // Multi-agent evaluation sessions (after schema so evaluation_registrations exists)
    if (fs.existsSync(multiAgentSessionsPath)) {
      try {
        const multiAgentSessionsSql = fs.readFileSync(multiAgentSessionsPath, "utf8");
        const multiStatements = multiAgentSessionsSql
          .split("\n")
          .filter((line) => !line.trim().startsWith("--"))
          .join("\n")
          .split(";")
          .map((s) => s.trim())
          .filter((s) => s.length > 0);
        for (const st of multiStatements) {
          if (st) await client.query(st + ";");
        }
        console.log("Multi-agent sessions migration applied.");
      } catch (err) {
        if (!err.message.includes("already exists") && !err.message.includes("duplicate")) {
          throw err;
        }
        console.log("Multi-agent sessions migration already applied (skipping).");
      }
    }

    // Evaluation version column and backfill (for evaluation pages / version filter)
    if (fs.existsSync(evaluationVersionPath)) {
      try {
        const evaluationVersionSql = fs.readFileSync(evaluationVersionPath, "utf8");
        const evStatements = evaluationVersionSql
          .split("\n")
          .filter((line) => !line.trim().startsWith("--"))
          .join("\n")
          .split(";")
          .map((s) => s.trim())
          .filter((s) => s.length > 0);
        for (const st of evStatements) {
          if (st) await client.query(st + ";");
        }
        console.log("Evaluation version migration applied.");
      } catch (err) {
        if (!err.message.includes("already exists") && !err.message.includes("duplicate")) {
          throw err;
        }
        console.log("Evaluation version migration already applied (skipping).");
      }
    }

    // Dashboard, Cognito users, context files, demo usage
    if (fs.existsSync(dashboardMemoryPath)) {
      try {
        const dashboardSql = fs.readFileSync(dashboardMemoryPath, "utf8");
        const dashStatements = dashboardSql
          .split("\n")
          .filter((line) => !line.trim().startsWith("--"))
          .join("\n")
          .split(";")
          .map((s) => s.trim())
          .filter((s) => s.length > 0);
        for (const st of dashStatements) {
          if (st) await client.query(st + ";");
        }
        console.log("Dashboard / memory tables migration applied.");
      } catch (err) {
        if (!err.message.includes("already exists") && !err.message.includes("duplicate")) {
          throw err;
        }
        console.log("Dashboard / memory migration already applied (skipping).");
      }
    }

    // Multi-provider inference API keys (user_inference_settings)
    if (fs.existsSync(inferenceMultiProviderPath)) {
      try {
        const infSql = fs.readFileSync(inferenceMultiProviderPath, "utf8");
        await client.query(infSql);
        console.log("Inference multi-provider columns migration applied.");
      } catch (err) {
        if (!err.message.includes("already exists") && !err.message.includes("duplicate")) {
          throw err;
        }
        console.log("Inference multi-provider migration already applied (skipping).");
      }
    }

    // AT Protocol blobs table (avatar projection metadata)
    if (fs.existsSync(atprotoBlobsPath)) {
      try {
        const atprotoBlobsSql = fs.readFileSync(atprotoBlobsPath, "utf8");
        const abStatements = atprotoBlobsSql
          .split("\n")
          .filter((line) => !line.trim().startsWith("--"))
          .join("\n")
          .split(";")
          .map((s) => s.trim())
          .filter((s) => s.length > 0);
        for (const st of abStatements) {
          if (st) await client.query(st + ";");
        }
        console.log("AT Protocol blobs migration applied.");
      } catch (err) {
        if (!err.message.includes("already exists") && !err.message.includes("duplicate")) {
          throw err;
        }
        console.log("AT Protocol blobs migration already applied (skipping).");
      }
    }

    console.log("Migration complete.");
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
