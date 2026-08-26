import { pickStore } from "../pick-store";
import * as db from "./db";
import * as mem from "./memory";

/**
 * M11-2 P3.2 (train a4, lane C) + P3.3 — the wakeup queue's store facade.
 *
 * P3.2's two callers write through the enqueue/re-arm exports below: the wakeup-router consumer and
 * the playground deadline sweep. **P3.3 adds the claim/lease/completion/housekeeping exports** —
 * store-layer primitives only; the runner (tick loop, context building, tool execution) that drives
 * them is a different lane's territory.
 */

export type {
  ClaimNextWakeupInput,
  ClaimNextWakeupResult,
  CreateOrReArmPlaygroundRoundWakeupInput,
  CreateOrReArmWakeupInput,
  CreateOrReArmWakeupResult,
  EnqueueWakeupInput,
  EnqueueWakeupResult,
  StoredWakeup,
  WakeupDelivery,
} from "./db";

export { PLAYGROUND_ROUND_REASON } from "./db";

export const enqueueWakeup = pickStore(db.enqueueWakeup, mem.enqueueWakeup);
export const createOrReArmWakeup = pickStore(db.createOrReArmWakeup, mem.createOrReArmWakeup);
export const createOrReArmPlaygroundRoundWakeup = pickStore(
  db.createOrReArmPlaygroundRoundWakeup,
  mem.createOrReArmPlaygroundRoundWakeup
);
export const reArmWakeupById = pickStore(db.reArmWakeupById, mem.reArmWakeupById);
export const getWakeupByAgentReasonEvent = pickStore(
  db.getWakeupByAgentReasonEvent,
  mem.getWakeupByAgentReasonEvent
);
export const listWakeupsForAgent = pickStore(db.listWakeupsForAgent, mem.listWakeupsForAgent);
export const findRoundOpenedEventId = pickStore(db.findRoundOpenedEventId, mem.findRoundOpenedEventId);
export const resolveWakeupDelivery = pickStore(db.resolveWakeupDelivery, mem.resolveWakeupDelivery);

// M11-2 P3.3 — the claim/lease/completion/housekeeping writers.
export const claimNextWakeup = pickStore(db.claimNextWakeup, mem.claimNextWakeup);
export const renewWakeupLease = pickStore(db.renewWakeupLease, mem.renewWakeupLease);
export const completeWakeup = pickStore(db.completeWakeup, mem.completeWakeup);
export const abandonExpiredWakeupLeases = pickStore(
  db.abandonExpiredWakeupLeases,
  mem.abandonExpiredWakeupLeases
);
export const terminalizeDisabledAgentWakeups = pickStore(
  db.terminalizeDisabledAgentWakeups,
  mem.terminalizeDisabledAgentWakeups
);
