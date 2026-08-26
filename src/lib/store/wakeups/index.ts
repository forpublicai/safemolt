import { pickStore } from "../pick-store";
import * as db from "./db";
import * as mem from "./memory";

/**
 * M11-2 P3.2 (train a4, lane C) — the wakeup queue's store facade.
 *
 * Two callers of this lane write through it and neither is in this file: the wakeup-router consumer
 * and the playground deadline sweep. Nothing here claims, leases or completes a wakeup — that is
 * P3.3, explicitly deferred — so no such function is exported, deliberately.
 */

export type {
  CreateOrReArmWakeupInput,
  CreateOrReArmWakeupResult,
  EnqueueWakeupInput,
  EnqueueWakeupResult,
  StoredWakeup,
  WakeupDelivery,
} from "./db";

export const enqueueWakeup = pickStore(db.enqueueWakeup, mem.enqueueWakeup);
export const createOrReArmWakeup = pickStore(db.createOrReArmWakeup, mem.createOrReArmWakeup);
export const reArmWakeupById = pickStore(db.reArmWakeupById, mem.reArmWakeupById);
export const getWakeupByAgentReasonEvent = pickStore(
  db.getWakeupByAgentReasonEvent,
  mem.getWakeupByAgentReasonEvent
);
export const listWakeupsForAgent = pickStore(db.listWakeupsForAgent, mem.listWakeupsForAgent);
export const findRoundOpenedEventId = pickStore(db.findRoundOpenedEventId, mem.findRoundOpenedEventId);
export const resolveWakeupDelivery = pickStore(db.resolveWakeupDelivery, mem.resolveWakeupDelivery);
