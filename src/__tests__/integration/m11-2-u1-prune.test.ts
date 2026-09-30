/**
 * M11-2 u1 `[integration]` — retention pruning.
 *
 * The predicate quantifies over **every row in `event_consumers`**: an event goes only when every
 * active consumer has settled it. Testing that needs control over which consumers decide — and the
 * way NOT to get it is to empty the table. An unscoped `DELETE FROM event_consumers` destroys every
 * other suite's cursors, and against a shared database it destroys real ones; it also hides the
 * property under test, because "no consumer objects" is a different claim from "every consumer has
 * settled it". So this suite owns two consumers of its own, deliberately leaves one of them
 * lagging, and neutralizes foreign consumers by receipting ITS OWN event ids for them — additive,
 * scoped to rows this file created, and destructive to nothing.
 *
 * Ages are seeded by backdating `created_at`, never by shortening the retention window: a window of
 * zero would make every row in the database a candidate, and "young rows survive" — the assertion
 * that stops a pruning bug from eating live history — would be untestable.
 */
import { closeIntegrationConnections, pgPool } from "./helpers/db";
import { emitEvent } from "@/lib/store/events/db";
import { pruneEventLedgers } from "@/lib/store/events/drain-db";
import type { PreparedEvent } from "@/lib/events/kinds";

const RUN = `${Date.now().toString(36)}_${Math.floor(Math.random() * 1e6).toString(36)}`;
const SCOPE = `u1p_${RUN}`;
/** Settles everything this suite asks it to. */
const SETTLING = `${SCOPE}_settling`;
/** Deliberately left behind, so "every consumer" has something to fail on. */
const LAGGING = `${SCOPE}_lagging`;

let baselineEventId = 0;

const fence = (consumer: string): PreparedEvent<"system.activation_fence"> => ({
  kind: "system.activation_fence",
  payload: { consumer },
});

async function seedEvent(label: string, ageDays?: number): Promise<number> {
  const { id } = await emitEvent(fence(label));
  if (ageDays !== undefined) {
    await pgPool().query(`UPDATE events SET created_at = now() - make_interval(days => $2) WHERE id = $1`, [
      id,
      ageDays,
    ]);
  }
  return id;
}

/**
 * Foreign consumers must not decide this suite's outcome — and this suite must not delete them.
 * Receipting this file's own event ids for them says "they are done with these", which is true:
 * they were activated before these events existed and will never be offered them.
 */
async function settleForForeignConsumers(eventIds: number[]): Promise<void> {
  await pgPool().query(
    `INSERT INTO event_receipts (consumer, event_id)
     SELECT c.consumer, e.id
     FROM event_consumers c
     CROSS JOIN unnest($1::bigint[]) AS e(id)
     WHERE c.consumer NOT LIKE $2
     ON CONFLICT DO NOTHING`,
    [eventIds, `${SCOPE}%`]
  );
}

async function eventExists(id: number): Promise<boolean> {
  const { rows } = await pgPool().query(`SELECT 1 FROM events WHERE id = $1`, [id]);
  return rows.length > 0;
}

async function receiptExists(consumer: string, id: number): Promise<boolean> {
  const { rows } = await pgPool().query(
    `SELECT 1 FROM event_receipts WHERE consumer = $1 AND event_id = $2`,
    [consumer, id]
  );
  return rows.length > 0;
}

beforeAll(async () => {
  const { rows } = await pgPool().query(`SELECT COALESCE(max(id), 0) AS id FROM events`);
  baselineEventId = Number(rows[0].id);
});

afterAll(async () => {
  // Scoped by this run's consumer names and by the id range this run created — never by table.
  await pgPool().query(`DELETE FROM event_dead_letters WHERE consumer LIKE $1`, [`${SCOPE}%`]);
  await pgPool().query(`DELETE FROM event_consumer_failures WHERE consumer LIKE $1`, [`${SCOPE}%`]);
  await pgPool().query(`DELETE FROM event_consumer_shadow WHERE consumer LIKE $1`, [`${SCOPE}%`]);
  await pgPool().query(`DELETE FROM ingest_progress WHERE event_id > $1`, [baselineEventId]);
  await pgPool().query(`DELETE FROM event_receipts WHERE event_id > $1`, [baselineEventId]);
  await pgPool().query(`DELETE FROM event_consumers WHERE consumer LIKE $1`, [`${SCOPE}%`]);
  await pgPool().query(`DELETE FROM events WHERE id > $1`, [baselineEventId]);
  await closeIntegrationConnections();
});

