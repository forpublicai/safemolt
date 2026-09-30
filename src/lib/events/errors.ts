/**
 * M11-2 P2.2 — the one failure a consumer may declare terminal.
 *
 * Transient failures (a provider outage, a timeout) pace out over the backoff schedule so three
 * attempts span real recovery time. A **permanent contract error** — a malformed payload, a
 * reference that cannot ever resolve — will fail identically on every retry, so retrying it only
 * delays the audit row by an hour. Throwing this from `handleEvent` dead-letters the event
 * immediately, on whatever attempt it happens.
 *
 * Consumers must not throw it for anything a retry could fix; that is how effects get discarded.
 */
export class PermanentEffectError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "PermanentEffectError";
  }
}

/**
 * M11-2 P2.1 — "not now, and this is not a failure": the event is somebody else's to run.
 *
 * **Contention is not failure, and recording it as one is actively harmful.** The memory-ingest
 * consumer holds one claim per event so a fan-out has a single owner; a second drain reaching the
 * same event is refused. If that refusal were an ordinary error the drain would open a failures row,
 * count an attempt, pace the next one — and three refusals can elapse comfortably inside one owner's
 * lease, at which point the loser DEAD-LETTERS and receipts an event whose owner is still working.
 * The fan-out is then finalized as failed while it is in fact succeeding, and nothing looks again.
 *
 * Throwing this instead makes the drain skip the event for this pass only: no receipt, no failures
 * row, no attempt. The event stays unreceipted, so the receipt anti-join simply offers it again.
 *
 * Never throw it for anything a retry would not fix on its own — that is what the failures ledger
 * and its backoff are for.
 */
export class RetryLaterError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "RetryLaterError";
  }
}
