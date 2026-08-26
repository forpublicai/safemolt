import { runPulseBatch, type PulseBatchResult } from "@/lib/agent-pulse/runner";
import type { ShouldStop } from "@/lib/worker/stop-signal";

/**
 * M11-2 u6 P3.1 worker duty (b): claim and run due wakeups.
 *
 * Lane D's runner (`src/lib/agent-pulse/runner.ts`) landed mid-lane with `runPulseBatch(maxSlots)` —
 * the claim/execute/complete loop this duty needs. This was a documented stub until then; it is now
 * a thin wrapper choosing how many slots one worker pass claims.
 */

const DEFAULT_WAKEUP_PASS_SLOTS = 10;

function wakeupPassSlots(): number {
  const raw = Number(process.env.WORKER_WAKEUP_PASS_SLOTS ?? DEFAULT_WAKEUP_PASS_SLOTS);
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : DEFAULT_WAKEUP_PASS_SLOTS;
}

/**
 * `shouldStop` is the worker's shutdown flag, forwarded to the batch so a `SIGTERM` landing mid-pass
 * stops the pass CLAIMING more slots (E fix round 1, finding 5) rather than only stopping the next
 * pass from starting.
 */
export async function claimAndRunWakeups(shouldStop?: ShouldStop): Promise<PulseBatchResult> {
  return runPulseBatch(wakeupPassSlots(), shouldStop);
}
