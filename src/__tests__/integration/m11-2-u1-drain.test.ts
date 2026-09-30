/**
 * M11-2 u1 `[integration]` — the drain machinery against the real database.
 *
 * Every claim P2.2 makes is about things a mock cannot have: a sequence that allocates ids before
 * commit, a transaction held open across a drain, a primary key that serializes two drainers, a
 * conditional upsert whose zero-row outcome IS the fencing decision. So the whole of the retry
 * ledger, the fence, the floor and the sweep is proven here or nowhere.
 *
 * `EVENT_FLOOR_GRACE_MS` is 0 throughout. The grace exists in production to bound exposure to ids
 * that commit late; with it at its default the floor would not move inside a test's lifetime and
 * the below-floor gates — the ones that matter most — would be vacuous.
 */
import type { Client } from "pg";
import { closeIntegrationConnections, pgClient, pgPool } from "./helpers/db";
import { rejections, runConcurrently } from "./helpers/concurrency";
import { PermanentEffectError } from "@/lib/events/errors";
import type { PreparedEvent } from "@/lib/events/kinds";
import { emitEvent } from "@/lib/store/events/db";
import {
  activateEventConsumer,
  beginEventDrainHeartbeat,
  drainEventConsumer,
  pruneEventLedgers,
  readDrainBarrierState,
  recordEventDrainHeartbeat,
  redriveEventDeadLetter,
  sweepEventConsumer,
  DRAIN_WORKER_ID,
  type EventConsumerDescriptor,
} from "@/lib/store/events/drain-db";
import type { StoredEvent } from "@/lib/store-types";

const RUN = `${Date.now().toString(36)}_${Math.floor(Math.random() * 1e6).toString(36)}`;
const consumerName = (suffix: string) => `u1d_${suffix}_${RUN}`;

let baselineEventId = 0;
const SAVED_ENV: Record<string, string | undefined> = {};
const TOUCHED = [
  "EVENT_FLOOR_GRACE_MS",
  "EVENT_RETRY_BACKOFF_MS",
  "EVENT_CLAIM_LEASE_MS",
  "EVENT_DRAIN_BUDGET_MS",
  "CRON_SECRET",
  "ALLOW_INSECURE_CRON",
];

const fence = (consumer: string): PreparedEvent<"system.activation_fence"> => ({
  kind: "system.activation_fence",
  payload: { consumer },
});

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * A rendezvous for handlers that must be in flight AT THE SAME TIME.
 *
 * Starting two drains concurrently does not make them concurrent where it matters: the first can
 * finish its whole pass before the second's scan runs, and a race test that serialized proves only
 * that the serial path works. Holding every participant inside its effect until all of them have
 * arrived is what puts the conflict under test.
 */
function openBarrier(participants: number) {
  let arrivals = 0;
  let release = () => {};
  const opened = new Promise<void>((resolve) => {
    release = resolve;
  });
  return {
    get arrivals() {
      return arrivals;
    },
    async arriveAndWait(): Promise<void> {
      arrivals += 1;
      if (arrivals >= participants) release();
      await opened;
    },
  };
}

/** One handler held open on demand, with a promise that resolves once it has been entered. */
function openHandler() {
  let release = () => {};
  let markStarted = () => {};
  const blocked = new Promise<void>((resolve) => {
    release = resolve;
  });
  const started = new Promise<void>((resolve) => {
    markStarted = resolve;
  });
  return { release: () => release(), started, blocked, markStarted: () => markStarted() };
}

/** A consumer that records what it was given, so "applied exactly once" is observable. */
function recorder(name: string, failOn?: (event: StoredEvent) => Error | null) {
  const seen: number[] = [];
  const descriptor: EventConsumerDescriptor = {
    name,
    handleEvent: async (event) => {
      const failure = failOn?.(event) ?? null;
      if (failure) throw failure;
      seen.push(event.id);
    },
  };
  return { seen, descriptor };
}

async function emitFence(label: string): Promise<number> {
  return (await emitEvent(fence(label))).id;
}

/** An event inserted outside the store, for kinds or ids the store would refuse to write. */
async function insertRawEvent(kind: string, id?: number): Promise<number> {
  const { rows } = id
    ? await pgPool().query(
        `INSERT INTO events (id, kind, payload) VALUES ($1, $2, '{}'::jsonb) RETURNING id`,
        [id, kind]
      )
    : await pgPool().query(`INSERT INTO events (kind, payload) VALUES ($1, '{}'::jsonb) RETURNING id`, [kind]);
  return Number(rows[0].id);
}

/** An unrelated write inside an open transaction: it is what gives that transaction its xid. */
async function seedHolderAgent(client: Client, label: string): Promise<void> {
  await client.query(
    `INSERT INTO agents (id, name, description, api_key, points, vote_points, evaluation_points,
                         legacy_unattributed_points, follower_count, is_claimed, created_at, is_vetted)
     VALUES ($1, $1, '', $2, 0, 0, 0, 0, 0, false, NOW(), true)`,
    [`u1d_agent_${RUN}_${label}`, `u1d_key_${RUN}_${label}`]
  );
}

async function cursorOf(name: string): Promise<{ floor: number; cutoff: number }> {
  const { rows } = await pgPool().query(
    `SELECT last_event_id, activation_cutoff FROM event_consumers WHERE consumer = $1`,
    [name]
  );
  return { floor: Number(rows[0].last_event_id), cutoff: Number(rows[0].activation_cutoff) };
}

async function receiptIds(name: string): Promise<number[]> {
  const { rows } = await pgPool().query(
    `SELECT event_id FROM event_receipts WHERE consumer = $1 ORDER BY event_id`,
    [name]
  );
  return rows.map((row) => Number(row.event_id));
}

async function failureRow(name: string, eventId: number) {
  const { rows } = await pgPool().query(
    `SELECT attempts, last_error, next_attempt_at, claim_token, lease_expires_at
     FROM event_consumer_failures WHERE consumer = $1 AND event_id = $2`,
    [name, eventId]
  );
  return rows[0] ?? null;
}

/** How far the pacing stamp is from NOW, measured on the server rather than against a local clock. */
async function secondsUntilNextAttempt(name: string, eventId: number): Promise<number> {
  const { rows } = await pgPool().query(
    `SELECT extract(epoch FROM (next_attempt_at - now())) AS secs
     FROM event_consumer_failures WHERE consumer = $1 AND event_id = $2`,
    [name, eventId]
  );
  return Number(rows[0].secs);
}

/**
 * How many claim statements are blocked right now, identified by their marker comment.
 *
 * Deliberately NOT `waitersOn(holderPid)`: lock waiters QUEUE, so the second claimant is reported
 * as blocked by the first claimant rather than by the row's holder, and a filter on the holder's
 * pid sees only one of the two. What matters here is that both claims are waiting at all — the
 * marker is what proves they are the statement under test and not some other backend.
 */
