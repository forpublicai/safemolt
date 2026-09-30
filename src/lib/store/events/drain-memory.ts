import type {
  DeadlineOptions,
  DrainBarrierState,
  DrainCounts,
  DrainOptions,
  EventConsumerDescriptor,
  PruneCounts,
} from "./drain-db";

/**
 * M11-2 u1 — memory mode has no drain (Decision 6).
 *
 * There is no worker and no cron in the no-DB path, so nothing would ever call one. From u2 the
 * effects come from an **in-process dispatcher invoked by the memory store itself** at the moment
 * of the append, which is what keeps Jest's projections visible exactly when the store call
 * resolves. These exports exist so the drain route and the facade are one shape in both modes; each
 * reports that it did nothing, which is the truth.
 */

function zeroCounts(): DrainCounts {
  return { processed: 0, receipted: 0, failed: 0, deadLettered: 0 };
}

export async function activateEventConsumer(
  name: string
): Promise<{ activated: boolean; activationCutoff: number | null }> {
  return { activated: false, activationCutoff: null };
}

export async function drainEventConsumer(
  descriptor: EventConsumerDescriptor,
  options?: DrainOptions
): Promise<DrainCounts> {
  return zeroCounts();
}

export async function sweepEventConsumer(
  descriptor: EventConsumerDescriptor,
  options?: DrainOptions
): Promise<DrainCounts> {
  return zeroCounts();
}

export async function redriveEventDeadLetter(consumer: string, eventId: number): Promise<boolean> {
  return false;
}

export async function pruneEventLedgers(options?: DeadlineOptions): Promise<PruneCounts> {
  return {
    events: 0,
    receipts: 0,
    shadowRows: 0,
    failures: 0,
    deadLetters: 0,
    ingestProgress: 0,
    orphanedFailures: 0,
  };
}

export async function recordEventDrainHeartbeat(contractHash: string, workerId?: string): Promise<void> {
  /* No runtime to report: the heartbeat table exists only where the drain does. */
}

export async function beginEventDrainHeartbeat(contractHash: string, workerId?: string): Promise<void> {
  /* Nothing drains here, so nothing is ever in flight. */
}

/** No drain runtimes exist here, so no contract has ever been reported — which is the honest answer. */
export async function readDrainBarrierState(workerId: string): Promise<DrainBarrierState> {
  return { hashes: [] };
}

export async function claimHourlyEventDuties(): Promise<boolean> {
  return false;
}
