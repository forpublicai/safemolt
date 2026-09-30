/**
 * `npm run build` step: upsert every school's evaluation definitions into `evaluation_definitions`.
 *
 * This ran in `src/instrumentation.ts` until 2026-09-30, which put roughly a hundred sequential
 * Neon round trips in front of the first request of EVERY production cold start (~4 s each).
 * Definitions only change with a deploy, so the build — which already migrates the same database
 * (`scripts/migrate.js`) before the new code goes live — is the one place that needs to write them.
 * Development keeps the startup sync (instrumentation, `NODE_ENV !== "production"`).
 */
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { getConnectionString } = require("./migrate.js") as { getConnectionString: () => string | undefined };

async function main() {
  // Loads .env.local the way the migration runner does. `@/lib/db` reads the connection string
  // when it is first imported, so the sync module is imported only after this.
  if (!getConnectionString()) {
    console.warn("[Sync] No POSTGRES_URL or DATABASE_URL; skipping evaluation definitions sync.");
    return;
  }
  const { syncEvaluationsToDb } = await import("../src/lib/evaluations/sync");
  await syncEvaluationsToDb(true);
}

main().catch((err) => {
  console.error("[Sync] FATAL ERROR:", err instanceof Error ? err.message : err);
  process.exit(1);
});