it("prunes only what EVERY consumer has settled, and only once it is old", async () => {
  // Created first so it can sit at or below the cutoff — the implicit-receipt case.
  const belowCutoff = await seedEvent("below-cutoff", 200);
  const settledByBoth = await seedEvent("old-settled-by-both", 200);
  const settledByOneOnly = await seedEvent("old-settled-by-one", 200);
  const deadLetteredByBoth = await seedEvent("old-dead-lettered", 200);
  const young = await seedEvent("young");

  for (const consumer of [SETTLING, LAGGING]) {
    await pgPool().query(
      `INSERT INTO event_consumers (consumer, last_event_id, activation_cutoff) VALUES ($1, $2, $2)`,
      [consumer, belowCutoff]
    );
  }
  await settleForForeignConsumers([belowCutoff, settledByBoth, settledByOneOnly, deadLetteredByBoth, young]);

  for (const consumer of [SETTLING, LAGGING]) {
    await pgPool().query(`INSERT INTO event_receipts (consumer, event_id) VALUES ($1, $2)`, [
      consumer,
      settledByBoth,
    ]);
    await pgPool().query(
      `INSERT INTO event_dead_letters (consumer, event_id, error) VALUES ($1, $2, 'terminal')`,
      [consumer, deadLetteredByBoth]
    );
  }
  // One consumer only. This is the every-consumer proof: the lagging one still owes this event.
  await pgPool().query(`INSERT INTO event_receipts (consumer, event_id) VALUES ($1, $2)`, [
    SETTLING,
    settledByOneOnly,
  ]);
  // A shadow row rides its event: soak comparison rows are worthless once the event is gone.
  await pgPool().query(
    `INSERT INTO event_consumer_shadow (consumer, event_id, effect_key, payload)
     VALUES ($1, $2, 'notification:1', '{}'::jsonb)`,
    [SETTLING, settledByBoth]
  );
  // M11-2 P2.1's ingest recipient-progress ledger rides its event for the same reason: it exists
  // only so an interrupted fan-out can RESUME, and once the event is gone nothing can resume it.
  // One busy post can leave up to 2,000 of these rows, so an unpruned ledger grows without bound.
  await pgPool().query(
    `INSERT INTO ingest_progress (event_id, recipient_agent_id)
     VALUES ($1, 'prune-recipient-a'), ($1, 'prune-recipient-b'), ($2, 'prune-recipient-a')`,
    [settledByBoth, settledByOneOnly]
  );

  const counts = await pruneEventLedgers();

  // Settled by BOTH consumers — by receipt, by dead letter, or by sitting at the activation cutoff.
  // Without that last one, every newly activated consumer would make all pre-activation history
  // permanently unprunable.
  expect(await eventExists(settledByBoth)).toBe(false);
  expect(await eventExists(deadLetteredByBoth)).toBe(false);
  expect(await eventExists(belowCutoff)).toBe(false);
  // Settled by one consumer and not the other: the log is pruned per event, by EVERY consumer.
  expect(await eventExists(settledByOneOnly)).toBe(true);
  // Young, so it stays even though everything has settled it.
  expect(await eventExists(young)).toBe(true);

  expect(await receiptExists(SETTLING, settledByBoth)).toBe(false);
  const { rows: shadow } = await pgPool().query(
    `SELECT 1 FROM event_consumer_shadow WHERE consumer = $1 AND event_id = $2`,
    [SETTLING, settledByBoth]
  );
  expect(shadow).toHaveLength(0);

  // Progress rows go with their pruned event; the surviving event's row stays, because that event
  // is still unsettled and a retry could still need to resume from it.
  const { rows: progress } = await pgPool().query(
    `SELECT event_id FROM ingest_progress WHERE event_id = ANY($1::bigint[]) ORDER BY event_id`,
    [[settledByBoth, settledByOneOnly]]
  );
  expect(progress.map((row: { event_id: string }) => Number(row.event_id))).toEqual([settledByOneOnly]);
  expect(counts.ingestProgress).toBeGreaterThanOrEqual(2);
  expect(counts.events).toBeGreaterThanOrEqual(3);

  // The lagging consumer's own cursor is untouched, and so is every foreign one.
  const { rows: cursors } = await pgPool().query(
    `SELECT count(*)::int AS c FROM event_consumers WHERE consumer LIKE $1`,
    [`${SCOPE}%`]
  );
  expect(cursors[0].c).toBe(2);

  // Idempotent: a second pass finds nothing left to do.
  expect((await pruneEventLedgers()).events).toBe(0);
});