async function blockedClaimants(): Promise<number> {
  const { rows } = await pgPool().query<{ c: number }>(
    `SELECT count(*)::int AS c FROM pg_stat_activity
     WHERE datname = current_database()
       AND pid <> pg_backend_pid()
       AND cardinality(pg_blocking_pids(pid)) > 0
       AND query LIKE '%events:claim%'`
  );
  return rows[0].c;
}

/** Force a claim's lease to have expired, which is what every other drainer sees when it lapses. */
async function expireLease(name: string, eventId: number): Promise<void> {
  await pgPool().query(
    `UPDATE event_consumer_failures SET lease_expires_at = now() - interval '1 minute'
     WHERE consumer = $1 AND event_id = $2`,
    [name, eventId]
  );
}

/** The audit row's timestamp. A replay that REPLACED the row would keep the count and move this. */
async function deadLetterStamp(name: string, eventId: number): Promise<string | null> {
  const { rows } = await pgPool().query(
    `SELECT created_at FROM event_dead_letters WHERE consumer = $1 AND event_id = $2`,
    [name, eventId]
  );
  return rows[0] ? new Date(rows[0].created_at).toISOString() : null;
}

async function deadLetterCount(name: string, eventId: number): Promise<number> {
  const { rows } = await pgPool().query(
    `SELECT count(*)::int AS c FROM event_dead_letters WHERE consumer = $1 AND event_id = $2`,
    [name, eventId]
  );
  return rows[0].c;
}

beforeAll(async () => {
  for (const key of TOUCHED) SAVED_ENV[key] = process.env[key];
  process.env.EVENT_FLOOR_GRACE_MS = "0";
  const { rows } = await pgPool().query(`SELECT COALESCE(max(id), 0) AS id FROM events`);
  baselineEventId = Number(rows[0].id);
});

/**
 * Retry pacing goes back to the production defaults between tests.
 *
 * A test that shortens the backoff and leaves it shortened silently disarms every later test that
 * depends on a failure staying paced — which is exactly how the head-of-line gate below first went
 * green against a drain that had processed the "deferred" rows after all.
 */
afterEach(() => {
  delete process.env.EVENT_RETRY_BACKOFF_MS;
  delete process.env.EVENT_CLAIM_LEASE_MS;
  delete process.env.EVENT_DRAIN_BUDGET_MS;
});

afterAll(async () => {
  const like = `u1d_%${RUN}`;
  await pgPool().query(`DELETE FROM event_dead_letters WHERE consumer LIKE $1`, [like]);
  await pgPool().query(`DELETE FROM event_consumer_failures WHERE consumer LIKE $1`, [like]);
  await pgPool().query(`DELETE FROM event_receipts WHERE consumer LIKE $1`, [like]);
  await pgPool().query(`DELETE FROM event_consumers WHERE consumer LIKE $1`, [like]);
  await pgPool().query(`DELETE FROM events WHERE id > $1`, [baselineEventId]);
  await pgPool().query(`DELETE FROM agents WHERE id LIKE $1`, [`u1d_agent_${RUN}%`]);
  await pgPool().query(`DELETE FROM worker_heartbeats WHERE worker_id LIKE $1`, [`u1d_worker_${RUN}%`]);
  for (const key of TOUCHED) {
    if (SAVED_ENV[key] === undefined) delete process.env[key];
    else process.env[key] = SAVED_ENV[key];
  }
  await closeIntegrationConnections();
});

describe("activation", () => {
  it("is a no-op before it happens: an inactive consumer drains nothing", async () => {
    const name = consumerName("inactive");
    await emitFence("before-activation");
    const rec = recorder(name);

    expect(await drainEventConsumer(rec.descriptor)).toEqual({
      processed: 0,
      receipted: 0,
      failed: 0,
      deadLettered: 0,
    });
    expect(rec.seen).toEqual([]);
  });

  /**
   * The fence classifies by ID, never by commit time. The pre-activation event's id is allocated
   * before the fence's but commits after it — a committed-`max(id)` cutoff would have called it
   * post-activation and handed the router a stale wakeup.
   */
  it("fences pre-activation events even when their transaction commits later", async () => {
    const name = consumerName("fence");
    const holder = await pgClient();
    let preId = 0;
    try {
      await holder.query("BEGIN");
      const { rows } = await holder.query(
        `INSERT INTO events (kind, payload) VALUES ('system.activation_fence', '{}'::jsonb) RETURNING id`
      );
      preId = Number(rows[0].id);

      const activation = await activateEventConsumer(name);
      expect(activation.activated).toBe(true);
      expect(activation.activationCutoff).toBeGreaterThan(preId);

      await holder.query("COMMIT");
    } finally {
      await holder.end();
    }

    const postId = await emitFence("post-activation");
    const rec = recorder(name);
    await drainEventConsumer(rec.descriptor);
    // The sweep has no floor at all, so if anything could reach a pre-activation event it would.
    await sweepEventConsumer(rec.descriptor);

    expect(rec.seen).toEqual([postId]);
    expect(rec.seen).not.toContain(preId);
  });

  it("writes no second fence and moves no cursor when it is already active", async () => {
    const name = consumerName("reactivate");
    const first = await activateEventConsumer(name);
    const before = await cursorOf(name);
    await emitFence("between");

    const second = await activateEventConsumer(name);
    expect(second).toEqual({ activated: false, activationCutoff: null });
    expect(await cursorOf(name)).toEqual(before);

    const { rows } = await pgPool().query(
      `SELECT count(*)::int AS c FROM events
       WHERE kind = 'system.activation_fence' AND payload->>'consumer' = $1`,
      [name]
    );
    expect(rows[0].c).toBe(1);
    expect(first.activationCutoff).toBe(before.cutoff);
  });
});

