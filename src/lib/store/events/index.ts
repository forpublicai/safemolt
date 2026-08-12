import { pickStore } from "../pick-store";
import * as db from "./db";
import * as drainDb from "./drain-db";
import * as drainMem from "./drain-memory";
import * as mem from "./memory";

export type {
  DeadlineOptions,
  DrainBarrierState,
  DrainCounts,
  DrainOptions,
  EventConsumerDescriptor,
  PruneCounts,
} from "./drain-db";

/** Pure derivation of one phase's share of an invocation; both modes compute it the same way. */
export { eventDrainPhaseBudgetMs } from "./drain-db";
export type { EventStatementFragment, EventStatementOptions } from "./statement";
export type { EmittedEvent } from "./db";
export type { ShadowEffectRow } from "./consumer-state";

/**
 * Consumer-owned state, exported without a `pickStore` pair because both halves are database-only
 * by construction and `consumer-state.ts` says why: memory mode runs no soak and needs no retry
 * ledger. The consumers gate on `hasDatabase()` before calling either, exactly as the DB-only store
 * domains (`classes`, `ao`) are called today.
 */
export {
  claimIngestEvent,
  completeIngestRecipient,
  ingestEventLeaseMs,
  listIncompleteIngestRecipients,
  listIngestProgressRecipients,
  recordConsumerShadowEffects,
  registerIngestRecipients,
  releaseIngestEvent,
  renewIngestEventLease,
} from "./consumer-state";

/**
 * The Decision-2 renderer is a pure function shared by both modes rather than a `pickStore` pair:
 * memory mode never renders SQL, and a memory twin of a string builder would be a second source of
 * truth for the event column list.
 */
export { emitEventStatement } from "./statement";

/**
 * The memory-mode dispatcher's test seam (Decision 6). Exported from the facade rather than reached
 * through `store/events/memory-dispatch` directly, so a test never imports the events domain's
 * internals ahead of the store facade.
 */
export { __setMemoryEventConsumersForTests } from "./memory-dispatch";

export const emitEvent = pickStore(db.emitEvent, mem.emitEvent);
export const listEventsAfter = pickStore(db.listEventsAfter, mem.listEventsAfter);
export const getEventById = pickStore(db.getEventById, mem.getEventById);

export const activateEventConsumer = pickStore(drainDb.activateEventConsumer, drainMem.activateEventConsumer);
export const drainEventConsumer = pickStore(drainDb.drainEventConsumer, drainMem.drainEventConsumer);
export const sweepEventConsumer = pickStore(drainDb.sweepEventConsumer, drainMem.sweepEventConsumer);
export const redriveEventDeadLetter = pickStore(drainDb.redriveEventDeadLetter, drainMem.redriveEventDeadLetter);
export const pruneEventLedgers = pickStore(drainDb.pruneEventLedgers, drainMem.pruneEventLedgers);
export const beginEventDrainHeartbeat = pickStore(drainDb.beginEventDrainHeartbeat, drainMem.beginEventDrainHeartbeat);
export const recordEventDrainHeartbeat = pickStore(drainDb.recordEventDrainHeartbeat, drainMem.recordEventDrainHeartbeat);
export const readDrainBarrierState = pickStore(drainDb.readDrainBarrierState, drainMem.readDrainBarrierState);
export const claimHourlyEventDuties = pickStore(drainDb.claimHourlyEventDuties, drainMem.claimHourlyEventDuties);
