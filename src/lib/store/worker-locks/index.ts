import { pickStore } from "../pick-store";
import * as db from "./db";
import * as mem from "./memory";

/**
 * M11-2 u6 P3.1 — the generic singleton-lock store facade.
 *
 * `worker_locks` is a one-row-per-`name` DB mutex (see `db.ts`); the memory twin is a process-wide
 * `Map` under the same key. Nothing else in this domain: no seed, no listing — a lock either exists
 * and is held, or it doesn't.
 */
export const acquireWorkerLock = pickStore(db.acquireWorkerLock, mem.acquireWorkerLock);
export const renewWorkerLock = pickStore(db.renewWorkerLock, mem.renewWorkerLock);
export const releaseWorkerLock = pickStore(db.releaseWorkerLock, mem.releaseWorkerLock);

// `__resetWorkerLocksForTests` is deliberately NOT re-exported here: it is a memory-only test seam
// (`src/lib/store/worker-locks/memory.ts`), and its one caller (`worker-locks.test.ts`) imports it
// directly from that file rather than through the facade — keeping it off the facade means it never
// needs an export-manifest.ts classification at all.
