import { randomUUID } from "crypto";

import { sql } from "@/lib/db";
import { PermanentEffectError, RetryLaterError } from "@/lib/events/errors";
import { EVENT_KINDS } from "@/lib/events/kinds";
import { toIsoOrEmpty, toIsoOrNull } from "@/lib/iso-date";
import type { StoredEvent } from "@/lib/store-types";

import { rowToEvent } from "./db";
import { preparedEventValues } from "./statement";

/**
 * M11-2 P2.2 — cursor discipline, retry ledger, dead letters. Database mode only.
 *
 * **Receipts are the correctness mechanism; the cursor is only a scan floor.** Sequence ids
 * allocate before commit, so no scalar cursor can be made safe: an older transaction can allocate a
 * HIGHER event id and commit first, and a cursor advanced past it would skip the lower id forever.
 * With a receipt per (consumer, event) nothing is ever "passed" — a late-committing event is still
 * receipt-less and the next scan takes it. For the same reason **no `txid`/`xmin` horizon predicate
 * is applied at all**: beyond being insufficient, `txid_snapshot_xmin` stays pinned while any older
 * transaction runs, so one long migration would hide every newer committed event from every drain.
 *
 * **Every write to a claimed event's ledger rows is fenced on ownership, in the same statement.**
 * A lease expires on wall-clock time, so a slow attempt can lose its claim while it is still
 * running: another drainer reclaims the event, applies the effect and receipts it, and the original
 * attempt then returns and tries to record its own outcome. Fencing only the DELETE is not enough —
 * an unfenced receipt or dead-letter insert from that stale attempt would terminally finalize an
 * event the current owner just handled. So each of those statements gates its inserts on an
 * ownership CTE and reports whether it matched, and the counters move only when it did.
 *
 * The fast path gives seconds-level latency for the normal case; `sweepEventConsumer` runs the same
 * processing with no floor and guarantees eventual processing for the pathological one.
 *
 * Memory mode has no drain at all (Decision 6) — see `drain-memory.ts`.
 */

/**
 * A consumer, as the machinery sees it. The registry that holds them arrives in u2; everything
 * here is kind-agnostic on purpose, so a new consumer is a registry entry and a manifest, never a
 * change to this file.
 */
export interface EventConsumerDescriptor {
  name: string;
  handleEvent(event: StoredEvent): Promise<void>;
}

export interface DrainCounts {
  /**
   * Events this pass examined. Rows the candidate query excludes — kinds this build does not know,
   * and failures still inside their backoff — are never examined and are not counted here.
   */
  processed: number;
  /** Receipts this pass recorded. A racing drainer may have recorded the receipt instead. */
  receipted: number;
  /** Failed attempts this pass recorded, including the attempt that dead-lettered. */
  failed: number;
  /** Events this pass finalized into `event_dead_letters`. */
  deadLettered: number;
}

export interface DeadlineOptions {
  /**
   * Epoch milliseconds after which this pass stops taking on NEW work. It never interrupts an
   * effect already running — a consumer's handler owns its own timeout — it just stops claiming.
   */
  deadline?: number;
}

export interface DrainOptions extends DeadlineOptions {
  batchSize?: number;
}

export interface PruneCounts {
  events: number;
  receipts: number;
  shadowRows: number;
  failures: number;
  deadLetters: number;
  /**
   * Ingest fan-out bookkeeping collected behind a pruned event (M11-2 P2.1): the recipient-progress
   * rows and the event's fan-out claim, counted together because they are one ledger.
   *
   * It exists only to let an interrupted fan-out resume; once the event is gone nothing can resume
   * it, and one busy post can leave up to 2,000 progress rows per event behind forever.
   */
  ingestProgress: number;
  /** Failure rows whose event was already receipted — the janitor's count. See `prunePass`. */
  orphanedFailures: number;
}

function overDeadline(deadline: number | undefined): boolean {
  return deadline !== undefined && Date.now() >= deadline;
}

/**
 * How many failed attempts an event gets before it is finalized.
 *
 * At least 2 by construction: the first failure only REGISTERS the ledger row, and every attempt
 * after it goes through a claim. A value of 1 would need the registration itself to finalize.
 */
const MAX_ATTEMPTS = 3;

const DEFAULT_BATCH_SIZE = 200;

/**
 * The sweep's own bound. It runs hourly over the entire retained window, so it cannot be
 * unbounded; anything it does not reach this hour it reaches the next one.
 */
const SWEEP_BATCH_SIZE = 500;

/**
 * The waits between attempts — **one fewer than `MAX_ATTEMPTS`, and that is the whole list.**
 *
 * A wait is only ever stamped by an attempt that will be retried. The third failure finalizes on
 * the spot, so a third entry would never be read by anything. The plan's own text says "1m/10m/60m"
 * and over-specifies by one entry for that reason — recorded here as plan drift rather than
 * implemented, because carrying a dead entry invites the belief that four attempts happen.
 *
 * Entries beyond `MAX_ATTEMPTS - 1` in a configured schedule are likewise unused; a shorter one
 * clamps to its last entry.
 */
const DEFAULT_BACKOFF_MS = [60_000, 600_000];

/**
 * How long a claimed attempt is leased.
 *
 * Ten minutes, matching the plan's wakeup lease — **not** a minute. The lease has to outlast the
 * work it covers, and the drain route alone budgets 300 s per invocation while a consumer's effect
 * (memory ingest fans out to thousands of recipients through an external vector service) can take
 * far longer than a single event's share of that. A lease shorter than the work guarantees a second
 * drainer starts the same effect while the first is still running.
 *
 * An effect that outlives its lease anyway is still safe, and that is by design rather than by
 * luck: every outcome write is token-fenced, so the timed-out attempt records nothing, and every
 * consumer effect is idempotent under its natural key, so the reclaiming drainer redoing it is a
 * no-op. u1 ships no lease renewal — renewal would be a second clock to get wrong.
 */
const DEFAULT_CLAIM_LEASE_MS = 600_000;

/**
 * The shortest lease this code will honour. Below it, a normal consumer effect routinely outlives
 * its own claim, so every event is attempted by two drainers and the retry ledger measures
 * contention instead of failure. Tests override the lease deliberately and stay above this.
 */
const MIN_CLAIM_LEASE_MS = 30_000;

const DEFAULT_FLOOR_GRACE_MS = 60_000;
const DEFAULT_RETENTION_DAYS = 90;
const DEFAULT_LEDGER_RETENTION_DAYS = 30;

/** Rows one bounded prune statement may delete, and how many times a duty may repeat them. */
const DEFAULT_PRUNE_BATCH_SIZE = 1_000;
const DEFAULT_PRUNE_MAX_PASSES = 5;

/**
 * The longest a single drain invocation can still be running, and therefore how long its in-flight
 * lease covers it: the route's 300 s `maxDuration` plus margin for the platform's start-up and
 * teardown around it. It is deliberately the same value as the floor below — a default that sat
 * under its own clamp would warn on every checked-in configuration.
 */
const DEFAULT_DRAIN_BUDGET_MS = 400_000;

