import { activityTrailConsumer } from "./activity-trail";
import type { RegisteredConsumer } from "./dispatch";
import { memoryIngestConsumer } from "./memory-ingest";
import { notificationsConsumer } from "./notifications";
import { wakeupRouterConsumer } from "./wakeup-router";

/**
 * M11-2 — every consumer the drain runtime drives.
 *
 * Adding an entry is what activates a consumer: the drain route activates each registered consumer
 * (a fenced, idempotent one-statement operation) before draining it, so a new consumer starts from
 * the first event after its own fence and never replays history.
 *
 * **Order matters only in memory mode, where the dispatcher runs them in sequence** and the two
 * awaited consumers must both have written before the emitting store call resolves. In db mode the
 * drain route runs them concurrently — separate cursors, separate receipts, separate effects, and
 * no consumer may assume another has run.
 *
 * The list is typed `RegisteredConsumer[]`, which is an `EventConsumerDescriptor[]` everywhere the
 * drain machinery takes one; the two extra fields (`coverage`, `memoryModeDelivery`) are read by
 * the contract hash and the in-process dispatcher, neither of which the drain knows about.
 */
export const eventConsumers: RegisteredConsumer[] = [
  notificationsConsumer,
  activityTrailConsumer,
  memoryIngestConsumer,
  // M11-2 P3.2 (train a4, lane C). Appended: nothing about a wakeup needs to be decided before a
  // projection is written, and in db mode the four run concurrently anyway.
  wakeupRouterConsumer,
];