/**
 * The janitor for the one race the drain deliberately does not serialize.
 *
 * A simultaneous first success and first transient failure both commit — each statement's snapshot
 * predates the other — leaving an `attempts = 1` row behind a receipt. Closing that would need a
 * shared lock on the event row, which would make unrelated consumers' receipts contend on every
 * event: a platform-wide serialization point bought to tidy a row nothing can read. So the row is
 * collected hourly instead, and the assertion that matters beside it is the second one — a row a
 * drainer is holding right now must survive, because its owner's outcome writes are fenced against it.
 */
it("collects a failure row whose event is already receipted, and spares a leased one", async () => {
  const settled = await seedEvent("receipted-with-orphan");
  const claimed = await seedEvent("receipted-but-leased");
  await settleForForeignConsumers([settled, claimed]);

  for (const id of [settled, claimed]) {
    await pgPool().query(`INSERT INTO event_receipts (consumer, event_id) VALUES ($1, $2)`, [SETTLING, id]);
  }
  await pgPool().query(
    `INSERT INTO event_consumer_failures (consumer, event_id, attempts, next_attempt_at)
     VALUES ($1, $2, 1, now() + interval '1 minute')`,
    [SETTLING, settled]
  );
  await pgPool().query(
    `INSERT INTO event_consumer_failures
       (consumer, event_id, attempts, next_attempt_at, claim_token, lease_expires_at)
     VALUES ($1, $2, 1, now() + interval '1 minute', 'held', now() + interval '10 minutes')`,
    [SETTLING, claimed]
  );

  const counts = await pruneEventLedgers();

  // Unreachable and unleased: collected within the hour rather than after the retention window.
  expect(counts.orphanedFailures).toBeGreaterThanOrEqual(1);
  const { rows } = await pgPool().query(
    `SELECT event_id FROM event_consumer_failures WHERE consumer = $1 ORDER BY event_id`,
    [SETTLING]
  );
  expect(rows.map((row) => Number(row.event_id))).toEqual([claimed]);
});

it("prunes stale failure rows and dead letters on the ledger window", async () => {
  const live = await seedEvent("ledger-owner");
  await settleForForeignConsumers([live]);
  await pgPool().query(
    `INSERT INTO event_consumer_failures (consumer, event_id, attempts, next_attempt_at)
     VALUES ($1, $2, 1, now() - interval '40 days')`,
    [SETTLING, live]
  );
  await pgPool().query(
    `INSERT INTO event_dead_letters (consumer, event_id, error, created_at)
     VALUES ($1, $2, 'ancient', now() - interval '40 days')`,
    [SETTLING, live]
  );

  const counts = await pruneEventLedgers();

  expect(counts.failures).toBeGreaterThanOrEqual(1);
  expect(counts.deadLetters).toBeGreaterThanOrEqual(1);
  // The event itself is young and survives its ledger rows.
  expect(await eventExists(live)).toBe(true);
  // Scoped to this event: the previous case's dead letters are young and outlive the events they
  // describe on purpose — the audit row's retention is its own window, not the log's.
  const { rows } = await pgPool().query(
    `SELECT
       (SELECT count(*)::int FROM event_consumer_failures WHERE consumer = $1 AND event_id = $2) AS failures,
       (SELECT count(*)::int FROM event_dead_letters WHERE consumer = $1 AND event_id = $2) AS dead_letters`,
    [SETTLING, live]
  );
  expect(rows[0]).toEqual({ failures: 0, dead_letters: 0 });
});