describe("happy path", () => {
  it("applies each event once, receipts it, and does not re-apply on the next pass", async () => {
    const name = consumerName("happy");
    await activateEventConsumer(name);
    const ids = [await emitFence("e1"), await emitFence("e2"), await emitFence("e3")];

    const rec = recorder(name);
    expect(await drainEventConsumer(rec.descriptor)).toEqual({
      processed: 3,
      receipted: 3,
      failed: 0,
      deadLettered: 0,
    });
    expect(rec.seen).toEqual(ids);
    expect(await receiptIds(name)).toEqual(ids);

    const again = await drainEventConsumer(rec.descriptor);
    expect(again.processed).toBe(0);
    expect(rec.seen).toEqual(ids);
  });

  /**
   * The phase deadline stops a pass taking on NEW work, and leaves everything it did not take
   * unreceipted for the next invocation. A batch size bounds the row count and says nothing about
   * the time, so without this one consumer's external work decides whether any other phase runs.
   */
  it("stops claiming events once its phase deadline has passed, and resumes next pass", async () => {
    const name = consumerName("deadline");
    await activateEventConsumer(name);
    const ids = [await emitFence("d1"), await emitFence("d2")];

    const expired = recorder(name);
    expect(await drainEventConsumer(expired.descriptor, { deadline: Date.now() - 1 })).toEqual({
      processed: 0,
      receipted: 0,
      failed: 0,
      deadLettered: 0,
    });
    expect(expired.seen).toEqual([]);
    expect(await receiptIds(name)).toEqual([]);

    const inTime = recorder(name);
    await drainEventConsumer(inTime.descriptor, { deadline: Date.now() + 60_000 });
    expect(inTime.seen).toEqual(ids);
    expect(await receiptIds(name)).toEqual(ids);
  });

  /**
   * Two drainers, one consumer. Effects MAY duplicate — that is what "at-least-once + idempotent"
   * means and why every consumer effect carries a natural key — but the receipt primary key admits
   * exactly one row per event, and the floor is written with `GREATEST` so it cannot regress.
   */
  it("survives concurrent drains: receipts stay unique and the floor never regresses", async () => {
    const name = consumerName("concurrent");
    await activateEventConsumer(name);
    const ids = [await emitFence("c1"), await emitFence("c2"), await emitFence("c3"), await emitFence("c4")];
    const floorBefore = (await cursorOf(name)).floor;

    // Both drains must genuinely overlap. Started without a rendezvous the first can finish its
    // whole pass before the second scans, and the second then finds four receipted events — which
    // satisfies "unique receipts" and "floor did not regress" without any concurrency at all.
    const barrier = openBarrier(2);
    const seen: number[][] = [[], []];
    const drainer = (slot: number): EventConsumerDescriptor => ({
      name,
      handleEvent: async (event) => {
        await barrier.arriveAndWait();
        seen[slot].push(event.id);
      },
    });

    const outcomes = await runConcurrently([
      () => drainEventConsumer(drainer(0)),
      () => drainEventConsumer(drainer(1)),
    ]);

    expect(rejections(outcomes)).toEqual([]);
    expect(barrier.arrivals).toBeGreaterThanOrEqual(2); // The passes really did overlap.
    expect(await receiptIds(name)).toEqual(ids);
    expect([...new Set([...seen[0], ...seen[1]])].sort((x, y) => x - y)).toEqual(ids);
    const floorAfter = (await cursorOf(name)).floor;
    expect(floorAfter).toBeGreaterThanOrEqual(floorBefore);
    expect(floorAfter).toBeGreaterThanOrEqual(ids[ids.length - 1]);
  });
});

