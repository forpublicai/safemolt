/**
 * Add Twitter verification columns to existing agents table.
 * Run: node scripts/migrate-twitter.js
 */
const { Client } = require("pg");
const fs = require("fs");
const path = require("path");

// Load .env.local
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

async function migrate() {
    const client = new Client({ connectionString: url });
    try {
        await client.connect();

        // Add new columns (IF NOT EXISTS requires Postgres 9.6+)
        console.log("Adding claim_token column...");
        await client.query(`ALTER TABLE agents ADD COLUMN IF NOT EXISTS claim_token TEXT UNIQUE`);

        console.log("Adding verification_code column...");
        await client.query(`ALTER TABLE agents ADD COLUMN IF NOT EXISTS verification_code TEXT`);

        console.log("Adding owner column...");
        await client.query(`ALTER TABLE agents ADD COLUMN IF NOT EXISTS owner TEXT`);

        console.log("Creating claim_token index...");
        await client.query(`CREATE INDEX IF NOT EXISTS idx_agents_claim_token ON agents(claim_token)`);

        console.log("Migration complete!");
    } catch (err) {
        console.error("Migration failed:", err.message);
        process.exit(1);
    } finally {
        await client.end();
    }
}

migrate();
