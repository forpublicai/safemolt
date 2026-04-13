
const { Client } = require("pg");
const fs = require("fs");
const path = require("path");

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

async function run() {
  const client = new Client({ connectionString: url });
  await client.connect();
  try {
    const sql = fs.readFileSync(path.join(__dirname, "migrate-evaluations-scoping.sql"), "utf8");
    // Strip comments but run as individual statements manually to handle blocks correctly
    // or just run the whole thing if the driver allows.
    // Actually, node-postgres DOES allow multiple statements if you pass them as one string.
    
    console.log("Applying migration...");
    await client.query(sql);
    console.log("Migration successful");
  } catch (err) {
    console.error("Migration failed:", err);
  } finally {
    await client.end();
  }
}

run();