describe("retry ledger", () => {
  it("records one paced attempt, blocks nothing else, and defers the retry", async () => {
    const name = consumerName("poison");
    await activateEventConsumer(name);
    const good1 = await emitFence("g1");
    const poison = await emitFence("p");
    const good2 = await emitFence("g2");

    const rec = recorder(name, (event) => (event.id === poison ? new Error("transient outage") : null));
    const counts = await drainEventConsumer(rec.descriptor);

    // No head-of-line blocking: the event AFTER the failure is processed in the same pass.
    expect(rec.seen).toEqual([good1, good2]);
    expect(counts).toEqual({ processed: 3, receipted: 2, failed: 1, deadLettered: 0 });
    expect(await receiptIds(name)).toEqual([good1, good2]);

    const failure = await failureRow(name, poison);
    expect(failure.attempts).toBe(1);
    expect(failure.last_error).toContain("transient outage");
    // The first backoff step is a minute, so a drain seconds later must not spend a second attempt.
    const delayMs = new Date(failure.next_attempt_at).getTime() - Date.now();
    expect(delayMs).toBeGreaterThan(30_000);
    expect(delayMs).toBeLessThan(90_000);

    // Not merely unattempted — not even a CANDIDATE. The backoff is applied by the scan, so a
    // paced failure cannot occupy a slot in a later batch.
    const second = await drainEventConsumer(rec.descriptor);
    expect(second).toEqual({ processed: 0, receipted: 0, failed: 0, deadLettered: 0 });
    expect((await failureRow(name, poison)).attempts).toBe(1);
  });

  /**
   * Two drainers failing the same fresh event record ONE attempt. Registration is
   * `ON CONFLICT DO NOTHING`, never an increment: an incrementing conflict arm sees only the lease
   * and would let a slow concurrent attempt spend a second try inside a backoff window it never
   * checked, so three attempts would stop spanning three backoff intervals.
   */
  it("collapses concurrent first failures into one recorded attempt", async () => {
    const name = consumerName("collapse");
    await activateEventConsumer(name);
    const poison = await emitFence("raced-failure");

    // Barriered, not merely started together. `runConcurrently` alone lets one drain finish before
    // the other's scan begins, and a serialized pair proves nothing about a collapse: the second
    // drainer would find a paced failure row and skip it, passing the same assertions for a reason
    // that has nothing to do with the conflict arm under test. Both handlers are held inside the
    // effect until both have certainly scanned an event with no ledger row at all.
    const barrier = openBarrier(2);
    const failing: EventConsumerDescriptor = {
      name,
      handleEvent: async () => {
        await barrier.arriveAndWait();
        throw new Error("both fail");
      },
    };

    const outcomes = await runConcurrently([
      () => drainEventConsumer(failing),
      () => drainEventConsumer(failing),
    ]);

    expect(rejections(outcomes)).toEqual([]);
    expect(barrier.arrivals).toBe(2); // Both really were in flight at once.
    const recorded = outcomes.reduce(
      (total, outcome) => total + (outcome.ok ? (outcome.value as { failed: number }).failed : 0),
      0
    );
    expect(recorded).toBe(1);
    expect((await failureRow(name, poison)).attempts).toBe(1);
    expect(await receiptIds(name)).toEqual([]);
  });

  /**
   * The same collapse one step later, where a different mechanism has to hold it.
   *
   * A ready RETRY is not registered, it is CLAIMED, and the claim is a conditional `UPDATE` on a
   * row both drainers can see as ready. Postgres serializes them: the loser blocks, re-evaluates
   * the row the winner just leased, fails the predicate and gets zero rows — so only one drainer
   * ever invokes the effect, and only one attempt is spent. Without that, a worker and a cron
   * arriving together would burn two of the three attempts on one outage.
   */
  it("lets exactly one drainer claim a retry whose backoff has elapsed", async () => {
    process.env.EVENT_RETRY_BACKOFF_MS = "1";
    const name = consumerName("retryrace");
    await activateEventConsumer(name);
    const poison = await emitFence("ready-retry");

    await drainEventConsumer(recorder(name, () => new Error("still failing")).descriptor);
    expect((await failureRow(name, poison)).attempts).toBe(1);
    expect(await secondsUntilNextAttempt(name, poison)).toBeLessThanOrEqual(0);

    // BOTH drainers must be inside `claimFailedEvent` at once, which needs the row held from
    // outside: start one and wait for its lease and the other simply finds a leased row and skips,
    // proving only that the scan filter works. So the failures row is locked in an open `pg`
    // transaction, both drains scan it as ready, both block on the claim UPDATE, and the lock is
    // released with the two of them contending for the same row.
    const holder = await pgClient();
    const ran: number[] = [];
    let outcomes: Awaited<ReturnType<typeof runConcurrently>> = [];
    try {
      await holder.query("BEGIN");
      await holder.query(
        `SELECT 1 FROM event_consumer_failures WHERE consumer = $1 AND event_id = $2 FOR UPDATE`,
        [name, poison]
      );
      const contender: EventConsumerDescriptor = {
        name,
        handleEvent: async (event) => {
          ran.push(event.id);
          throw new Error("still failing");
        },
      };
      const races = runConcurrently([
        () => drainEventConsumer(contender),
        () => drainEventConsumer(contender),
      ]);

      // Both claims are genuinely waiting on the held row before anything is released — asserted
      // from the catalog, never from elapsed time.
      const deadline = Date.now() + 20_000;
      let waiting = 0;
      while (Date.now() < deadline) {
        waiting = await blockedClaimants();
        if (waiting >= 2) break;
        await sleep(50);
      }
      expect(waiting).toBeGreaterThanOrEqual(2);

      await holder.query("COMMIT");
      outcomes = await races;
    } finally {
      await holder.end();
    }

    expect(rejections(outcomes)).toEqual([]);
    // One claim won, so one effect ran and one attempt was spent — the loser's conditional UPDATE
    // re-evaluated the row the winner had just leased and matched nothing.
    expect(ran).toEqual([poison]);
    const recorded = outcomes.reduce(
      (total, outcome) => total + (outcome.ok ? (outcome.value as { failed: number }).failed : 0),
      0
    );
    expect(recorded).toBe(1);
    expect((await failureRow(name, poison)).attempts).toBe(2);
    expect(await deadLetterCount(name, poison)).toBe(0);
  });

  /**
   * A success and a concurrent FIRST transient failure on the same event, in both orders.
   *
   * Whichever lands first, the loser's ledger row would be unreachable — a receipted event is never
   * scanned again — so it would sit behind the receipt until retention, months later, looking like
   * a pending retry. Two guards cover the two orders: every receipt-writing statement clears an
   * unleased failure row, and a first-failure registration refuses once a receipt exists.
   */
  it("leaves no orphan failure row when a success races a first failure, either way round", async () => {
    const name = consumerName("orphan");
    await activateEventConsumer(name);

    // Order A — the failure registers first, and the success cleans up behind it.
    const firstEvent = await emitFence("failure-then-success");
    const slowSuccess = openHandler();
    const successRun = drainEventConsumer({
      name,
      handleEvent: async () => {
        slowSuccess.markStarted();
        await slowSuccess.blocked;
      },
    });
    await slowSuccess.started;
    await drainEventConsumer(recorder(name, () => new Error("transient")).descriptor);
    expect((await failureRow(name, firstEvent)).attempts).toBe(1);

    slowSuccess.release();
    expect(await successRun).toMatchObject({ receipted: 1 });
    expect(await receiptIds(name)).toEqual([firstEvent]);
    expect(await failureRow(name, firstEvent)).toBeNull();

    // Order B — the success receipts first, and the late failure declines to register at all.
    const secondEvent = await emitFence("success-then-failure");
    const slowFailure = openHandler();
    const failureRun = drainEventConsumer({
      name,
      handleEvent: async () => {
        slowFailure.markStarted();
        await slowFailure.blocked;
        throw new Error("transient, and too late");
      },
    });
    await slowFailure.started;
    expect(await drainEventConsumer(recorder(name).descriptor)).toMatchObject({ receipted: 1 });

    slowFailure.release();
    expect(await failureRun).toMatchObject({ failed: 0 });
    expect(await failureRow(name, secondEvent)).toBeNull();
    expect(await receiptIds(name)).toEqual([firstEvent, secondEvent].sort((a, b) => a - b));
  });

  /**
   * Success and a permanent failure on the SAME never-failed event, both in flight.
   *
   * These are two mutually exclusive verdicts, and "no failures row exists" cannot separate them —
   * both attempts observe the same absence. The receipt's primary key is the arbiter: the
   * permanent path inserts its receipt first and writes the dead letter only for the row it
   * inserted itself, so a success that receipted first suppresses the dead letter completely.
   * Without that, an event that was handled successfully would carry a terminal audit row saying
   * it never was.
   */
  it("does not dead-letter an event a concurrent drainer had already receipted as handled", async () => {
    const name = consumerName("successrace");
    await activateEventConsumer(name);
    const contested = await emitFence("two-verdicts");

    let releasePermanent = () => {};
    let markPermanentStarted = () => {};
    const permanentBlocked = new Promise<void>((resolve) => {
      releasePermanent = resolve;
    });
    const permanentStarted = new Promise<void>((resolve) => {
      markPermanentStarted = resolve;
    });
    const permanent: EventConsumerDescriptor = {
      name,
      handleEvent: async () => {
        markPermanentStarted();
        await permanentBlocked;
        throw new PermanentEffectError("this payload can never resolve");
      },
    };

    const permanentRun = drainEventConsumer(permanent);
    await permanentStarted; // Both attempts are now in flight on one never-failed event.

    const success = recorder(name);
    expect(await drainEventConsumer(success.descriptor)).toMatchObject({ receipted: 1 });

    releasePermanent();
    const permanentCounts = await permanentRun;

    expect(success.seen).toEqual([contested]);
    expect(permanentCounts).toEqual({ processed: 1, receipted: 0, failed: 0, deadLettered: 0 });
    expect(await deadLetterCount(name, contested)).toBe(0);
    expect(await receiptIds(name)).toEqual([contested]);
  });

  /**
   * The same arbitration on the CLAIMED path, which holding the claim does not exempt.
   *
   * A first attempt whose lease lapsed can still be running, and it can still succeed and receipt.
   * A terminal finalization that wrote its dead letter from the claim alone would then mark an
   * event permanently failed that had in fact been handled — the audit row and the receipt telling
   * opposite stories about the same event. The receipt insert arbitrates: the claim is released and
   * the attempt is counted, but no dead letter is added.
   */
  it("does not dead-letter a terminal retry when an in-flight first attempt receipted success", async () => {
    const name = consumerName("terminalrace");
    await activateEventConsumer(name);
    const contested = await emitFence("succeeded-then-terminal");

    // The stale first attempt: started before any failures row existed, and it will SUCCEED.
    const slowSuccess = openHandler();
    const succeeded: number[] = [];
    const successRun = drainEventConsumer({
      name,
      handleEvent: async (event) => {
        slowSuccess.markStarted();
        await slowSuccess.blocked;
        succeeded.push(event.id);
      },
    });
    await slowSuccess.started;

    // Meanwhile the event acquires a failure ledger at its last attempt, ready to retry.
    await pgPool().query(
      `INSERT INTO event_consumer_failures (consumer, event_id, attempts, next_attempt_at)
       VALUES ($1, $2, 2, now() - interval '1 minute')`,
      [name, contested]
    );

    // The terminal retry claims it and reaches its own failure, still in flight.
    const slowTerminal = openHandler();
    const terminalRun = drainEventConsumer({
      name,
      handleEvent: async () => {
        slowTerminal.markStarted();
        await slowTerminal.blocked;
        throw new Error("last attempt fails");
      },
    });
    await slowTerminal.started;

    // The success lands FIRST: its receipt is the outcome of record.
    slowSuccess.release();
    await successRun;
    expect(succeeded).toEqual([contested]);
    expect(await receiptIds(name)).toEqual([contested]);

    slowTerminal.release();
    const terminalCounts = await terminalRun;

    expect(terminalCounts).toMatchObject({ failed: 1, deadLettered: 0 });
    expect(await deadLetterCount(name, contested)).toBe(0);
    expect(await failureRow(name, contested)).toBeNull();
    expect(await receiptIds(name)).toEqual([contested]);
  });

  /**
   * Retention may not delete a failure row that is being retried right now.
   *
   * Claiming an attempt does not move `next_attempt_at`, so a long-dormant failure carries a
   * month-old stamp while its effect is in flight. Deleting it mid-attempt destroys the claim the
   * owner's outcome writes are fenced against: the owner would record nothing at all, and the event
   * would quietly restart from zero attempts.
   */
  it("keeps a leased failure row that retention would otherwise call stale", async () => {
    process.env.EVENT_RETRY_BACKOFF_MS = "1";
    const name = consumerName("leasedprune");
    await activateEventConsumer(name);
    const poison = await emitFence("dormant-then-retried");

    await drainEventConsumer(recorder(name, () => new Error("transient")).descriptor);
    expect((await failureRow(name, poison)).attempts).toBe(1);
    await pgPool().query(
      `UPDATE event_consumer_failures SET next_attempt_at = now() - interval '40 days'
       WHERE consumer = $1 AND event_id = $2`,
      [name, poison]
    );

    let release = () => {};
    let markStarted = () => {};
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    const retryRun = drainEventConsumer({
      name,
      handleEvent: async () => {
        markStarted();
        await blocked;
        throw new Error("still transient");
      },
    });
    await started;

    // The claim is live; the pacing stamp is a month old. Retention must read the lease, not the age.
    await pruneEventLedgers();
    const duringPrune = await failureRow(name, poison);
    expect(duringPrune).not.toBeNull();
    expect(duringPrune.attempts).toBe(1);

    release();
    const counts = await retryRun;

    // The owner still owned its claim, so its attempt was recorded rather than silently lost.
    expect(counts).toMatchObject({ failed: 1, deadLettered: 0 });
    expect((await failureRow(name, poison)).attempts).toBe(2);
  });

  /**
   * A lease expires on wall-clock time, so a slow attempt can lose its claim while it is still
   * running. The drainer that reclaims the event owns it from that moment — and when the original
   * attempt finally returns, its writes must change nothing. Fencing only the DELETE would not be
   * enough: an unfenced dead-letter insert from this stale attempt would terminate an event the new
   * owner had just handled successfully, and an unfenced receipt would credit work nobody did.
   */
  it("ignores a stale claimant whose lease was reclaimed mid-effect", async () => {
    process.env.EVENT_RETRY_BACKOFF_MS = "1";
    const name = consumerName("leasetheft");
    await activateEventConsumer(name);
    const contested = await emitFence("contested");

    // Two recorded attempts, so the stale claimant's next failure would FINALIZE if it were heard.
    const failing = recorder(name, () => new Error("transient"));
    await drainEventConsumer(failing.descriptor);
    await drainEventConsumer(failing.descriptor);
    expect((await failureRow(name, contested)).attempts).toBe(2);

    let releaseStale = () => {};
    let markStarted = () => {};
    const staleBlocked = new Promise<void>((resolve) => {
      releaseStale = resolve;
    });
    const staleStarted = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    const stale: EventConsumerDescriptor = {
      name,
      handleEvent: async () => {
        markStarted();
        await staleBlocked;
        throw new Error("stale attempt, finishing after its lease expired");
      },
    };

    const staleRun = drainEventConsumer(stale);
    await staleStarted;
    // Expire the claim rather than sleeping through a real lease. The lease floor is thirty seconds
    // for a good reason — a lease shorter than the work makes every event a race — so a test that
    // waited one out would either take that long or measure a lease no deployment would use.
    await expireLease(name, contested);

    const winner = recorder(name);
    const winnerCounts = await drainEventConsumer(winner.descriptor);
    expect(winnerCounts).toMatchObject({ receipted: 1 });
    expect(winner.seen).toEqual([contested]);

    releaseStale();
    const staleCounts = await staleRun;

    // Nothing the stale attempt did was recorded, in any of the three ledgers.
    expect(staleCounts).toEqual({ processed: 1, receipted: 0, failed: 0, deadLettered: 0 });
    expect(await deadLetterCount(name, contested)).toBe(0);
    expect(await receiptIds(name)).toEqual([contested]);
    expect(await failureRow(name, contested)).toBeNull();
  });

  /**
   * Three attempts, each paced by its own schedule step and each step measured against the SERVER
   * clock. A schedule of "one millisecond three times" would prove the escalation counts but not
   * that the waits are real, and the wait is the property the schedule exists for: three attempts
   * have to span a provider outage, not three passes of the same minute.
   */
  it("dead-letters after three attempts, spaced by the backoff schedule", async () => {
    process.env.EVENT_RETRY_BACKOFF_MS = "2000,4000";
    const name = consumerName("escalate");
    await activateEventConsumer(name);
    const poison = await emitFence("always-fails");
    const rec = recorder(name, () => new Error("still failing"));

    const first = await drainEventConsumer(rec.descriptor);
    expect(first).toMatchObject({ failed: 1, deadLettered: 0 });
    expect((await failureRow(name, poison)).attempts).toBe(1);
    // Measured on the server, and read as "still in the future after a full round trip" — the
    // margins absorb the trip rather than assuming it is instant.
    const firstWait = await secondsUntilNextAttempt(name, poison);
    expect(firstWait).toBeGreaterThan(1);

    // Still paced: a drain inside the window does not even see it as a candidate.
    expect((await drainEventConsumer(rec.descriptor)).processed).toBe(0);

    await sleep(2300);
    const second = await drainEventConsumer(rec.descriptor);
    expect(second).toMatchObject({ failed: 1, deadLettered: 0 });
    expect((await failureRow(name, poison)).attempts).toBe(2);
    // The schedule's SECOND step, not a repeat of the first: the wait grows with the attempt.
    const secondWait = await secondsUntilNextAttempt(name, poison);
    expect(secondWait).toBeGreaterThan(firstWait + 1);

    await sleep(4300);
    const third = await drainEventConsumer(rec.descriptor);
    expect(third).toMatchObject({ failed: 1, deadLettered: 1 });

    // Both halves of the finalization committed, and the ledger row is gone.
    expect(await deadLetterCount(name, poison)).toBe(1);
    expect(await receiptIds(name)).toEqual([poison]);
    expect(await failureRow(name, poison)).toBeNull();

    // Terminal: the anti-join no longer offers it.
    expect((await drainEventConsumer(rec.descriptor)).processed).toBe(0);
  });

  /**
   * A replayed finalization changes nothing. Both conflict targets no-op, which is what makes the
   * one-statement form safe to reach twice — the crash window a two-call form would have.
   *
   * The replay is driven with the dead letter ALREADY present, and the audit row is compared by its
   * timestamp rather than by its count: an insert that replaced the row would keep the count at one
   * while quietly rewriting when the event died. The reported `deadLettered` is 0 for the same
   * reason the counters read from `RETURNING` — this pass added nothing.
   */
  it("no-ops when a finalization is replayed over an existing dead letter", async () => {
    process.env.EVENT_RETRY_BACKOFF_MS = "1";
    const name = consumerName("replay");
    await activateEventConsumer(name);
    const poison = await emitFence("replayed");
    const rec = recorder(name, () => new Error("still failing"));

    await drainEventConsumer(rec.descriptor);
    await drainEventConsumer(rec.descriptor);
    await drainEventConsumer(rec.descriptor);
    expect(await deadLetterCount(name, poison)).toBe(1);
    const original = await deadLetterStamp(name, poison);

    // Put the event back into the state a replayed finalization is reached from, dead letter kept.
    await pgPool().query(`DELETE FROM event_receipts WHERE consumer = $1 AND event_id = $2`, [name, poison]);
    await pgPool().query(
      `INSERT INTO event_consumer_failures (consumer, event_id, attempts, next_attempt_at)
       VALUES ($1, $2, 2, now() - interval '1 minute')`,
      [name, poison]
    );

    // Through the sweep: the finalization already moved the floor past this id.
    const replay = await sweepEventConsumer(rec.descriptor);
    expect(replay).toMatchObject({ failed: 1, deadLettered: 0 });
    expect(await deadLetterCount(name, poison)).toBe(1);
    expect(await deadLetterStamp(name, poison)).toBe(original);
    expect(await receiptIds(name)).toEqual([poison]);
    expect(await failureRow(name, poison)).toBeNull();

    // And with BOTH rows in place, one more sweep is a complete no-op — nothing is even scanned.
    expect(await sweepEventConsumer(rec.descriptor)).toEqual({
      processed: 0,
      receipted: 0,
      failed: 0,
      deadLettered: 0,
    });
    expect(await deadLetterStamp(name, poison)).toBe(original);
  });

  it("dead-letters a permanent contract error on the first attempt", async () => {
    const name = consumerName("permanent");
    await activateEventConsumer(name);
    const bad = await emitFence("malformed");
    const rec = recorder(name, () => new PermanentEffectError("payload cannot ever resolve"));

    const counts = await drainEventConsumer(rec.descriptor);

    expect(counts).toMatchObject({ processed: 1, failed: 1, deadLettered: 1, receipted: 0 });
    expect(await deadLetterCount(name, bad)).toBe(1);
    expect(await receiptIds(name)).toEqual([bad]);
    expect(await failureRow(name, bad)).toBeNull();
  });

  /**
   * Redrive clears the three ledger rows and nothing else — deliberately not the floor, which is
   * written with `GREATEST` and never regresses. A dead-lettered event is always below the floor by
   * the time it is redriven, so the hourly sweep is what reprocesses it. That is the documented
   * cost of keeping the floor monotonic, and it is bounded by the sweep's cadence.
   */
  it("reprocesses a redriven dead letter exactly once, through the sweep", async () => {
    const name = consumerName("redrive");
    await activateEventConsumer(name);
    const bad = await emitFence("redrivable");
    let failing = true;
    const seen: number[] = [];
    const descriptor: EventConsumerDescriptor = {
      name,
      handleEvent: async (event) => {
        if (failing) throw new PermanentEffectError("not yet");
        seen.push(event.id);
      },
    };

    await drainEventConsumer(descriptor);
    expect(await deadLetterCount(name, bad)).toBe(1);

    failing = false;
    expect(await redriveEventDeadLetter(name, bad)).toBe(true);
    expect(await deadLetterCount(name, bad)).toBe(0);
    expect(await receiptIds(name)).toEqual([]);
    expect(await failureRow(name, bad)).toBeNull();

    expect((await drainEventConsumer(descriptor)).processed).toBe(0); // below the floor
    await sweepEventConsumer(descriptor);
    expect(seen).toEqual([bad]);
    expect(await receiptIds(name)).toEqual([bad]);

    await sweepEventConsumer(descriptor);
    expect(seen).toEqual([bad]);
    expect(await redriveEventDeadLetter(name, bad)).toBe(false);
  });

  /**
   * Redriving an id that was never dead-lettered must touch NOTHING.
   *
   * As three independent deletes this was a destructive operation on the wrong input: it removed a
   * succeeded event's valid receipt — scheduling a replay of work that was already done — and any
   * live claim with it, while returning `false` to report that it had done nothing. Chaining every
   * delete to the dead letter's own `RETURNING` is what makes the honest answer the only one.
   */
  it("changes no ledger row when the event was never dead-lettered", async () => {
    const name = consumerName("falseredrive");
    await activateEventConsumer(name);
    const succeeded = await emitFence("plain-success");
    const failing = await emitFence("plain-failure");

    const rec = recorder(name, (event) => (event.id === failing ? new Error("transient") : null));
    await drainEventConsumer(rec.descriptor);
    expect(await receiptIds(name)).toEqual([succeeded]);
    const beforeFailure = await failureRow(name, failing);
    expect(beforeFailure.attempts).toBe(1);

    expect(await redriveEventDeadLetter(name, succeeded)).toBe(false);
    expect(await redriveEventDeadLetter(name, failing)).toBe(false);

    // The success keeps its receipt, and the pending retry keeps its ledger row unchanged.
    expect(await receiptIds(name)).toEqual([succeeded]);
    const afterFailure = await failureRow(name, failing);
    expect(afterFailure.attempts).toBe(beforeFailure.attempts);
    expect(new Date(afterFailure.next_attempt_at).toISOString()).toBe(
      new Date(beforeFailure.next_attempt_at).toISOString()
    );
    expect(await deadLetterCount(name, succeeded)).toBe(0);
  });
});