/**
 * The floor under that budget: the route's hard 300 s ceiling plus margin for the platform's own
 * start-up and teardown around it.
 *
 * An undersized budget is the one misconfiguration that silently breaks the barrier rather than the
 * drain. The lease would expire while the invocation was still running, the barrier would read the
 * old contract as drained, and a cutover would proceed while that invocation could still receipt an
 * event under the old effect set — the exact failure the lease exists to prevent, reintroduced by a
 * number in an environment file.
 */
const MIN_DRAIN_BUDGET_MS = 400_000;

/** Env is read per call, never at module load: the drain route is long-lived and tests override. */
function envNumber(name: string, fallback: number): number {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

/**
 * The retry schedule in SECONDS, indexed in SQL by the resulting attempt number.
 *
 * Three attempts must span real recovery time: without the backoff a worker and a cron would burn
 * every attempt within minutes of a short provider outage and permanently discard effects that
 * would have succeeded on recovery. A schedule shorter than `MAX_ATTEMPTS` clamps to its last entry.
 */
function backoffSecondsSchedule(): number[] {
  const raw = process.env.EVENT_RETRY_BACKOFF_MS?.trim();
  if (!raw) return DEFAULT_BACKOFF_MS.map((ms) => ms / 1000);

  const entries = raw.split(",").map((part) => Number(part.trim()));
  // The WHOLE schedule is validated, and a bad one falls back entirely rather than being filtered.
  // Dropping the invalid entries silently would shorten the schedule — turning a typo into a
  // shorter escalation nobody asked for — and a zero entry is worse than invalid: it means "retry
  // immediately", so overlapping passes would spend all three attempts within seconds of a blip
  // and discard effects that a real wait would have recovered.
  if (entries.length === 0 || !entries.every((ms) => Number.isFinite(ms) && ms > 0)) {
    if (!warnedAboutBackoff) {
      warnedAboutBackoff = true;
      console.warn(
        `[events-drain] EVENT_RETRY_BACKOFF_MS='${raw}' is not a list of positive milliseconds; using the default schedule.`
      );
    }
    return DEFAULT_BACKOFF_MS.map((ms) => ms / 1000);
  }
  return entries.map((ms) => ms / 1000);
}

let warnedAboutShortLease = false;
let warnedAboutShortBudget = false;
let warnedAboutBackoff = false;

/**
 * The margin the lease carries over the invocation's real ceiling. Subtracting it recovers the
 * ceiling itself, which is what the phases inside an invocation actually have to share.
 */
const DRAIN_BUDGET_MARGIN_MS = 100_000;

/** The phases one invocation runs in sequence: the hourly duties, then the fast-path drains. */
const DRAIN_PHASES = 2;

/**
 * How long ONE phase of an invocation may keep taking on new work.
 *
 * Derived from the lease rather than configured separately, so the two cannot drift into
 * contradiction: the lease says how long an invocation might run, and the phases inside it divide
 * the ceiling that lease covers. Bounding by row count alone is not enough — a hundred events of
 * external work is a bounded count and an unbounded duration, and the phase that runs second would
 * simply never start.
 */
export function eventDrainPhaseBudgetMs(): number {
  const ceilingMs = Math.max(1_000, drainBudgetSeconds() * 1000 - DRAIN_BUDGET_MARGIN_MS);
  return Math.floor(ceilingMs / DRAIN_PHASES);
}

/** The in-flight lease window, clamped up to `MIN_DRAIN_BUDGET_MS`. See that constant for why. */
function drainBudgetSeconds(): number {
  const configured = envNumber("EVENT_DRAIN_BUDGET_MS", DEFAULT_DRAIN_BUDGET_MS);
  if (configured < MIN_DRAIN_BUDGET_MS) {
    if (!warnedAboutShortBudget) {
      warnedAboutShortBudget = true;
      console.warn(
        `[events-drain] EVENT_DRAIN_BUDGET_MS=${configured} is below the ${MIN_DRAIN_BUDGET_MS} ms floor; using the floor.`
      );
    }
    return MIN_DRAIN_BUDGET_MS / 1000;
  }
  return configured / 1000;
}

/**
 * The claim lease, clamped up to `MIN_CLAIM_LEASE_MS`.
 *
 * A misconfiguration here does not fail loudly on its own — it turns into duplicated effect work
 * and a retry ledger full of contention — so the floor is enforced rather than trusted, and the
 * clamp says so once per process instead of on every event.
 */
function claimLeaseSeconds(): number {
  const configured = envNumber("EVENT_CLAIM_LEASE_MS", DEFAULT_CLAIM_LEASE_MS);
  if (configured < MIN_CLAIM_LEASE_MS) {
    if (!warnedAboutShortLease) {
      warnedAboutShortLease = true;
      console.warn(
        `[events-drain] EVENT_CLAIM_LEASE_MS=${configured} is below the ${MIN_CLAIM_LEASE_MS} ms floor; using the floor.`
      );
    }
    return MIN_CLAIM_LEASE_MS / 1000;
  }
  return configured / 1000;
}

function floorGraceSeconds(): number {
  return envNumber("EVENT_FLOOR_GRACE_MS", DEFAULT_FLOOR_GRACE_MS) / 1000;
}

function zeroCounts(): DrainCounts {
  return { processed: 0, receipted: 0, failed: 0, deadLettered: 0 };
}

function errorText(error: unknown): string {
  const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  // Bounded: `last_error` is diagnostic, and an unbounded stack from a consumer would bloat the row.
  return message.slice(0, 1000);
}

// ==================== Activation ====================

/** The fence's deterministic idempotency key. One fence per consumer, enforced by the index. */
function activationFenceIdemKey(consumer: string): string {
  return `activation_fence:${consumer}`;
}

/**
 * Activate a consumer "from now", fenced.
 *
 * Activation inserts a dedicated `system.activation_fence` event and uses its returned id as BOTH
 * `activation_cutoff` and the initial `last_event_id`. **Sequence allocation is atomic, so every id
 * allocated before the fence is unambiguously pre-activation regardless of commit timing** — a
 * committed-`max(id)` cutoff would misclassify a pre-activation transaction whose id was invisible
 * at seed time and commits later, handing the router a stale wakeup.
 *
 * **Exactly one fence per consumer, and the fence's winner is the one that seeds the cursor.** The
 * key is deterministic and the partial unique index on `idem_key` decides it, so two concurrent
 * first activations cannot leave a second fence event behind — which would matter, because the
 * loser's fence carries a HIGHER id than the cutoff the winner seeded and would be dispatched to
 * the consumer as an ordinary post-activation event. The `NOT EXISTS` gate stays as well: once the
 * fence event is old enough to be pruned its idem key goes with it, and only that gate then stops a
 * re-activation from writing a fresh fence for an already-active consumer.
 */
export async function activateEventConsumer(
  name: string
): Promise<{ activated: boolean; activationCutoff: number | null }> {
  const fence = preparedEventValues({
    kind: "system.activation_fence",
    idemKey: activationFenceIdemKey(name),
    payload: { consumer: name },
  });
  const rows = await sql!(
    `WITH fence AS (
       INSERT INTO events (kind, actor_agent_id, subject_type, subject_id, secondary_subject_id,
                           school_id, idem_key, payload)
       SELECT $2, $3, $4, $5, $6, $7, $8, $9::jsonb
       WHERE NOT EXISTS (SELECT 1 FROM event_consumers WHERE consumer = $1)
       -- The index is partial, so its predicate is repeated here: a bare column target cannot
       -- infer a partial index.
       ON CONFLICT (idem_key) WHERE idem_key IS NOT NULL DO NOTHING
       RETURNING id
     )
     INSERT INTO event_consumers (consumer, last_event_id, activation_cutoff)
     SELECT $1, id, id FROM fence
     ON CONFLICT (consumer) DO NOTHING
     RETURNING activation_cutoff`,
    [name, ...fence]
  );
  if (rows.length === 0) return { activated: false, activationCutoff: null };
  return { activated: true, activationCutoff: Number((rows[0] as { activation_cutoff: string }).activation_cutoff) };
}

// ==================== Scan ====================

interface ScannedEvent {
  event: StoredEvent;
  /** A failures row exists for this (consumer, event), so the attempt must be claimed first. */
  hasFailure: boolean;
}

/**
 * The candidate query: the receipt anti-join, plus every reason to skip an event.
 *
 * **The skips are SQL-side, and that is a head-of-line rule rather than an optimization.** `LIMIT`
 * applies before anything a caller could filter in JavaScript, so a page full of paced failures — or
 * of kinds a newer build introduced — would fill the batch with rows this pass cannot act on and
 * starve every later event for that consumer until they cleared. Excluded rows stay unreceipted, so
 * the floor still stops below them and the sweep still sees them.
 *
 * `floor` is the fast path's low-water mark; the sweep passes the cutoff so the whole retained
 * window is scanned. Times are compared on the SERVER's clock — a client-side comparison would let
 * clock skew either double-attempt a leased event or stall a ready one.
 */
async function scanEvents(
  consumer: string,
  floor: number,
  cutoff: number,
  limit: number
): Promise<ScannedEvent[]> {
  const rows = await sql!(
    `SELECT e.id, e.kind, e.actor_agent_id, e.subject_type, e.subject_id, e.secondary_subject_id,
            e.school_id, e.idem_key, e.payload, e.created_at,
            (f.consumer IS NOT NULL) AS has_failure
     FROM events e
     LEFT JOIN event_consumer_failures f ON f.consumer = $1 AND f.event_id = e.id
     WHERE e.id > $2 AND e.id > $3
       -- Unknown to this build: skipped WITHOUT a receipt, deliberately. The event belongs to a
       -- newer build, which will find it unreceipted. Receipting it here would permanently swallow
       -- the first events of every brand-new kind during a rollout, since such kinds have no
       -- inline writer to fall back on.
       AND e.kind = ANY($4::text[])
       AND NOT EXISTS (SELECT 1 FROM event_receipts r WHERE r.consumer = $1 AND r.event_id = e.id)
       -- A live lease or an unelapsed backoff: not this pass's to touch.
       AND (f.consumer IS NULL OR (
              (f.lease_expires_at IS NULL OR f.lease_expires_at <= now())
              AND (f.next_attempt_at IS NULL OR f.next_attempt_at <= now())
           ))
     ORDER BY e.id
     LIMIT $5`,
    [consumer, floor, cutoff, [...EVENT_KINDS], limit]
  );
  return (rows as unknown[]).map((row) => ({
    event: rowToEvent(row),
    hasFailure: (row as { has_failure: boolean }).has_failure,
  }));
}

// ==================== Ledger writes ====================

/**
 * A lease-safe cleanup of the failures row, for the statements that settle an event outright.
 *
 * A drainer that succeeds while another is concurrently recording that event's FIRST transient
 * failure leaves the ledger row behind: the event is receipted, so no scan ever offers it again,
 * and the row sits there until retention. Every receipt-writing statement therefore clears it.
 *
 * **Only rows with no live lease.** A retry claimant may be mid-effect on this very event, and its
 * outcome writes are fenced against exactly this row — deleting it would make that owner record
 * nothing at all. So the cleanup takes the settled leftovers and leaves a live claim alone.
 */
const CLEAR_UNLEASED_FAILURE = `
       DELETE FROM event_consumer_failures
       WHERE consumer = $1 AND event_id = $2
         AND (lease_expires_at IS NULL OR lease_expires_at <= now())
       RETURNING event_id`;

/**
 * First success for an event that has never failed. Two racing drainers serialize on the PK.
 *
 * @returns whether THIS call inserted the receipt. The counters report work this pass recorded, so
 *   the drainer that lost the race reports nothing rather than double-counting the same receipt.
 */
async function insertReceipt(consumer: string, eventId: number): Promise<boolean> {
  const rows = await sql!(
    `WITH receipt AS (
       INSERT INTO event_receipts (consumer, event_id) VALUES ($1, $2)
       ON CONFLICT DO NOTHING
       RETURNING event_id
     ), cleared AS (${CLEAR_UNLEASED_FAILURE}
     )
     SELECT count(*)::int AS receipted FROM receipt`,
    [consumer, eventId]
  );
  return Number((rows[0] as { receipted: number }).receipted) > 0;
}

/**
 * Success after a recorded failure: the receipt and the ledger removal in one statement, BOTH gated
 * on the caller still holding the claim.
 *
 * The ownership check is a `FOR UPDATE` **lock**, never a bare `EXISTS` — the repo's standing rule
 * for a liveness check inside a write. An `EXISTS` subquery is evaluated against the statement
 * snapshot and is never re-checked, so a reclaim committing in that window would leave this stale
 * attempt writing a receipt over the new owner's work. Locking the row makes Postgres re-evaluate
 * the token against the row's current version.
 *
 * The cleanup DELETE reads `FROM owner` rather than repeating the predicate. Postgres does not
 * define the execution order of sibling data-modifying CTEs, and two independent CTEs touching the
 * same row is the documented unsupported case; making the DELETE depend on `owner` gives the
 * statement one order it is allowed to have.
 *
 * @returns whether THIS call inserted the receipt. `false` covers both "the lease was reclaimed
 *   while the effect ran" and "another drainer had already receipted it" — in neither case did this
 *   pass record anything, so it counts nothing.
 */
async function receiptAndClearFailure(
  consumer: string,
  eventId: number,
  token: string
): Promise<boolean> {
  const rows = await sql!(
    `WITH owner AS (
       SELECT consumer, event_id FROM event_consumer_failures
       WHERE consumer = $1 AND event_id = $2 AND claim_token = $3
       FOR UPDATE
     ), receipt AS (
       INSERT INTO event_receipts (consumer, event_id)
       SELECT $1, $2 FROM owner
       ON CONFLICT DO NOTHING
       RETURNING event_id
     ), cleared AS (
       DELETE FROM event_consumer_failures f
       USING owner o
       WHERE f.consumer = o.consumer AND f.event_id = o.event_id
       RETURNING f.event_id
     )
     SELECT count(*)::int AS receipted FROM receipt`,
    [consumer, eventId, token]
  );
  return Number((rows[0] as { receipted: number }).receipted) > 0;
}

/**
 * Claim a previously failed event for one more attempt.
 *
 * Only the claim owner may apply the effect, count an attempt, receipt, or dead-letter it. Zero
 * rows back means another drainer owns the attempt or the backoff has not elapsed — the caller does
 * nothing at all, which is what stops a worker and a cron from double-counting attempts.
 */
async function claimFailedEvent(
  consumer: string,
  eventId: number
): Promise<{ token: string; attempts: number } | null> {
  const token = randomUUID();
  const rows = await sql!(
    // The marker is for the race harness: `pg_stat_activity` reports a blocked backend's current
    // query text, and asserting on it is how a test proves the statement it saw waiting is this
    // one rather than any other backend the holder happened to block.
    `/* events:claim */
     UPDATE event_consumer_failures
     SET claim_token = $3, lease_expires_at = now() + make_interval(secs => $4::double precision)
     WHERE consumer = $1 AND event_id = $2
       AND (lease_expires_at IS NULL OR lease_expires_at <= now())
       AND (next_attempt_at IS NULL OR next_attempt_at <= now())
     RETURNING attempts`,
    [consumer, eventId, token, claimLeaseSeconds()]
  );
  if (rows.length === 0) return null;
  return { token, attempts: Number((rows[0] as { attempts: number | string }).attempts) };
}

/**
 * The `next_attempt_at` expression: the schedule indexed by the RESULTING attempt number, clamped
 * into the array so a schedule shorter than `MAX_ATTEMPTS` repeats its last wait instead of
 * producing NULL (which would read as "retry immediately").
 */
function backoffExpression(scheduleParam: string, attemptsExpression: string): string {
  return (
    `now() + make_interval(secs => (${scheduleParam}::double precision[])[` +
    `GREATEST(1, LEAST(${attemptsExpression}, array_length(${scheduleParam}::double precision[], 1)))])`
  );
}

/**
 * Register the FIRST failure for an event: `ON CONFLICT DO NOTHING`, never an increment.
 *
 * A conflict means a failures row already exists, and from that moment every attempt must go
 * through `claimFailedEvent`, which enforces the lease AND the backoff. An incrementing conflict
 * arm cannot: it sees only the lease, so a slow concurrent first attempt landing minutes later
 * would spend a second attempt in the middle of a backoff window it never checked, and three
 * attempts would stop spanning three backoff intervals — the property the schedule exists for.
 *
 * The receipt check is the other half of the orphan fix: a concurrent drainer may have SETTLED this
 * event while this attempt was running, and a ledger row written after that is unreachable — no
 * scan offers a receipted event again — so it would sit there until retention. Between this and the
 * cleanup every receipt-writing statement performs, both orderings of the race are covered.
 *
 * **One overlap is accepted and not closed here: a simultaneous first success and first transient
 * failure.** Each statement's snapshot predates the other's commit, so the receipt check passes and
 * the receipt's own cleanup finds no row — both commit, and an orphan `attempts = 1` row is left
 * behind the receipt. Serializing them would need a shared lock on the EVENT row, which would make
 * unrelated consumers' receipts contend with each other on every event: a platform-wide
 * serialization point bought to tidy a row nothing can read. The orphan is invisible to every scan,
 * cannot be claimed, and changes no outcome; the hourly janitor in `prunePass` collects it, so it
 * lives at most an hour rather than a retention window.
 *
 * @returns null when another drainer registered the failure, or settled the event — either way this
 *   attempt is not counted.
 */
async function registerFirstFailure(
  consumer: string,
  eventId: number,
  error: unknown
): Promise<{ attempts: number } | null> {
  const rows = await sql!(
    `INSERT INTO event_consumer_failures
       (consumer, event_id, attempts, last_error, next_attempt_at, claim_token, lease_expires_at)
     SELECT $1, $2, 1, $3, ${backoffExpression("$4", "1")}, NULL::text, NULL::timestamptz
     WHERE NOT EXISTS (
       SELECT 1 FROM event_receipts WHERE consumer = $1 AND event_id = $2
     )
     ON CONFLICT (consumer, event_id) DO NOTHING
     RETURNING attempts`,
    [consumer, eventId, errorText(error), backoffSecondsSchedule()]
  );
  if (rows.length === 0) return null;
  return { attempts: Number((rows[0] as { attempts: number | string }).attempts) };
}

/**
 * Record a claimed retry's failure, fenced on the claim. The lease is released here — pacing is
 * `next_attempt_at`'s job from this point, and holding the lease past the attempt would only delay
 * the next one.
 *
 * @returns whether the caller still owned the attempt.
 */
async function recordRetryFailure(
  consumer: string,
  eventId: number,
  token: string,
  attempts: number,
  error: unknown
): Promise<boolean> {
  const rows = await sql!(
    `UPDATE event_consumer_failures
     SET attempts = $4,
         last_error = $5,
         next_attempt_at = ${backoffExpression("$6", "$4")},
         claim_token = NULL,
         lease_expires_at = NULL
     WHERE consumer = $1 AND event_id = $2 AND claim_token = $3
     RETURNING event_id`,
    [consumer, eventId, token, attempts, errorText(error), backoffSecondsSchedule()]
  );
  return rows.length > 0;
}

/**
 * Hand back a retry claim without counting an attempt — the `RetryLaterError` path only.
 *
 * Token-fenced like every other outcome write: a drainer whose lease already lapsed must not clear
 * the lease of whoever reclaimed the event. `attempts` and `next_attempt_at` are untouched, because
 * nothing was attempted.
 */
async function releaseFailureLease(consumer: string, eventId: number, token: string): Promise<void> {
  await sql!(
    `UPDATE event_consumer_failures SET claim_token = NULL, lease_expires_at = NULL
     WHERE consumer = $1 AND event_id = $2 AND claim_token = $3`,
    [consumer, eventId, token]
  );
}

function logDeadLetter(consumer: string, eventId: number, description: string): void {
  console.error(`[events-drain] dead letter: consumer=${consumer} event=${eventId} error=${description}`);
}

/**
 * Terminal finalization for a CLAIMED attempt: the dead letter, the skipped receipt, and the ledger
 * removal in ONE data-modifying CTE, all three gated on the caller still holding the claim.
 *
 * Never two calls. This driver auto-commits each statement, so a two-call form has a crash window
 * in which the event is either eternally rescanned by the anti-join (dead letter without receipt)
 * or has lost its audit row (receipt without dead letter). Both conflict targets no-op on a replay,
 * so a repeated finalization changes nothing.
 *
 * Ownership is a `FOR UPDATE` lock on the failures row, never an `EXISTS`: an `EXISTS` subquery is
 * evaluated against the statement snapshot and never re-checked, so a reclaim committing in that
 * window would let this stale attempt terminate an event the new owner may already have handled.
 * The DELETE reads `FROM owner` for the same reason — sibling data-modifying CTEs have no defined
 * order, and two independent CTEs touching one row is the documented unsupported case.
 *
 * **The receipt is the first-outcome arbiter here too, not only on the permanent-first-attempt
 * path.** Holding the claim does not mean nobody else handled the event: an earlier attempt whose
 * lease lapsed can still be running, and it can still SUCCEED and receipt. Writing the dead letter
 * from `owner` would then mark an event terminally failed that had in fact been handled. Selecting
 * it `FROM receipt` makes the receipt's primary key decide: an existing success receipt suppresses
 * the audit row, while the claim is still released and the attempt still counted.
 *
 * @returns whether this call actually wrote the dead letter. A replayed finalization owns the
 *   event and still returns false, because the audit row was already there and nothing was added.
 */
async function finalizeClaimedDeadLetter(
  consumer: string,
  eventId: number,
  error: unknown,
  token: string
): Promise<{ owned: boolean; deadLettered: boolean }> {
  const description = errorText(error);
  const rows = await sql!(
    `WITH owner AS (
       SELECT consumer, event_id FROM event_consumer_failures
       WHERE consumer = $1 AND event_id = $2 AND claim_token = $4
       FOR UPDATE
     ), receipt AS (
       INSERT INTO event_receipts (consumer, event_id)
       SELECT $1, $2 FROM owner
       ON CONFLICT DO NOTHING
       RETURNING event_id
     ), dead AS (
       INSERT INTO event_dead_letters (event_id, consumer, error)
       SELECT $2, $1, $3 FROM receipt
       ON CONFLICT (consumer, event_id) DO NOTHING
       RETURNING id
     ), cleared AS (
       DELETE FROM event_consumer_failures f
       USING owner o
       WHERE f.consumer = o.consumer AND f.event_id = o.event_id
       RETURNING f.event_id
     )
     SELECT (SELECT count(*)::int FROM owner) AS owned,
            (SELECT count(*)::int FROM dead) AS dead_lettered`,
    [consumer, eventId, description, token]
  );
  const row = rows[0] as { owned: number; dead_lettered: number };
  const deadLettered = Number(row.dead_lettered) > 0;
  if (deadLettered) logDeadLetter(consumer, eventId, description);
  return { owned: Number(row.owned) > 0, deadLettered };
}

/**
 * Terminal finalization for a `PermanentEffectError` raised on an event with no failures row.
 *
 * **The receipt insert is the arbiter, and that is the whole point.** A concurrent drainer may be
 * running the same never-failed event and may SUCCEED — its receipt and this dead letter are two
 * mutually exclusive verdicts on one event, and "no failures row exists" cannot separate them:
 * both attempts observe the same absence. Inserting the receipt first, and writing the dead letter
 * only for the row THIS statement inserted, makes the receipt's primary key decide. A success that
 * receipted first therefore suppresses the dead letter entirely, and two simultaneous permanent
 * failures produce one dead letter rather than two claims of ownership.
 *
 * No failures row is deleted here: by construction there was none, and one registered concurrently
 * belongs to whichever drainer holds its claim. Retention collects it.
 */
async function finalizePermanentFirstAttempt(
  consumer: string,
  eventId: number,
  error: unknown
): Promise<boolean> {
  const description = errorText(error);
  const rows = await sql!(
    `WITH receipt AS (
       INSERT INTO event_receipts (consumer, event_id) VALUES ($1, $2)
       ON CONFLICT DO NOTHING
       RETURNING event_id
     ), dead AS (
       INSERT INTO event_dead_letters (event_id, consumer, error)
       SELECT $2, $1, $3 FROM receipt
       ON CONFLICT (consumer, event_id) DO NOTHING
       RETURNING id
     ), cleared AS (${CLEAR_UNLEASED_FAILURE}
     )
     SELECT count(*)::int AS dead_lettered FROM dead`,
    [consumer, eventId, description]
  );
  const deadLettered = Number((rows[0] as { dead_lettered: number }).dead_lettered) > 0;
  if (deadLettered) logDeadLetter(consumer, eventId, description);
  return deadLettered;
}

// ==================== Per-event processing ====================

/**
 * An event with no failures row yet. Two drainers racing it still serialize on the receipt's
 * primary key, and no lease is taken where nothing has failed.
 */
async function applyFirstAttempt(
  descriptor: EventConsumerDescriptor,
  event: StoredEvent,
  counts: DrainCounts
): Promise<void> {
  try {
    await descriptor.handleEvent(event);
  } catch (error) {
    // **`RetryLaterError` is not a failure and must leave NO trace** — see the class for why. A
    // consumer that holds one claim per event refuses a second drainer, and recording that refusal
    // would open a failures row, count an attempt, and pace the next one; three refusals fit inside
    // one owner's lease, at which point the loser dead-letters and receipts an event whose owner is
    // still working. Skipping the event leaves it unreceipted, so the anti-join offers it again.
    if (error instanceof RetryLaterError) return;
    if (error instanceof PermanentEffectError) {
      if (await finalizePermanentFirstAttempt(descriptor.name, event.id, error)) {
        counts.failed += 1;
        counts.deadLettered += 1;
      }
      return;
    }
    // Registration only: `MAX_ATTEMPTS` is at least 2, so a first failure never finalizes.
    if (await registerFirstFailure(descriptor.name, event.id, error)) counts.failed += 1;
    return;
  }
  if (await insertReceipt(descriptor.name, event.id)) counts.receipted += 1;
}

/** A retry the caller owns the claim for — until a ledger statement says otherwise. */
async function applyClaimedRetry(
  descriptor: EventConsumerDescriptor,
  event: StoredEvent,
  claim: { token: string; attempts: number },
  counts: DrainCounts
): Promise<void> {
  try {
    await descriptor.handleEvent(event);
  } catch (error) {
    // Contention again — no attempt, no dead letter. The drain's own claim IS released, though:
    // holding it after deciding to skip would block the next pass for a full lease over an event
    // this one never touched.
    if (error instanceof RetryLaterError) {
      await releaseFailureLease(descriptor.name, event.id, claim.token);
      return;
    }
    const attempts = claim.attempts + 1;
    if (error instanceof PermanentEffectError || attempts >= MAX_ATTEMPTS) {
      const outcome = await finalizeClaimedDeadLetter(descriptor.name, event.id, error, claim.token);
      // The attempt is counted whenever this drainer still owned it; the dead letter only when
      // this statement wrote one — a replayed finalization owns the event and adds no audit row.
      if (outcome.owned) counts.failed += 1;
      if (outcome.deadLettered) counts.deadLettered += 1;
      return;
    }
    if (await recordRetryFailure(descriptor.name, event.id, claim.token, attempts, error)) {
      counts.failed += 1;
    }
    return;
  }
  if (await receiptAndClearFailure(descriptor.name, event.id, claim.token)) counts.receipted += 1;
}

async function processScanned(
  descriptor: EventConsumerDescriptor,
  scanned: ScannedEvent,
  counts: DrainCounts
): Promise<void> {
  counts.processed += 1;

  if (!scanned.hasFailure) {
    await applyFirstAttempt(descriptor, scanned.event, counts);
    return;
  }

  const claim = await claimFailedEvent(descriptor.name, scanned.event.id);
  if (!claim) return; // Another claimant took it between the scan and now.
  await applyClaimedRetry(descriptor, scanned.event, claim, counts);
}

// ==================== Cursor ====================

interface ConsumerCursor {
  lastEventId: number;
  activationCutoff: number;
}

async function readCursor(consumer: string): Promise<ConsumerCursor | null> {
  const rows = await sql!(
    `SELECT last_event_id, activation_cutoff FROM event_consumers WHERE consumer = $1`,
    [consumer]
  );
  if (rows.length === 0) return null;
  const r = rows[0] as { last_event_id: string | number; activation_cutoff: string | number };
  return { lastEventId: Number(r.last_event_id), activationCutoff: Number(r.activation_cutoff) };
}

/**
 * Advance the fast path's scan floor. **This is an optimization and carries no correctness claim.**
 *
 * Two bounds, and both matter:
 *   - `blocker` — the lowest id above the cutoff that is still unreceipted. The floor never passes
 *     it, so nothing visible-and-unhandled is skipped by the fast path. Rows the candidate query
 *     excludes — unknown kinds, paced failures — are unreceipted and therefore block it too, which
 *     is the intended cost of leaving them for a newer build or a later pass.
 *   - `aged` — the highest id whose row is older than the grace window. The floor never passes that
 *     either, which bounds the exposure to ids allocated before commit: a transaction that
 *     allocated an id and commits late lands below the floor only if it stayed open past the grace.
 *
 * When it does land below the floor anyway, the hourly sweep consumes it — `statement_timeout`
 * bounds single statements, not transaction lifetime, so no timeout-based proof exists that nothing
 * can commit below the floor, and none is claimed.
 *
 * The anti-join is on receipts alone: finalization writes the dead letter and the receipt in ONE
 * statement, so "dead-lettered but unreceipted" is not a committable state.
 */
async function advanceFloor(consumer: string, cutoff: number): Promise<void> {
  await sql!(
    `WITH aged AS (
       SELECT COALESCE(max(id), 0) AS id FROM events
       WHERE created_at < now() - make_interval(secs => $2::double precision)
     ), blocker AS (
       SELECT min(e.id) AS id FROM events e
       WHERE e.id > $3
         AND NOT EXISTS (SELECT 1 FROM event_receipts r WHERE r.consumer = $1 AND r.event_id = e.id)
     )
     UPDATE event_consumers c
     SET last_event_id = GREATEST(
           c.last_event_id,
           LEAST((SELECT id FROM aged), COALESCE((SELECT id FROM blocker) - 1, (SELECT id FROM aged)))
         ),
         updated_at = now()
     WHERE c.consumer = $1`,
    [consumer, floorGraceSeconds(), cutoff]
  );
}

// ==================== Public drain surface ====================

async function runPass(
  descriptor: EventConsumerDescriptor,
  floor: number,
  cutoff: number,
  limit: number,
  deadline?: number
): Promise<DrainCounts> {
  const counts = zeroCounts();
  const scanned = await scanEvents(descriptor.name, floor, cutoff, limit);
  // Sequential, in id order: a claim taken for one event must be settled before the next is
  // considered, and consumers may not assume they run alone anyway.
  for (const row of scanned) {
    // Stop taking on new events once the phase's share of the invocation is spent. Whatever is
    // left is still unreceipted, so the next invocation — or the sweep — takes it from here.
    if (overDeadline(deadline)) break;
    await processScanned(descriptor, row, counts);
  }
  return counts;
}

/**
 * One bounded fast-path pass for a consumer.
 *
 * A consumer with no `event_consumers` row is INACTIVE and this is a no-op: activation is explicit
 * and fenced, so a missing row never means "replay from zero".
 */
export async function drainEventConsumer(
  descriptor: EventConsumerDescriptor,
  options: DrainOptions = {}
): Promise<DrainCounts> {
  const cursor = await readCursor(descriptor.name);
  if (!cursor) return zeroCounts();

  const limit = Math.max(1, Math.floor(options.batchSize ?? DEFAULT_BATCH_SIZE));
  const counts = await runPass(
    descriptor,
    cursor.lastEventId,
    cursor.activationCutoff,
    limit,
    options.deadline
  );
  await advanceFloor(descriptor.name, cursor.activationCutoff);
  return counts;
}

/**
 * The hourly below-floor backstop: the same per-event processing with NO id floor.
 *
 * This is where correctness for late-committing events lives. It does not touch the floor — an
 * event it consumes was below the floor by definition, and moving the floor is the fast path's job.
 */
export async function sweepEventConsumer(
  descriptor: EventConsumerDescriptor,
  options: DrainOptions = {}
): Promise<DrainCounts> {
  const cursor = await readCursor(descriptor.name);
  if (!cursor) return zeroCounts();
  const limit = Math.max(1, Math.floor(options.batchSize ?? SWEEP_BATCH_SIZE));
  return runPass(
    descriptor,
    cursor.activationCutoff,
    cursor.activationCutoff,
    limit,
    options.deadline
  );
}

/**
 * The documented redrive: clear the dead letter, its skipped receipt, and any failures row in one
 * statement, and the standard scan reprocesses the event. Safe because every consumer effect is
 * idempotent under its natural key.
 *
 * **Every delete descends from the dead letter, and the dead letter descends from a locked live
 * event.** Written as three independent CTEs this was a destructive operation on the wrong input:
 * redriving an id that was NOT dead-lettered deleted that event's perfectly valid success receipt —
 * scheduling a replay of an event that had already been handled — and any live claim with it, while
 * still returning `false` to say it had done nothing. Chaining them means an id with no dead letter
 * matches nothing anywhere.
 *
 * The `FOR UPDATE` on the event row settles the other direction, against retention: pruning takes
 * the same lock with `SKIP LOCKED`, so either pruning gets there first and this returns `false`
 * with the event gone, or this holds the row and pruning skips it. Without the lock a prune landing
 * between the redrive and the next scan would delete the event whose ledgers had just been cleared,
 * and the redrive would report success for a replay that can never happen.
 */
export async function redriveEventDeadLetter(consumer: string, eventId: number): Promise<boolean> {
  const rows = await sql!(
    `WITH live AS (
       SELECT id FROM events WHERE id = $2 FOR UPDATE
     ), dead AS (
       DELETE FROM event_dead_letters d
       USING live l
       WHERE d.consumer = $1 AND d.event_id = l.id
       RETURNING d.consumer, d.event_id
     ), receipt AS (
       DELETE FROM event_receipts r
       USING dead x
       WHERE r.consumer = x.consumer AND r.event_id = x.event_id
       RETURNING r.event_id
     ), failure AS (
       DELETE FROM event_consumer_failures f
       USING dead x
       WHERE f.consumer = x.consumer AND f.event_id = x.event_id
       RETURNING f.event_id
     )
     SELECT count(*)::int AS redriven FROM dead`,
    [consumer, eventId]
  );
  return Number((rows[0] as { redriven: number }).redriven) > 0;
}

// ==================== Retention ====================

/**
 * Bounded retention pruning, owned by housekeeping (the drain route's hourly duty here; the
 * worker's timer from P3.1).
 *
 * `events` is pruned **per event**, never by the floor: a row goes only when it is older than the
 * retention window AND every active consumer has settled it. "Settled" is receipt OR dead letter OR
 * `id <= that consumer's activation_cutoff` — the last one is what stops each newly activated
 * consumer from making all pre-activation history permanently unprunable.
 */
export async function pruneEventLedgers(options: DeadlineOptions = {}): Promise<PruneCounts> {
  const batch = Math.max(1, Math.floor(envNumber("EVENT_PRUNE_BATCH_SIZE", DEFAULT_PRUNE_BATCH_SIZE)));
  const maxPasses = Math.max(1, Math.floor(envNumber("EVENT_PRUNE_MAX_PASSES", DEFAULT_PRUNE_MAX_PASSES)));
  const totals: PruneCounts = {
    events: 0,
    receipts: 0,
    shadowRows: 0,
    failures: 0,
    deadLetters: 0,
    ingestProgress: 0,
    orphanedFailures: 0,
  };

  for (let pass = 0; pass < maxPasses; pass += 1) {
    if (pass > 0 && overDeadline(options.deadline)) break;
    const one = await prunePass(batch);
    totals.events += one.events;
    totals.receipts += one.receipts;
    totals.shadowRows += one.shadowRows;
    totals.failures += one.failures;
    totals.deadLetters += one.deadLetters;
    totals.ingestProgress += one.ingestProgress;
    totals.orphanedFailures += one.orphanedFailures;
    if (
      one.events +
        one.receipts +
        one.shadowRows +
        one.failures +
        one.deadLetters +
        one.ingestProgress +
        one.orphanedFailures ===
      0
    ) {
      break;
    }
  }

  return totals;
}

/**
 * One bounded pass over every ledger.
 *
 * **Every statement is capped by a candidate subquery**, and the duty repeats it a fixed number of
 * times. An unbounded `DELETE` here is a latency bomb: retention runs on the same request as a
 * drain, and the first run after a backlog — or the first run after someone lowers the retention
 * window — would try to delete an unbounded number of rows inside one statement, holding locks and
 * blowing the invocation's budget. Whatever a pass leaves behind waits for the next hourly run,
 * which is exactly what a retention policy is allowed to do.
 */
async function prunePass(batch: number): Promise<PruneCounts> {
  const retentionDays = Math.floor(envNumber("EVENT_RETENTION_DAYS", DEFAULT_RETENTION_DAYS));
  const ledgerDays = Math.floor(envNumber("EVENT_LEDGER_RETENTION_DAYS", DEFAULT_LEDGER_RETENTION_DAYS));

  // `FOR UPDATE SKIP LOCKED` is what makes retention and redrive coexist. A redrive holds its
  // event row while it clears that event's ledgers; without the lock this statement could delete
  // the row in that window, and the redrive would report a replay that can never happen. Skipping
  // rather than waiting keeps the duty bounded: a locked row is simply next hour's candidate.
  const events = await sql!(
    `DELETE FROM events
     WHERE id IN (
       SELECT e.id FROM events e
       WHERE e.created_at < now() - make_interval(days => $1::int)
         AND NOT EXISTS (
           SELECT 1 FROM event_consumers c
           WHERE e.id > c.activation_cutoff
             AND NOT EXISTS (SELECT 1 FROM event_receipts r WHERE r.consumer = c.consumer AND r.event_id = e.id)
             AND NOT EXISTS (SELECT 1 FROM event_dead_letters d WHERE d.consumer = c.consumer AND d.event_id = e.id)
         )
       ORDER BY e.id
       LIMIT $2
       FOR UPDATE SKIP LOCKED
     )
     RETURNING id`,
    [retentionDays, batch]
  );

  // Receipts and shadow rows have no FK to `events` (the log is pruned by policy, not by cascade),
  // so they are collected behind it here.
  const receipts = await sql!(
    `DELETE FROM event_receipts
     WHERE (consumer, event_id) IN (
       SELECT r.consumer, r.event_id FROM event_receipts r
       WHERE NOT EXISTS (SELECT 1 FROM events e WHERE e.id = r.event_id)
       LIMIT $1
     )
     RETURNING event_id`,
    [batch]
  );
  const shadowRows = await sql!(
    `DELETE FROM event_consumer_shadow
     WHERE id IN (
       SELECT s.id FROM event_consumer_shadow s
       WHERE NOT EXISTS (SELECT 1 FROM events e WHERE e.id = s.event_id)
       LIMIT $1
     )
     RETURNING id`,
    [batch]
  );
  // M11-2 P2.1's ingest ledgers — the recipient-progress rows and the fan-out claims — collected
  // behind their event for the same reason: neither has an FK (the log is pruned by policy, not by
  // cascade), both exist only so an interrupted fan-out can resume, and one event can leave up to
  // 2,000 progress rows that nothing will ever read again.
  const ingestProgress = await sql!(
    `DELETE FROM ingest_progress
     WHERE (event_id, recipient_agent_id) IN (
       SELECT p.event_id, p.recipient_agent_id FROM ingest_progress p
       WHERE NOT EXISTS (SELECT 1 FROM events e WHERE e.id = p.event_id)
       LIMIT $1
     )
     RETURNING event_id`,
    [batch]
  );
  const ingestClaims = await sql!(
    `DELETE FROM ingest_event_claims
     WHERE event_id IN (
       SELECT c.event_id FROM ingest_event_claims c
       WHERE NOT EXISTS (SELECT 1 FROM events e WHERE e.id = c.event_id)
       LIMIT $1
     )
     RETURNING event_id`,
    [batch]
  );

  // `event_consumer_failures` carries no created_at, so `next_attempt_at` — stamped by every writer
  // of the row — is the age signal. A row whose event is gone is dead weight either way.
  //
  // **The age arm excludes a LIVE LEASE, and that is not a refinement.** Claiming an attempt does
  // not move `next_attempt_at`, so a long-dormant failure that is being retried right now still
  // carries a month-old stamp. Deleting it mid-attempt destroys the claim its owner needs to
  // finalize: every outcome write is token-fenced against that row, so the owner would record
  // nothing at all — no receipt, no dead letter, no attempt — and the event would silently start
  // over from zero attempts on the next pass.
  const failures = await sql!(
    `DELETE FROM event_consumer_failures
     WHERE (consumer, event_id) IN (
       SELECT f.consumer, f.event_id FROM event_consumer_failures f
       WHERE NOT EXISTS (SELECT 1 FROM events e WHERE e.id = f.event_id)
          OR (f.next_attempt_at < now() - make_interval(days => $1::int)
              AND (f.lease_expires_at IS NULL OR f.lease_expires_at <= now()))
       LIMIT $2
     )
     RETURNING event_id`,
    [ledgerDays, batch]
  );
  const deadLetters = await sql!(
    `DELETE FROM event_dead_letters
     WHERE id IN (
       SELECT d.id FROM event_dead_letters d
       WHERE d.created_at < now() - make_interval(days => $1::int)
       LIMIT $2
     )
     RETURNING id`,
    [ledgerDays, batch]
  );

  // **The janitor.** A failure row whose event is already receipted is unreachable: the receipt
  // wins the anti-join, so no scan ever offers the event again and no drainer can claim the row.
  // It is a hygiene problem, not a correctness one — but left to the 30-day ledger window it reads
  // like a pending retry for a month. The two registration guards close both orders of the ordinary
  // race; this collects what the accepted write-skew at `registerFirstFailure` still lets through,
  // within the hour. Live claims are left alone for the reason the age arm leaves them alone.
  const orphanedFailures = await sql!(
    `DELETE FROM event_consumer_failures
     WHERE (consumer, event_id) IN (
       SELECT f.consumer, f.event_id FROM event_consumer_failures f
       WHERE EXISTS (
         SELECT 1 FROM event_receipts r WHERE r.consumer = f.consumer AND r.event_id = f.event_id
       )
         AND (f.lease_expires_at IS NULL OR f.lease_expires_at <= now())
       LIMIT $1
     )
     RETURNING event_id`,
    [batch]
  );

  return {
    events: events.length,
    receipts: receipts.length,
    shadowRows: shadowRows.length,
    failures: failures.length,
    deadLetters: deadLetters.length,
    ingestProgress: ingestProgress.length + ingestClaims.length,
    orphanedFailures: orphanedFailures.length,
  };
}

// ==================== Heartbeats ====================

/** The drain route's runtime id. Its heartbeat rows are one per contract hash it has run under. */
export const DRAIN_WORKER_ID = "events-drain";
/** The hourly-duty claim row. A separate runtime id, so a duty claim is never read as a barrier. */
const HOURLY_WORKER_ID = "events-drain-hourly";
/**
 * The hourly claim's fixed hash slot. `worker_heartbeats` is keyed on (worker_id, contract_hash),
 * and the claim must land on ONE row whatever the build's contract is — a per-hash claim row would
 * hand every rolling deploy a second, unclaimed hourly slot.
 */
const HOURLY_CLAIM_HASH = "";
const HOURLY_INTERVAL_SECONDS = 55 * 60;

/**
 * Stamp this invocation's own contract hash.
 *
 * The deployment-version barrier compares **contract identity, never liveness**: an old runtime
 * that is alive and healthy can still receipt an event under an old effect set, permanently
 * suppressing a newly enabled one. This is the drain route's half of that signal; the worker
 * reports the same hash from P3.1.
 *
 * **Each invocation upserts ITS OWN hash row, and that is why the key includes the hash.** A single
 * row per runtime is last-writer-wins: during a rolling deploy the first new invocation would
 * overwrite the stamp while an old invocation is still mid-drain, and the barrier would report the
 * target contract everywhere while the old effect set could still receipt an event.
 */
export async function recordEventDrainHeartbeat(
  contractHash: string,
  workerId: string = DRAIN_WORKER_ID
): Promise<void> {
  await sql!(
    `INSERT INTO worker_heartbeats (worker_id, contract_hash, seen_at, completed_at)
     VALUES ($1, $2, now(), now())
     ON CONFLICT (worker_id, contract_hash) DO UPDATE SET seen_at = now(), completed_at = now()`,
    [workerId, contractHash]
  );
}

/**
 * Lease this invocation's contract as IN FLIGHT, before it drains anything.
 *
 * **Completion is not enough on its own, and this is the half that was missing.** An invocation
 * that is still inside its drain has written no completion yet, so a barrier reading completions
 * alone sees the old build's LAST completion going stale while the new build's is fresh — and
 * passes, while the old invocation is at that moment still able to receipt an event under the old
 * effect set. Leasing before the work makes that invocation visible for as long as it could
 * possibly still be running.
 *
 * The lease is never cleared on completion, deliberately: several invocations can share one
 * contract, so clearing it would let one finishing early erase a sibling that is still going. It
 * expires on its own, one invocation budget after the last invocation STARTED, which is exactly the
 * conservative reading the barrier needs.
 */
export async function beginEventDrainHeartbeat(
  contractHash: string,
  workerId: string = DRAIN_WORKER_ID
): Promise<void> {
  const budgetSeconds = drainBudgetSeconds();
  await sql!(
    `INSERT INTO worker_heartbeats (worker_id, contract_hash, seen_at, active_until)
     VALUES ($1, $2, now(), now() + make_interval(secs => $3::double precision))
     ON CONFLICT (worker_id, contract_hash) DO UPDATE
       SET seen_at = now(),
           active_until = GREATEST(
             worker_heartbeats.active_until,
             now() + make_interval(secs => $3::double precision)
           )`,
    [workerId, contractHash, budgetSeconds]
  );
}

/** One runtime's heartbeat rows: the contracts it has run under, and the state of each. */
export interface DrainBarrierState {
  hashes: Array<{
    hash: string;
    /** Last activity of any kind under this contract. */
    seenAt: string;
    /** Last completed drain under this contract, or null if none has finished yet. */
    completedAt: string | null;
    /** While in the future, an invocation under this contract may still be running. */
    activeUntil: string | null;
  }>;
}

/**
 * Read one runtime's heartbeat rows, for the deployment-version barrier.
 *
 * **The barrier rule, which this function serves and does not itself apply:** a runtime has crossed
 * to a target contract when the target hash's row has a FRESH `completedAt` *and* no other hash row
 * for that runtime still has `activeUntil` in the future.
 *
 * Both halves are needed, and each closes a different hole. A fresh completion for the target
 * proves only that some invocation finished under the new contract; the deploy is rolling, so
 * another invocation may still be inside a drain under the old one, and any event it receipts is
 * finalized under the old effect set with the newly enabled effect never produced for it. The
 * absence of a live `activeUntil` on every other contract is what establishes that no such
 * invocation can still be running — which a completion timestamp cannot say, because an invocation
 * that has not finished has not written one.
 *
 * The check itself belongs to the P3-era release tooling, which also knows the worker's side of the
 * pair; u1 ships both signals and the reader so the rule is expressible and testable now.
 */
export async function readDrainBarrierState(workerId: string): Promise<DrainBarrierState> {
  const rows = await sql!(
    `SELECT contract_hash, seen_at, completed_at, active_until
     FROM worker_heartbeats WHERE worker_id = $1 ORDER BY seen_at DESC`,
    [workerId]
  );
  return {
    hashes: (rows as Array<{
      contract_hash: string;
      seen_at: unknown;
      completed_at: unknown;
      active_until: unknown;
    }>).map((row) => ({
      hash: row.contract_hash,
      seenAt: toIsoOrEmpty(row.seen_at),
      completedAt: toIsoOrNull(row.completed_at),
      activeUntil: toIsoOrNull(row.active_until),
    })),
  };
}

/**
 * Claim the hourly duties, or report that they are not due.
 *
 * One conditional upsert, so the claim and the stamp cannot separate: several instances of the
 * five-minute cron may run at once and exactly one gets `true`. The window is 55 minutes so a run
 * that is a few minutes late still counts as hourly.
 */
export async function claimHourlyEventDuties(): Promise<boolean> {
  const rows = await sql!(
    `INSERT INTO worker_heartbeats (worker_id, contract_hash, seen_at) VALUES ($1, $2, now())
     ON CONFLICT (worker_id, contract_hash) DO UPDATE SET seen_at = now()
     WHERE worker_heartbeats.seen_at < now() - make_interval(secs => $3::double precision)
     RETURNING worker_id`,
    [HOURLY_WORKER_ID, HOURLY_CLAIM_HASH, HOURLY_INTERVAL_SECONDS]
  );
  return rows.length > 0;
}
