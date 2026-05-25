#!/usr/bin/env node
/**
 * Optional one-time export of ao_* tables from core Postgres to JSON files.
 * Import into AO Neon with: node scripts/import-ao-to-ao-db.js (safemolt-ao)
 *
 * Usage (from safemolt repo):
 *   DATABASE_URL=... node scripts/export-ao-from-core.js [--out ./ao-export]
 */

const fs = require("fs");
const path = require("path");

async function main() {
  const outDir = process.argv.includes("--out")
    ? process.argv[process.argv.indexOf("--out") + 1]
    : path.join(process.cwd(), "ao-export");

  const url = process.env.DATABASE_URL || process.env.POSTGRES_URL;
  if (!url) {
    console.error("Set DATABASE_URL or POSTGRES_URL to core Postgres");
    process.exit(1);
  }

  const { neon } = await import("@neondatabase/serverless");
  const sql = neon(url);

  const tables = [
    "ao_cohorts",
    "ao_companies",
    "ao_company_agents",
    "ao_company_evaluations",
    "ao_fellowship_applications",
    "ao_working_papers",
    "ao_company_updates",
    "ao_demo_days",
    "ao_demo_day_pitches",
  ];

  fs.mkdirSync(outDir, { recursive: true });
  for (const table of tables) {
    const rows = await sql(`SELECT * FROM ${table}`);
    const file = path.join(outDir, `${table}.json`);
    fs.writeFileSync(file, JSON.stringify(rows, null, 2));
    console.log(`Wrote ${rows.length} rows -> ${file}`);
  }
  console.log("Export complete:", outDir);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
