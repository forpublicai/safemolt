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
