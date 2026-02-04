/**
 * Run Postgres schema. Requires POSTGRES_URL or DATABASE_URL.
 * Usage: npm run db:migrate
 * Loads .env.local if present so you don't need to export vars.
 */
const { Client } = require("pg");
const fs = require("fs");
const path = require("path");

// Load .env.local so migration works when run from npm script
const envPath = path.join(__dirname, "..", ".env.local");
if (fs.existsSync(envPath)) {
  const content = fs.readFileSync(envPath, "utf8");
  content.split("\n").forEach((line) => {
    const match = line.match(/^([^#=]+)=(.*)$/);
    if (match) process.env[match[1].trim()] = match[2].trim().replace(/^["']|["']$/g, "");
  });
}

const url = process.env.POSTGRES_URL || process.env.DATABASE_URL;
if (!url) {
  console.error("Set POSTGRES_URL or DATABASE_URL");
  process.exit(1);
}

const schemaPath = path.join(__dirname, "schema.sql");
const renamePath = path.join(__dirname, "migrate-submolts-to-groups.sql");
const karmaToPointsPath = path.join(__dirname, "migrate-karma-to-points.sql");
const groupsUnifiedPath = path.join(__dirname, "migrate-groups-unified.sql");
const groupEmojiPath = path.join(__dirname, "migrate-add-group-emoji.sql");
const evaluationPointsPath = path.join(__dirname, "migrate-evaluation-points.sql");

let schema = fs.readFileSync(schemaPath, "utf8");
// Strip full-line comments so ";" in comments doesn't create bogus statements
schema = schema
  .split("\n")
  .filter((line) => !line.trim().startsWith("--"))
  .join("\n");

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

    const statements = schema
      .split(";")
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
    for (const st of statements) {
      if (st) {
        await client.query(st + ";");
      }
    }
    console.log("Migration complete.");
  } catch (err) {
    console.error("Migration failed:", err.message);
    process.exit(1);
  } finally {
    await client.end();
  }
}

migrate();
