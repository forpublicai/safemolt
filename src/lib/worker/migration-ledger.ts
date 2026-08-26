import { sql } from "@/lib/db";

/**
 * M11-2 u6 P3.1 — the worker's migration-ledger boot check.
 *
 * A checked-in list of the migration filenames THIS BUILD's code depends on — the full M11a
 * substrate: the event log, receipts, failures, dead letters, the shadow-compare stamp, the wakeup
 * queue + budget counters, and the `worker_locks` singleton this process claims. **Never a future
 * train's file** — listing one here would make the worker exit non-zero forever waiting on a
 * migration that has not shipped yet. Each later train extends this list only in the worker build it
 * ships AFTER its own migrations are recorded (the Vercel deploy that runs `migrate.js` always
 * precedes the worker deploy that depends on it).
 *
 * Spot-checking a few tables with `to_regclass` cannot establish version compatibility in a repo
 * whose schema evolves by append-only migration files rather than a version sentinel — a partially
 * migrated deployment would pass a three-table probe and then fail its first duty.
 */
export const REQUIRED_MIGRATIONS: readonly string[] = [
  "migrate-m11-events.sql",
  "migrate-m11-tick-log.sql",
  "migrate-m11-consumers.sql",
  "migrate-m11-shadow-compare.sql",
  "migrate-m11-wakeups.sql",
  "migrate-m11-worker.sql",
];

/** Pure: which of `required` are absent from `recorded`, in `required`'s own order. */
export function computeMissingMigrations(required: readonly string[], recorded: ReadonlySet<string>): string[] {
  return required.filter((filename) => !recorded.has(filename));
}

export type MigrationLedgerCheck =
  | { ok: true }
  | { ok: false; reason: "no_database" }
  | { ok: false; reason: "missing_migrations"; missing: string[] };

/**
 * Reads `_migrations` and reports whether every filename in `required` is recorded. Never throws —
 * a missing database or a missing migration are both reported as a normal (non-exceptional) result,
 * so the caller decides what "fatal" means (the worker's boot path exits non-zero; a test just
 * asserts on the result).
 */
export async function checkMigrationLedger(
  required: readonly string[] = REQUIRED_MIGRATIONS
): Promise<MigrationLedgerCheck> {
  if (!sql) return { ok: false, reason: "no_database" };
  const rows = await sql`SELECT filename FROM _migrations WHERE filename = ANY(${required})`;
  const recorded = new Set((rows as { filename: string }[]).map((r) => r.filename));
  const missing = computeMissingMigrations(required, recorded);
  if (missing.length > 0) return { ok: false, reason: "missing_migrations", missing };
  return { ok: true };
}
