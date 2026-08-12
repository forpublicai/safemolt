import type { RegisteredConsumer } from "@/lib/events/consumers/dispatch";
import type { StoredEvent } from "@/lib/store-types";

/**
 * M11-2 Decision 6 — the in-process consumer dispatcher for memory mode.
 *
 * There is no worker and no cron in the no-DB path (the pinned Jest and local-development
 * topology), so nothing would ever drain the event log. Effects come from here instead: the
 * mutation and the event append complete atomically first — Decision 4's no-`await` discipline, and
 * the append itself is a plain array push — and the append path then runs the registered consumers
 * for that event.
 *
 * Three rules, and each closes a different hole:
 *
 *  - **It never throws.** A consumer failure is logged and swallowed, and the store call's result
 *    is unchanged. That mirrors db mode, where a consumer failure can never fail its producer; the
 *    opposite would make a local no-DB comment 500 because a projection was unhappy.
 *  - **Notifications and the activity trail are AWAITED**; memory ingest is scheduled on a
 *    non-throwing background path. The first two must be visible when the emitting store call
 *    resolves (what today's inline writes provide, and what the M8 memory-store invariant requires
 *    of Jest); ingest is deliberately fire-and-forget today, and awaiting up to 2,000 sequential
 *    external vector calls inline would turn a local post into a minutes-long request.
 *  - **Dispatch is exactly-once-per-append by construction.** There are no receipts here because
 *    there is nothing to retry: one append, one dispatch, no second driver.
 *
 * The registry is resolved LAZILY and is injectable. Lazily because the consumers import
 * `@/lib/store`, which re-exports this module's neighbours — a static import would make the store
 * facade's own load order decide whether the events domain finished initializing, which is a
 * landmine rather than a dependency. Injectable because a test needs to observe a manifest state no
 * checked-in manifest carries yet (every a1 kind is `legacy` in u2, so the real registry writes
 * nothing at all).
 */

type ConsumerList = readonly RegisteredConsumer[];

let injected: ConsumerList | null = null;
let cached: ConsumerList | null = null;

/**
 * Replace the consumer list this dispatcher runs, or restore the real registry with `null`.
 *
 * Tests only. Production has exactly one registry and no reason to swap it.
 */
export function __setMemoryEventConsumersForTests(consumers: ConsumerList | null): void {
  injected = consumers;
}

function activeConsumers(): ConsumerList {
  if (injected) return injected;
  if (!cached) {
    // Resolved on first dispatch, never at module load. See the header: the consumers reach back
    // into `@/lib/store`, and by the time any event is appended every module involved has finished
    // loading. A relative path so the resolution does not depend on a path alias being configured
    // identically in Jest, Next and tsc.
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const registry = require("../../events/consumers/registry") as { eventConsumers: RegisteredConsumer[] };
    cached = registry.eventConsumers;
  }
  return cached;
}

function logConsumerFailure(consumer: string, event: StoredEvent, error: unknown): void {
  console.error(
    `[events-memory-dispatch] consumer=${consumer} event=${event.id} kind=${event.kind} failed`,
    error
  );
}

/**
 * Run every registered consumer for one appended event.
 *
 * Resolves once the awaited consumers have finished. Never rejects.
 */
export async function dispatchAppendedEvent(event: StoredEvent): Promise<void> {
  let consumers: ConsumerList;
  try {
    consumers = activeConsumers();
  } catch (error) {
    // A registry that cannot even be loaded is still not the producer's problem.
    logConsumerFailure("<registry>", event, error);
    return;
  }

  for (const consumer of consumers) {
    if (consumer.memoryModeDelivery === "background") {
      // A floating promise with a catch — the memory-mode equivalent of the routes' `waitUntil`.
      // `next/server` is deliberately not imported here: this module runs in Jest and in local
      // development, neither of which has a request lifetime to attach work to.
      //
      // `Promise.resolve().then(...)` rather than calling `handleEvent` directly, because a
      // consumer that throws SYNCHRONOUSLY — before returning its promise — would escape a bare
      // `.catch` and propagate out of the dispatcher, breaking the never-throws contract in exactly
      // the case the contract exists for. Wrapping moves the call inside the promise chain.
      void Promise.resolve()
        .then(() => consumer.handleEvent(event))
        .catch((error) => logConsumerFailure(consumer.name, event, error));
      continue;
    }
    try {
      await consumer.handleEvent(event);
    } catch (error) {
      logConsumerFailure(consumer.name, event, error);
    }
  }
}