describe("below the floor", () => {
  /**
   * The adversarial ordering the plan names: an id that appears below the floor after the floor has
   * moved. Receipts decide, so nothing is permanently skipped — but only the sweep, which runs with
   * no floor at all, can see it.
   */
  it("misses a back-filled id on the fast path and consumes it in the sweep", async () => {
    const name = consumerName("gap");
    await activateEventConsumer(name);
    const { rows } = await pgPool().query(`SELECT nextval(pg_get_serial_sequence('events','id')) AS id`);
    const gap = Number(rows[0].id);
    const later = await emitFence("after-gap");

    const rec = recorder(name);
    await drainEventConsumer(rec.descriptor);
    expect(rec.seen).toEqual([later]);
    expect((await cursorOf(name)).floor).toBeGreaterThan(gap);

    await insertRawEvent("system.activation_fence", gap);
    expect((await drainEventConsumer(rec.descriptor)).processed).toBe(0);
    expect(rec.seen).toEqual([later]);

    await sweepEventConsumer(rec.descriptor);
    expect(rec.seen).toEqual([later, gap]);
    expect(await receiptIds(name)).toEqual([gap, later]);
  });

  /**
   * The plan's adversarial ordering, built exactly: an OLDER transaction allocates a HIGHER event
   * id and commits first, while the YOUNGER transaction holding the lower id stays open.
   *
   * That pairing is what defeats a commit-horizon filter. The higher id passes any `xid` horizon
   * and gets consumed; a cursor advanced past it would skip the lower id forever, and an `xmin`
   * predicate would not admit the lower id even after it commits, because its xid is younger than
   * one already crossed. Receipts decide instead, so the sweep consumes it whenever it lands.
   */
  it("processes a younger transaction's lower id after an older transaction's higher id committed", async () => {
    const name = consumerName("xid");
    await activateEventConsumer(name);

    const older = await pgClient();
    const younger = await pgClient();
    const rec = recorder(name);
    let lowId = 0;
    let highId = 0;
    try {
      // The xid is assigned at the first write, so writing here first makes T1 the OLDER one.
      await older.query("BEGIN");
      await seedHolderAgent(older, "older");

      // T2 is younger, and it is the one holding the LOWER event id.
      await younger.query("BEGIN");
      await seedHolderAgent(younger, "younger");
      const low = await younger.query(
        `INSERT INTO events (kind, payload) VALUES ('system.activation_fence', '{}'::jsonb) RETURNING id`
      );
      lowId = Number(low.rows[0].id);

      // The older transaction takes the HIGHER id and commits first.
      const high = await older.query(
        `INSERT INTO events (kind, payload) VALUES ('system.activation_fence', '{}'::jsonb) RETURNING id`
      );
      highId = Number(high.rows[0].id);
      await older.query("COMMIT");

      expect(highId).toBeGreaterThan(lowId);
      await drainEventConsumer(rec.descriptor);
      expect(rec.seen).toEqual([highId]);
      expect((await cursorOf(name)).floor).toBeGreaterThanOrEqual(highId);

      await younger.query("COMMIT");
    } finally {
      await older.end();
      await younger.end();
    }

    expect((await drainEventConsumer(rec.descriptor)).processed).toBe(0);
    await sweepEventConsumer(rec.descriptor);
    expect(rec.seen).toEqual([highId, lowId]);
  });

  /**
   * No `txid`/`xmin` horizon predicate exists anywhere in the drain, and this is what that buys:
   * one long-running transaction elsewhere in the database does not defer a single event.
   */
  it("drains immediately while an unrelated write transaction is held open", async () => {
    const name = consumerName("nonstall");
    await activateEventConsumer(name);

    const holder = await pgClient();
    const rec = recorder(name);
    try {
      await holder.query("BEGIN");
      // A real write, so the holder owns an xid and pins the snapshot horizon.
      await holder.query(
        `INSERT INTO agents (id, name, description, api_key, points, vote_points, evaluation_points,
                             legacy_unattributed_points, follower_count, is_claimed, created_at, is_vetted)
         VALUES ($1, $1, '', $2, 0, 0, 0, 0, 0, false, NOW(), true)`,
        [`u1d_agent_${RUN}_holder`, `u1d_key_${RUN}_holder`]
      );

      const id = await emitFence("during-long-tx");
      await drainEventConsumer(rec.descriptor);
      expect(rec.seen).toEqual([id]);

      await holder.query("ROLLBACK");
    } finally {
      await holder.end();
    }
  });
});

