import { createHash } from "crypto";

import { eventConsumers } from "./consumers/registry";
import { EVENT_KINDS } from "./kinds";

/**
 * M11-2 — the consumer-contract hash, the deployment-version barrier's signal.
 *
 * A phased cutover (`legacy → shadow → on → inline deleted`) is only safe if each phase begins
 * after the previous deploy has completed on **both** drain runtimes. "Both are alive" does not
 * establish that: an old worker that is healthy still receipts events under its old effect set,
 * permanently suppressing a newly enabled effect. So the barrier compares **contract identity** —
 * this hash, stamped into `worker_heartbeats` by the drain route each run and by the worker from
 * P3.1 — and never liveness or a shared commit SHA.
 *
 * The inputs are the build's kind union and every registered consumer's coverage manifest. Both are
 * sorted before hashing, so the hash depends on the contract and not on declaration order.
 */

/** One consumer's contribution: its name and its (kind → state) manifest entries. */
export interface ConsumerContractInput {
  name: string;
  /** `[kind, state]` pairs — `legacy | shadow | on | none`. Manifests arrive at u2. */
  coverage: ReadonlyArray<readonly [string, string]>;
}

function canonicalize(kinds: readonly string[], consumers: readonly ConsumerContractInput[]): string {
  return JSON.stringify({
    kinds: [...kinds].sort(),
    consumers: [...consumers]
      .map((consumer) => ({
        name: consumer.name,
        coverage: [...consumer.coverage].map(([kind, state]) => [kind, state]).sort(),
      }))
      .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0)),
  });
}

/**
 * Deterministic sha256 over the sorted union plus the sorted manifests.
 *
 * The inputs are parameters so the barrier's own behavior is testable — a contract hash that could
 * not be shown to CHANGE when the contract changes would prove nothing. They default to the real
 * union and the real registry, which is what the route stamps.
 */
export function computeConsumerContractHash(
  kinds: readonly string[] = EVENT_KINDS,
  consumers: readonly ConsumerContractInput[] = eventConsumers.map((consumer) => ({
    name: consumer.name,
    // The real manifests, from u2 on. This is the whole point of the barrier: a runtime that is
    // alive and healthy can still receipt an event under an old effect set, so the signal has to
    // move when any kind's state moves — not merely when a consumer is added or removed.
    coverage: Object.entries(consumer.coverage),
  }))
): string {
  return createHash("sha256").update(canonicalize(kinds, consumers)).digest("hex");
}
