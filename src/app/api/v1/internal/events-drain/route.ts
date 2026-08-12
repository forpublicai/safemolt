import { NextResponse } from "next/server";

import { errorResponse } from "@/lib/auth";
import { requireCronAuth } from "@/lib/auth-cron";
import { computeConsumerContractHash } from "@/lib/events/consumer-contract";
import { eventConsumers } from "@/lib/events/consumers/registry";
import {
  activateEventConsumer,
  beginEventDrainHeartbeat,
  claimHourlyEventDuties,
  drainEventConsumer,
  eventDrainPhaseBudgetMs,
  pruneEventLedgers,
  recordEventDrainHeartbeat,
  sweepEventConsumer,
  type DrainCounts,
  type PruneCounts,
} from "@/lib/store";

export const dynamic = "force-dynamic";
// Consumers await store and vector work per event; a bounded batch of them can outrun the default.
export const maxDuration = 300;

/** Bounded per consumer per run, so one backlogged consumer cannot starve the others. */
const BATCH_SIZE = 100;

interface ConsumerReport {
  name: string;
  processed: number;
  receipted: number;
  failed: number;
  dead_lettered: number;
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
 * Activation is explicit, and registering a consumer plus deploying IS the declaration — so the
 * route activates each registered consumer itself. The call is one fenced statement and a no-op
 * after the first run; without it a newly registered consumer would have no cursor row, and both
 * its drain and its sweep would be permanent no-ops.
 */
async function activateAll(): Promise<void> {
  for (const consumer of eventConsumers) {
    await activateEventConsumer(consumer.name);
  }
}

/**
 * The hourly duties: the below-floor sweep for every consumer and retention pruning.
 *
 * Without the retention duty here the supported Vercel-only topology would accumulate every ledger
 * indefinitely — the worker's timer is not available in degraded mode.
 */
async function runHourlyDuties(deadline: number): Promise<{ swept: ConsumerReport[]; pruned: PruneCounts }> {
  const swept = await Promise.all(
    eventConsumers.map(async (consumer) =>
      report(consumer.name, await sweepEventConsumer(consumer, { deadline }))
    )
  );
  return { swept, pruned: await pruneEventLedgers({ deadline }) };
}

/**
 * GET /api/v1/internal/events-drain — the event consumer runtime (five-minute cron).
 *
 * Born fail-closed: `requireCronAuth` refuses when `CRON_SECRET` is unset rather than admitting
 * everyone, because this route drives consumer effects, external vector ingest, and retry and
 * dead-letter processing.
 */
export async function GET(request: Request) {
  const denial = requireCronAuth(request);
  if (denial) return denial;

  try {
    const contractHash = computeConsumerContractHash();

    // Leased FIRST. The barrier must be able to see an invocation that is still mid-drain — one
    // that has receipted nothing yet but still could, under whatever effect set this build carries.
    // A signal written only on completion cannot show that, and a cutover would proceed while an
    // old invocation was still running.
    await beginEventDrainHeartbeat(contractHash);
    await activateAll();

    // **The hourly duties run BEFORE the fast-path drains, and the order is the point.** Every
    // phase here is bounded by a row count, and a row count is not a time bound: a consumer with a
    // permanent backlog fills its batch on every invocation and consumes the invocation's whole
    // budget, so duties queued behind it would never run at all. That would starve the below-floor
    // sweep — the only thing that ever consumes a late-committing event — and retention with it,
    // indefinitely, on exactly the deployments that are busy enough to need both.
    const phaseBudget = eventDrainPhaseBudgetMs();
    const hourlyDue = await claimHourlyEventDuties();
    const hourly = hourlyDue ? await runHourlyDuties(Date.now() + phaseBudget) : null;

    // **Concurrently, and each pass with its own deadline.** Different consumers contend on
    // nothing — separate cursors, separate receipts, separate effects — so running them in registry
    // order only meant that the first slow one decided whether the rest ran at all. A batch size
    // bounds the row count and says nothing about the time, and a consumer awaiting an external
    // vector service for a hundred events can spend the whole invocation on its own.
    const drainDeadline = Date.now() + phaseBudget;
    const consumers = await Promise.all(
      eventConsumers.map(async (consumer) =>
        report(
          consumer.name,
          await drainEventConsumer(consumer, { batchSize: BATCH_SIZE, deadline: drainDeadline })
        )
      )
    );

    // Stamped last, so the completion a runtime reports is one it has actually finished a pass for.
    await recordEventDrainHeartbeat(contractHash);

    return NextResponse.json({
      success: true,
      contract_hash: contractHash,
      consumers,
      hourly_ran: hourlyDue,
      hourly,
    });
  } catch (e) {
    console.error("[events-drain cron]", e);
    return errorResponse(e instanceof Error ? e.message : "Internal error", undefined, 500);
  }
}