describe("skipped rows never block the head of the line", () => {
  /**
   * A kind this build does not know is skipped WITHOUT a receipt — the backstop that keeps a
   * brand-new kind's first events alive through a mixed-version rollout, since such kinds have no
   * inline writer to fall back on. The price is paid here in full: the floor stops below it. Later
   * events still process, because the scan is a receipt anti-join and not a contiguous cursor.
   */
  it("leaves an unknown kind unreceipted, wedges the floor, and keeps processing later events", async () => {
    const name = consumerName("unknown");
    await activateEventConsumer(name);
    const unknown = await insertRawEvent("not.a.kind");
    const later = await emitFence("after-unknown");

    const rec = recorder(name);
    const counts = await drainEventConsumer(rec.descriptor);

    expect(rec.seen).toEqual([later]);
    // The unknown row is not examined at all: the candidate query excludes it, so it can never
    // occupy a slot in the batch.
    expect(counts).toEqual({ processed: 1, receipted: 1, failed: 0, deadLettered: 0 });
    expect(await receiptIds(name)).toEqual([later]);
    expect(await failureRow(name, unknown)).toBeNull();
    expect((await cursorOf(name)).floor).toBeLessThan(unknown);

    const another = await emitFence("after-again");
    await drainEventConsumer(rec.descriptor);
    expect(rec.seen).toEqual([later, another]);
    expect((await cursorOf(name)).floor).toBeLessThan(unknown);
  });

  /**
   * The reason the skips live in SQL rather than in JavaScript. `LIMIT` applies before any
   * caller-side filter, so a batch-sized block of paced failures and newer-build kinds would fill
   * every page and starve every later event for that consumer — for as long as the block lasted,
   * which for an unknown kind means until the newer build is everywhere. A batch of ONE, behind
   * three unusable rows, still reaches the event behind them.
   */
  it("reaches a later event with a batch smaller than the block of skipped rows ahead of it", async () => {
    const name = consumerName("headofline");
    await activateEventConsumer(name);
    const firstPoison = await emitFence("blocker-1");
    const secondPoison = await emitFence("blocker-2");

    const failing = recorder(name, () => new Error("paced out for a minute"));
    await drainEventConsumer(failing.descriptor);
    expect((await failureRow(name, firstPoison)).attempts).toBe(1);
    expect((await failureRow(name, secondPoison)).attempts).toBe(1);

    await insertRawEvent("not.a.kind");
    const reachable = await emitFence("behind-the-block");

    const rec = recorder(name);
    const counts = await drainEventConsumer(rec.descriptor, { batchSize: 1 });

    expect(rec.seen).toEqual([reachable]);
    expect(counts).toEqual({ processed: 1, receipted: 1, failed: 0, deadLettered: 0 });
  });
});

