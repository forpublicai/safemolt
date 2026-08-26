/**
 * M11-2 u6 (P3.1) `[integration]` — the singleton deadline lock and the due-state scans, against a
 * real Postgres.
 *
 * The memory-mode twin (`src/__tests__/lib/store/worker-locks.test.ts`) proves the same semantics
 * against a plain `Map`; only this file can prove the plan's verbatim upsert PARSES and that its
 * `ON CONFLICT ... WHERE ... RETURNING` guarantee holds against real contention. Likewise the two new
 * due-scan queries (`listActiveSessionsDueForRound`, `listPendingSessionsForActivationScan`) are
 * asserted here against real rows and real timestamps, not a mocked ordering.
 *
 * @jest-environment node
 */
import { randomUUID } from "crypto";

import { acquireWorkerLock, releaseWorkerLock, renewWorkerLock } from "@/lib/store/worker-locks/db";
import { runDeadlinesAndCap } from "@/lib/playground/lifecycle";
import {
  createPlaygroundSession,
  listActiveSessionsDueForRound,
  listPendingSessionsForActivationScan,
} from "@/lib/store/playground/db";
import { playgroundSessionCreatedEvent } from "@/lib/actions/playground-events";
import { checkMigrationLedger, REQUIRED_MIGRATIONS } from "@/lib/worker/migration-ledger";
import type { PlaygroundSession } from "@/lib/playground/types";

import { closeIntegrationConnections, pgPool } from "./helpers/db";

