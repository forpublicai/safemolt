import { sql } from "@/lib/db";

/**
 * M11-2 u6 P3.1 — the generic DB-level singleton lock (`worker_locks`, `migrate-m11-worker.sql`).
 *
 * One row per lock `name`; whoever holds a non-expired row is the sole claimant. **`holder` is a
 * fresh UUID minted per invocation, never a stable worker/process identity, and there is
 * deliberately no same-holder re-acquisition arm** — with a stable identity two overlapping
 * invocations in one runtime would both "acquire" (same holder value passes the `ON CONFLICT`
 * predicate trivially), reintroducing exactly the duplicate work the lock exists to prevent. Renewal
 * and release both match on the token, so an invocation can only ever extend or release its own
 * claim.
 */

const ACQUIRE_SQL = `
  INSERT INTO worker_locks (name, holder, expires_at)
  VALUES ($1, $2, now() + make_interval(secs => $3::double precision))
  ON CONFLICT (name) DO UPDATE
    SET holder = EXCLUDED.holder, expires_at = EXCLUDED.expires_at
    WHERE worker_locks.expires_at <= now()
  RETURNING holder
`;

/** Acquire `name` for `holder`. Returns `true` iff this call is now the sole claimant. */
export async function acquireWorkerLock(name: string, holder: string, ttlMs: number): Promise<boolean> {
  const rows = await sql!(ACQUIRE_SQL, [name, holder, ttlMs / 1000]);
  return rows.length > 0;
}

/**
 * Extend `name`'s expiry, but only while `holder` still owns it.
 *
 * Zero rows back means the lock was lost — expired and reclaimed by a contender, or never held by
 * this token — and the caller must stop claiming further work immediately (P3.1: "the residual
 * overlap window is a single session's processing exceeding the TTL", which renewal is what bounds).
 */
export async function renewWorkerLock(name: string, holder: string, ttlMs: number): Promise<boolean> {
  const rows = await sql!(
    `UPDATE worker_locks
     SET expires_at = now() + make_interval(secs => $3::double precision)
     WHERE name = $1 AND holder = $2
     RETURNING holder`,
    [name, holder, ttlMs / 1000]
  );
  return rows.length > 0;
}

/**
 * Release `name` early by expiring it now, but only while `holder` still owns it.
 *
 * Best-effort: a release that loses the token match (already expired and reclaimed) is a no-op, not
 * an error — there is nothing left for this invocation to give up.
 */
export async function releaseWorkerLock(name: string, holder: string): Promise<void> {
  await sql!(
    `UPDATE worker_locks SET expires_at = now() WHERE name = $1 AND holder = $2`,
    [name, holder]
  );
}