describe("drain route", () => {
  it("refuses an unauthenticated call and reports the contract hash for an authorized one", async () => {
    const { GET } = await import("@/app/api/v1/internal/events-drain/route");
    const url = "http://localhost/api/v1/internal/events-drain";

    delete process.env.CRON_SECRET;
    delete process.env.ALLOW_INSECURE_CRON;
    expect((await GET(new Request(url))).status).toBe(401);

    process.env.CRON_SECRET = `u1-secret-${RUN}`;
    expect((await GET(new Request(url, { headers: { authorization: "Bearer wrong" } }))).status).toBe(401);

    const authorized = await GET(
      new Request(url, { headers: { authorization: `Bearer u1-secret-${RUN}` } })
    );
    expect(authorized.status).toBe(200);
    const body = await authorized.json();
    // The route's value here is that it RUNS, drives every REGISTERED consumer, and stamps its
    // hash. Since u2 the registry is the three a1 consumers, and P3.2 appends a4's wakeup router,
    // so the report names all four in dispatch order; their per-kind counts are the drain's
    // business and are asserted above, not here.
    expect(body).toMatchObject({ success: true });
    expect((body.consumers as Array<{ name: string }>).map((consumer) => consumer.name)).toEqual([
      "notifications",
      "activity-trail",
      "memory-ingest",
      "wakeup-router",
    ]);
    expect(body.contract_hash).toMatch(/^[0-9a-f]{64}$/);

    const { rows } = await pgPool().query(
      `SELECT contract_hash FROM worker_heartbeats WHERE worker_id = $1 AND contract_hash = $2`,
      [DRAIN_WORKER_ID, body.contract_hash]
    );
    expect(rows).toHaveLength(1);
  });
});

