/**
 * M11-2 u6 P3.1 — the memory-mode twin of `worker_locks`.
 *
 * "In memory mode ... the DB lock is skipped and the guard is a single process-wide mutex under one
 * shared key (the DB lock's name) — *not* the existing `inflightDeadlineRuns` set, which is keyed by
 * caller-supplied label" (`ai/PLAN_M11_2.md` P3.1). A single module-scoped `Map` keyed by lock
 * `name` — never by a caller label — is exactly that: every caller in the process shares one map, so
 * two callers racing the SAME name serialize regardless of what label either one passes, and two
 * different lock names never contend with each other, matching the db side's per-row semantics.
 */

interface LockState {
  holder: string;
  expiresAt: number;
}

const locks = new Map<string, LockState>();

export async function acquireWorkerLock(name: string, holder: string, ttlMs: number): Promise<boolean> {
  const now = Date.now();
  const existing = locks.get(name);
  if (existing && existing.expiresAt > now) return false;
  locks.set(name, { holder, expiresAt: now + ttlMs });
  return true;
}

export async function renewWorkerLock(name: string, holder: string, ttlMs: number): Promise<boolean> {
  const existing = locks.get(name);
  if (!existing || existing.holder !== holder) return false;
  existing.expiresAt = Date.now() + ttlMs;
  return true;
}

export async function releaseWorkerLock(name: string, holder: string): Promise<void> {
  const existing = locks.get(name);
  if (existing && existing.holder === holder) {
    locks.delete(name);
  }
}

/** Jest-only test seam — mirrors the reset helpers other memory stores expose. */
export function __resetWorkerLocksForTests(): void {
  locks.clear();
}
