/**
 * M11-2 u6 P3.1 — the singleton-lock store, memory-mode twin (`src/lib/store/worker-locks/memory.ts`).
 *
 * This is the guard `playground/lifecycle.ts`'s `runDeadlinesAndCap` shares with any future
 * `worker_locks`-backed duty. The db twin (`db.ts`) issues the plan's verbatim upsert against
 * Postgres and is exercised for real by `src/__tests__/integration/m11-2-u6-worker.test.ts`; this
 * file covers the memory twin's semantics directly, since Jest runs entirely in memory mode.
 */

import { acquireWorkerLock, renewWorkerLock, releaseWorkerLock, __resetWorkerLocksForTests } from "@/lib/store/worker-locks/memory";

const NAME = "test-lock";
const TTL_MS = 10_000;

describe("worker-locks (memory)", () => {
  beforeEach(() => {
    __resetWorkerLocksForTests();
  });

  it("acquires on an empty table", async () => {
    await expect(acquireWorkerLock(NAME, "holder-a", TTL_MS)).resolves.toBe(true);
  });

  it("refuses a second holder while the first is still live", async () => {
    await acquireWorkerLock(NAME, "holder-a", TTL_MS);
    await expect(acquireWorkerLock(NAME, "holder-b", TTL_MS)).resolves.toBe(false);
  });

  it("acquires for a new holder once the previous one expires", async () => {
    jest.useFakeTimers();
    try {
      await acquireWorkerLock(NAME, "holder-a", TTL_MS);
      jest.advanceTimersByTime(TTL_MS + 1);
      await expect(acquireWorkerLock(NAME, "holder-b", TTL_MS)).resolves.toBe(true);
    } finally {
      jest.useRealTimers();
    }
  });

  it("a stable holder never re-acquires its own name via a second acquire call — no such arm exists", async () => {
    // P3.1 is explicit: "there is deliberately no same-holder re-acquisition arm." A second
    // `acquireWorkerLock` call with the SAME string is just another caller as far as the lock is
    // concerned — it is refused exactly like any other contender while the row is live.
    await acquireWorkerLock(NAME, "same-holder", TTL_MS);
    await expect(acquireWorkerLock(NAME, "same-holder", TTL_MS)).resolves.toBe(false);
  });

  it("renews for the current holder and extends its expiry", async () => {
    jest.useFakeTimers();
    try {
      await acquireWorkerLock(NAME, "holder-a", TTL_MS);
      jest.advanceTimersByTime(TTL_MS - 1); // just before expiry
      await expect(renewWorkerLock(NAME, "holder-a", TTL_MS)).resolves.toBe(true);
      // Renewal pushed expiry forward by another TTL_MS from now, so the lock is still held here,
      // past where it would have expired without the renewal.
      jest.advanceTimersByTime(2);
      await expect(acquireWorkerLock(NAME, "holder-b", TTL_MS)).resolves.toBe(false);
    } finally {
      jest.useRealTimers();
    }
  });

  it("refuses to renew for a holder that does not currently own the lock", async () => {
    await acquireWorkerLock(NAME, "holder-a", TTL_MS);
    await expect(renewWorkerLock(NAME, "holder-b", TTL_MS)).resolves.toBe(false);
  });

  it("refuses to renew a lock that was never acquired", async () => {
    await expect(renewWorkerLock("never-acquired", "holder-a", TTL_MS)).resolves.toBe(false);
  });

  it("releases early, letting a new holder acquire immediately", async () => {
    await acquireWorkerLock(NAME, "holder-a", TTL_MS);
    await releaseWorkerLock(NAME, "holder-a");
    await expect(acquireWorkerLock(NAME, "holder-b", TTL_MS)).resolves.toBe(true);
  });

  it("release is a no-op for a caller that does not hold the lock — the real holder keeps it", async () => {
    await acquireWorkerLock(NAME, "holder-a", TTL_MS);
    await releaseWorkerLock(NAME, "holder-b"); // wrong token — must not clear holder-a's claim
    await expect(acquireWorkerLock(NAME, "holder-c", TTL_MS)).resolves.toBe(false);
  });

  it("is a per-name mutex, not process-wide across DIFFERENT names — two names never contend", async () => {
    await expect(acquireWorkerLock("lock-one", "holder-a", TTL_MS)).resolves.toBe(true);
    await expect(acquireWorkerLock("lock-two", "holder-b", TTL_MS)).resolves.toBe(true);
  });

  it("is process-wide across DIFFERENT caller labels for the SAME name — replacing the old label-keyed inflightDeadlineRuns set", async () => {
    // The defect this closes: two callers passing different labels used to overlap because the old
    // guard was a Set<string> keyed by the label itself. The lock is keyed by NAME only; a caller's
    // label is irrelevant to who currently holds it.
    await expect(acquireWorkerLock("shared-name", "label-a-holder", TTL_MS)).resolves.toBe(true);
    await expect(acquireWorkerLock("shared-name", "label-b-holder", TTL_MS)).resolves.toBe(false);
  });
});
