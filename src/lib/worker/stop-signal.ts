/**
 * The ONE "stop claiming" signal type (M11-2 u6 E fix round 1, findings 1 and 5).
 *
 * Two different facts make a long-running duty stop taking on NEW work, and they are the same fact
 * as far as the duty is concerned:
 *
 *   - the singleton `worker_locks` claim was lost mid-sweep (a renewal returned zero rows, so a
 *     contender already owns the row — `playground/lifecycle.ts`), and
 *   - the process received `SIGTERM` and is draining (`worker/index.ts`).
 *
 * `ai/PLAN_M11_2.md` P3.1 states both in the same voice — "a holder that loses its lock claims no
 * further sessions" and "on SIGTERM stop claiming and drain in-flight" — so the duties they reach
 * take ONE predicate rather than two flags with two meanings. It is deliberately synchronous and
 * cheap: a claim point reads a plain boolean, never a network round trip, which is what lets it be
 * checked before EVERY claim rather than once per phase.
 *
 * Semantics, everywhere this is threaded: `true` means "start nothing new". Work already claimed
 * finishes its current statement — nothing is cancelled, nothing is rolled back, and the caller
 * returns whatever it completed. Every sweep this reaches is resumable from its own due-state
 * predicate on the next pass, so stopping early is a delay and never a loss.
 */
export type ShouldStop = () => boolean;

/**
 * Compose several stop signals into one. `undefined` entries are ignored, and with none supplied the
 * result is a constant `false` — so a caller that has no signal to give passes nothing and every
 * check below it is a cheap no-op.
 */
export function anyStopSignal(...signals: (ShouldStop | undefined)[]): ShouldStop {
  const present = signals.filter((signal): signal is ShouldStop => typeof signal === "function");
  if (present.length === 0) return () => false;
  if (present.length === 1) return present[0];
  return () => present.some((signal) => signal());
}