describe("deployment-version barrier signal", () => {
  /** The rule the P3-era release tooling applies, written once over what the reader returns. */
  function barrierPasses(state: Awaited<ReturnType<typeof readDrainBarrierState>>, target: string): boolean {
    const targetRow = state.hashes.find((row) => row.hash === target);
    const completedRecently =
      targetRow?.completedAt != null && Date.now() - Date.parse(targetRow.completedAt) < 60_000;
    const nothingElseInFlight = state.hashes
      .filter((row) => row.hash !== target)
      .every((row) => row.activeUntil == null || Date.parse(row.activeUntil) <= Date.now());
    return completedRecently && nothingElseInFlight;
  }

  /**
   * The barrier must refuse while an OLD-contract invocation is still inside its drain.
   *
   * This is the case a completion-only signal cannot express. The old invocation has receipted
   * nothing yet, so it has written no completion — its last one is minutes old and looks stale —
   * while the new build's completion is seconds old. Read that way the barrier passes, and the
   * cutover proceeds while the old invocation is still able to receipt an event under the old
   * effect set, permanently suppressing the effect the cutover was enabling.
   */
  it("refuses while an old-contract invocation is still mid-drain", async () => {
    const workerId = `u1d_worker_${RUN}_inflight`;
    const oldHash = "c".repeat(64);
    const newHash = "d".repeat(64);
    const name = consumerName("barrier");
    await activateEventConsumer(name);
    await emitFence("drained-by-the-old-build");

    let releaseOld = () => {};
    let markOldStarted = () => {};
    const oldBlocked = new Promise<void>((resolve) => {
      releaseOld = resolve;
    });
    const oldStarted = new Promise<void>((resolve) => {
      markOldStarted = resolve;
    });

    // The old invocation, in the route's own order: lease first, then drain.
    await beginEventDrainHeartbeat(oldHash, workerId);
    const oldRun = drainEventConsumer({
      name,
      handleEvent: async () => {
        markOldStarted();
        await oldBlocked;
      },
    });
    await oldStarted;

    // A whole new-build invocation, start to finish, while the old one is still inside its handler.
    await beginEventDrainHeartbeat(newHash, workerId);
    await recordEventDrainHeartbeat(newHash, workerId);

    const midFlight = await readDrainBarrierState(workerId);
    expect(midFlight.hashes.find((row) => row.hash === newHash)?.completedAt).not.toBeNull();
    // The old contract has never completed, so a completion-only reading would see nothing at all
    // holding the barrier — and this is the assertion that says the lease does.
    expect(midFlight.hashes.find((row) => row.hash === oldHash)?.completedAt).toBeNull();
    expect(barrierPasses(midFlight, newHash)).toBe(false);

    releaseOld();
    await oldRun;
    await recordEventDrainHeartbeat(oldHash, workerId);

    // Completing does NOT clear the lease: several invocations can share one contract, and one
    // finishing early must not erase a sibling still running. It expires on its own budget.
    expect(barrierPasses(await readDrainBarrierState(workerId), newHash)).toBe(false);

    await pgPool().query(
      `UPDATE worker_heartbeats SET active_until = now() - interval '1 minute'
       WHERE worker_id = $1 AND contract_hash = $2`,
      [workerId, oldHash]
    );
    expect(barrierPasses(await readDrainBarrierState(workerId), newHash)).toBe(true);
  });

  /**
   * The lease window is clamped, because an undersized one breaks the barrier rather than the
   * drain: the lease would lapse while the invocation was still running, the barrier would call the
   * old contract drained, and a cutover would proceed while that invocation could still receipt an
   * event under the old effect set. A number in an environment file must not be able to do that.
   */
  it("clamps an undersized invocation budget up to the floor", async () => {
    const workerId = `u1d_worker_${RUN}_budget`;
    const hash = "e".repeat(64);
    process.env.EVENT_DRAIN_BUDGET_MS = "1000";

    const before = Date.now();
    await beginEventDrainHeartbeat(hash, workerId);

    const state = await readDrainBarrierState(workerId);
    const activeUntil = Date.parse(state.hashes[0].activeUntil!);
    // Well past the configured second, and past the route's own 300 s ceiling.
    expect(activeUntil - before).toBeGreaterThan(300_000);
  });

  /**
   * The barrier's whole job is to prove no runtime can still receipt an event under the OLD effect
   * set. A single heartbeat row per runtime cannot support that claim: it is last-writer-wins, so
   * the first invocation of a rolling deploy overwrites the stamp while an older invocation is
   * still inside its own drain, and the barrier would report the target contract everywhere. One
   * row per (runtime, contract) keeps the old contract's liveness visible — which is what the
   * barrier rule needs, since it passes only when the target row is fresh AND every other hash row
   * for that runtime is stale by more than one invocation's lifetime.
   */
  it("keeps a row per contract hash instead of overwriting the runtime's single stamp", async () => {
    const workerId = `u1d_worker_${RUN}`;
    const oldHash = "a".repeat(64);
    const newHash = "b".repeat(64);

    await recordEventDrainHeartbeat(oldHash, workerId);
    const afterOld = await readDrainBarrierState(workerId);
    expect(afterOld.hashes.map((row) => row.hash)).toEqual([oldHash]);

    // The rolling deploy: a new invocation stamps the target contract while the old one is live.
    await recordEventDrainHeartbeat(newHash, workerId);
    const both = await readDrainBarrierState(workerId);
    expect([...both.hashes.map((row) => row.hash)].sort()).toEqual([oldHash, newHash]);

    // The old invocation heartbeats again; it must refresh ITS OWN row, not the target's.
    await recordEventDrainHeartbeat(oldHash, workerId);
    const refreshed = await readDrainBarrierState(workerId);
    expect(refreshed.hashes).toHaveLength(2);
    const oldSeen = refreshed.hashes.find((row) => row.hash === oldHash)!.seenAt;
    const newSeen = refreshed.hashes.find((row) => row.hash === newHash)!.seenAt;
    expect(Date.parse(oldSeen)).toBeGreaterThanOrEqual(Date.parse(newSeen));

    // The predicate the barrier applies, stated over what the reader returns.
    const stale = (seenAt: string) => Date.now() - Date.parse(seenAt) > 60_000;
    const targetFresh = !stale(newSeen);
    const othersDrained = refreshed.hashes.filter((r) => r.hash !== newHash).every((r) => stale(r.seenAt));
    expect(targetFresh).toBe(true);
    expect(othersDrained).toBe(false); // The old contract is still live, so the barrier must NOT pass.
  });
});
