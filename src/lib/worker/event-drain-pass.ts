import { runAdmissionsExpiryDuty } from "@/lib/admissions";
import { runPulseMaintenance } from "@/lib/agent-pulse/runner";
import { computeConsumerContractHash } from "@/lib/events/consumer-contract";
import { eventConsumers } from "@/lib/events/consumers/registry";
import {
  activateEventConsumer,
  beginEventDrainHeartbeat,
  claimHourlyEventDuties,
  drainEventConsumer,
  eventDrainPhaseBudgetMs,
  pruneEventLedgers,
  pruneTerminalWakeups,
  recordEventDrainHeartbeat,
  sweepEventConsumer,
  type DrainCounts,
  type PruneCounts,
} from "@/lib/store";

/**
 * M11-2 u6 P3.1/P3.4 — the one event-drain pass, shared by `internal/events-drain` (the every-five-
 * minutes cron) and the worker's fast loop (P3.1). Extracted so the two topologies run identically:
 * a duty added here runs under both without a second, drifting copy of the orchestration.
 */

/** Bounded per consumer per run, so one backlogged consumer cannot starve the others. */
const BATCH_SIZE = 100;

/** P2.2: a completed wakeup is history after this many days. */
const DEFAULT_WAKEUP_RETENTION_DAYS = 30;

/** Rows one hourly wakeup prune may delete — `pruneEventLedgers`' own bound, for its reason. */
const WAKEUP_PRUNE_BATCH_SIZE = 1_000;

function wakeupRetentionDays(): number {
  const raw = Number(process.env.WAKEUP_RETENTION_DAYS);
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : DEFAULT_WAKEUP_RETENTION_DAYS;
}

export interface ConsumerReport {
  name: string;
  processed: number;
  receipted: number;
  failed: number;
  dead_lettered: number;
}

export interface MaintenanceCounts {
  abandoned: number;
  autonomyDisabled: number;
}

/** The hourly duties' own results, so a caller can see that retention actually ran. */
export interface HourlyReport {
  swept: ConsumerReport[];
  pruned: PruneCounts;
  /** M11-2 u6 stitch item 4: completed wakeups older than the retention window. */
  prunedWakeups: number;
  maintenance: MaintenanceCounts;
}

export interface EventDrainPassResult {
  contractHash: string;
  consumers: ConsumerReport[];
  hourlyRan: boolean;
  hourly: HourlyReport | null;
}

function report(name: string, counts: DrainCounts): ConsumerReport {
  return {
    name,
    processed: counts.processed,
    receipted: counts.receipted,
    failed: counts.failed,
    dead_lettered: counts.deadLettered,
  };
}

/**
 * Activation is explicit, and registering a consumer plus deploying IS the declaration — so a pass
 * activates each registered consumer itself. The call is one fenced statement and a no-op after the
 * first run; without it a newly registered consumer would have no cursor row, and both its drain and
 * its sweep would be permanent no-ops.
 */
async function activateAll(): Promise<void> {
  for (const consumer of eventConsumers) {
    await activateEventConsumer(consumer.name);
  }
}

/**
 * The hourly duties: the below-floor sweep for every consumer, retention pruning (the event ledgers
 * AND the wakeup queue), and Lane D's `runPulseMaintenance` (abandoned leases; a disabled agent's
 * still-pending wakeups).
 *
 * Without the retention duty here the supported Vercel-only (cron-only) topology would accumulate
 * every ledger indefinitely — the worker's timer is not available in degraded mode. Same reasoning
 * for the wakeup maintenance: P3.3's runner frees a stuck one-inflight slot on a claim it completes,
 * but a claim that crashed leaves its lease to expire, and only this sweep — worker or cron — ever
 * marks it `abandoned`; nothing else in the degraded topology ever will. Delegated to
 * `runPulseMaintenance` rather than calling the two store writers directly, so there is one
 * implementation of "maintain the wakeup queue" shared with the worker's own wakeup duty.
 *
 * `pruneTerminalWakeups` runs AFTER `runPulseMaintenance`, and the order earns its keep: maintenance
 * is what turns an expired lease into a terminal `abandoned` row, so a row it terminalizes this hour
 * becomes prunable in a later one rather than sitting claimed-forever outside both duties.
 */
async function runHourlyDuties(deadline: number): Promise<HourlyReport> {
  const swept = await Promise.all(
    eventConsumers.map(async (consumer) => report(consumer.name, await sweepEventConsumer(consumer, { deadline })))
  );
  const pruned = await pruneEventLedgers({ deadline });
  const maintenance = await runPulseMaintenance();
  const prunedWakeups = await pruneTerminalWakeups(wakeupRetentionDays(), WAKEUP_PRUNE_BATCH_SIZE);
  return { swept, pruned, prunedWakeups, maintenance };
}

/**
 * One full pass: lease the heartbeat, activate consumers, run the admissions offer-expiry duty, run
 * the hourly duties if due, drain every consumer, and stamp completion.
 *
 * `workerId` distinguishes the drain route's heartbeat rows from the worker's own — both report
 * under the SAME contract hash mechanism (`computeConsumerContractHash`), so the deployment-version
 * barrier sees either topology, but a stalled worker and a stalled cron route are diagnosable
 * separately in `worker_heartbeats`.
 */
export async function runEventDrainPass(workerId?: string): Promise<EventDrainPassResult> {
  const contractHash = computeConsumerContractHash();

  // Leased FIRST. The barrier must be able to see an invocation that is still mid-drain — one that
  // has receipted nothing yet but still could, under whatever effect set this build carries. A
  // signal written only on completion cannot show that, and a cutover would proceed while an old
  // invocation was still running.
  await beginEventDrainHeartbeat(contractHash, workerId);
  await activateAll();
  await runAdmissionsExpiryDuty();

  // The hourly duties run BEFORE the fast-path drains, and the order is the point: a consumer with
  // a permanent backlog fills its batch on every invocation, so duties queued behind it would never
  // run at all. That would starve the below-floor sweep, retention, and the wakeup maintenance
  // sweep, indefinitely, on exactly the deployments busy enough to need all of them.
  const phaseBudget = eventDrainPhaseBudgetMs();
  const hourlyDue = await claimHourlyEventDuties();
  const hourly = hourlyDue ? await runHourlyDuties(Date.now() + phaseBudget) : null;

  // Concurrently, and each pass with its own deadline. Different consumers contend on nothing —
  // separate cursors, separate receipts, separate effects — so a batch size bounds the row count and
  // says nothing about the time; running them in registry order would let the first slow one decide
  // whether the rest ran at all.
  const drainDeadline = Date.now() + phaseBudget;
  const consumers = await Promise.all(
    eventConsumers.map(async (consumer) =>
      report(consumer.name, await drainEventConsumer(consumer, { batchSize: BATCH_SIZE, deadline: drainDeadline }))
    )
  );

  // Stamped last, so the completion a runtime reports is one it has actually finished a pass for.
  await recordEventDrainHeartbeat(contractHash, workerId);

  return { contractHash, consumers, hourlyRan: hourlyDue, hourly };
}