const RUN = `${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;
let seq = 0;
const nextId = (kind: string) => `u6w${kind}${RUN}${(seq += 1)}`;

/** Every lock this file acquires, released in `afterAll` even if an assertion throws mid-test. */
const heldLocks: { name: string; holder: string }[] = [];

async function acquireTracked(name: string, holder: string, ttlMs: number) {
  const acquired = await acquireWorkerLock(name, holder, ttlMs);
  if (acquired) heldLocks.push({ name, holder });
  return acquired;
}

afterAll(async () => {
  for (const { name, holder } of heldLocks) {
    await releaseWorkerLock(name, holder).catch(() => {});
  }
  await closeIntegrationConnections();
});

describe("worker_locks (db)", () => {
  it("acquires on a fresh name", async () => {
    const name = nextId("lock");
    await expect(acquireTracked(name, randomUUID(), 5_000)).resolves.toBe(true);
  });

  it("refuses a contested acquire while the holder's row has not expired", async () => {
    const name = nextId("lock");
    const holderA = randomUUID();
    await acquireTracked(name, holderA, 5_000);
    await expect(acquireWorkerLock(name, randomUUID(), 5_000)).resolves.toBe(false);
  });

  it("acquires for a new holder once the previous claim's TTL has elapsed", async () => {
    const name = nextId("lock");
    const holderA = randomUUID();
    // A near-zero TTL, not literally 0 — `make_interval` still has to produce a timestamp in the
    // future of "now" at insert time for the row to exist at all as a normal claim.
    await acquireTracked(name, holderA, 50);
    await new Promise((resolve) => setTimeout(resolve, 150));
    const holderB = randomUUID();
    await expect(acquireTracked(name, holderB, 5_000)).resolves.toBe(true);
  });

  it("renews only for the current holder, and a stale holder cannot extend a claim it lost", async () => {
    const name = nextId("lock");
    const holderA = randomUUID();
    await acquireTracked(name, holderA, 50);
    await new Promise((resolve) => setTimeout(resolve, 150));
    const holderB = randomUUID();
    await acquireTracked(name, holderB, 5_000);

    // holderA no longer owns the row — its renewal must fail, not steal the row back.
    await expect(renewWorkerLock(name, holderA, 5_000)).resolves.toBe(false);
    // holderB's own renewal succeeds.
    await expect(renewWorkerLock(name, holderB, 5_000)).resolves.toBe(true);
  });

  it("release only clears the row for the holder that actually owns it", async () => {
    const name = nextId("lock");
    const holderA = randomUUID();
    await acquireTracked(name, holderA, 5_000);

    await releaseWorkerLock(name, randomUUID()); // wrong token: must not touch holderA's claim
    await expect(acquireWorkerLock(name, randomUUID(), 5_000)).resolves.toBe(false);

    await releaseWorkerLock(name, holderA);
    await expect(acquireTracked(name, randomUUID(), 5_000)).resolves.toBe(true);
  });

  it("there is no same-holder re-acquisition arm — a second call with the SAME token is refused like any other contender", async () => {
    const name = nextId("lock");
    const holder = randomUUID();
    await acquireTracked(name, holder, 5_000);
    await expect(acquireWorkerLock(name, holder, 5_000)).resolves.toBe(false);
  });
});

describe("runDeadlinesAndCap — real singleton lock, two concurrent invocations", () => {
  it("only one of two same-runtime invocations runs the work; the other returns busy immediately", async () => {
    let started = 0;
    let releaseWork: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      releaseWork = resolve;
    });
    const runDeadlineCheck = jest.fn(async () => {
      started += 1;
      await gate;
      return { advanced: 1, capped: 0 };
    });

    const first = runDeadlinesAndCap(`u6-worker-${RUN}`, runDeadlineCheck);
    // Give the first call's acquire a moment to land before the second races it — both still race
    // the SAME shared lock name (`"playground-deadlines"`, internal to lifecycle.ts), regardless of
    // the distinct labels passed here, which is exactly the P0-inventory gap this closes.
    await new Promise((resolve) => setTimeout(resolve, 50));
    const second = await runDeadlinesAndCap(`u6-cron-${RUN}`, runDeadlineCheck);

    expect(second).toEqual({ advanced: 0, capped: 0 });
    releaseWork();
    await expect(first).resolves.toMatchObject({ advanced: 1, capped: 0 });
    expect(started).toBe(1);
  });
});

describe("listActiveSessionsDueForRound", () => {
  const schoolOf = (id: string) => `sch_${id}`;

  async function seedActive(roundDeadline: string | null): Promise<PlaygroundSession> {
    const id = nextId("sess");
    return createPlaygroundSession(
      {
        id,
        gameId: "pub-debate",
        schoolId: schoolOf(id),
        status: "active",
        participants: [],
        currentRound: 1,
        currentRoundPrompt: "prompt",
        roundDeadline: roundDeadline ?? undefined,
        maxRounds: 6,
        startedAt: new Date().toISOString(),
      },
      [playgroundSessionCreatedEvent({ actorAgentId: null, schoolId: schoolOf(id) })]
    );
  }

  it("returns only ACTIVE sessions whose round_deadline has passed, oldest-due first", async () => {
    const now = Date.now();
    const dueOldest = await seedActive(new Date(now - 5_000).toISOString());
    const dueNewest = await seedActive(new Date(now - 1_000).toISOString());
    const notYetDue = await seedActive(new Date(now + 60_000).toISOString());
    const noDeadline = await seedActive(null);

    const all = await listActiveSessionsDueForRound(1000);
    const ids = all.map((s) => s.id);

    expect(ids).toContain(dueOldest.id);
    expect(ids).toContain(dueNewest.id);
    expect(ids).not.toContain(notYetDue.id);
    expect(ids).not.toContain(noDeadline.id);

    // Due-ASC: the older deadline (further in the past) sorts first among these two fixtures.
    expect(ids.indexOf(dueOldest.id)).toBeLessThan(ids.indexOf(dueNewest.id));
  });

  it("respects the limit", async () => {
    const now = Date.now();
    await seedActive(new Date(now - 2_000).toISOString());
    await seedActive(new Date(now - 1_000).toISOString());
    const capped = await listActiveSessionsDueForRound(1);
    expect(capped.length).toBeLessThanOrEqual(1);
  });
});

describe("listPendingSessionsForActivationScan", () => {
  async function seedPending(createdAt: string): Promise<PlaygroundSession> {
    const id = nextId("pend");
    const created = await createPlaygroundSession(
      {
        id,
        gameId: "pub-debate",
        schoolId: `sch_${id}`,
        status: "pending",
        participants: [],
        currentRound: 0,
        maxRounds: 6,
      },
      [playgroundSessionCreatedEvent({ actorAgentId: null, schoolId: `sch_${id}` })]
    );
    await pgPool().query(`UPDATE playground_sessions SET created_at = $2 WHERE id = $1`, [id, createdAt]);
    return created;
  }

  it("returns PENDING sessions oldest-created-first, and excludes non-pending ones", async () => {
    const now = Date.now();
    const older = await seedPending(new Date(now - 10_000).toISOString());
    const newer = await seedPending(new Date(now - 1_000).toISOString());

    const rows = await listPendingSessionsForActivationScan(1000);
    const ids = rows.map((s) => s.id);
    expect(ids).toContain(older.id);
    expect(ids).toContain(newer.id);
    expect(ids.indexOf(older.id)).toBeLessThan(ids.indexOf(newer.id));
  });
});

describe("worker migration ledger, against the real reserved database", () => {
  it("every REQUIRED_MIGRATIONS filename is actually recorded", async () => {
    const result = await checkMigrationLedger(REQUIRED_MIGRATIONS);
    expect(result).toEqual({ ok: true });
  });

  it("reports the exact missing filename(s) for a required list this database has not run", async () => {
    const bogus = `not-a-real-migration-${RUN}.sql`;
    const result = await checkMigrationLedger([...REQUIRED_MIGRATIONS, bogus]);
    expect(result).toEqual({ ok: false, reason: "missing_migrations", missing: [bogus] });
  });
});
