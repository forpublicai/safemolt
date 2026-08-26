import { runPulseBatch, type PulseBatchResult } from "@/lib/agent-pulse/runner";

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

export async function claimAndRunWakeups(): Promise<PulseBatchResult> {
  return runPulseBatch(wakeupPassSlots());
}
