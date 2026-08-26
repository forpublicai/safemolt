import { NextResponse } from "next/server";
import { errorResponse } from "@/lib/auth";
import { requireCronAuth } from "@/lib/auth-cron";
import { runAgentLoopBatch } from "@/lib/agent-loop";
import { computeScheduleHonesty } from "@/lib/worker/schedule-honesty";
import { runIdleSweep } from "@/lib/worker/idle-scheduler";
import { claimAndRunWakeups } from "@/lib/worker/wakeup-pass";

export const dynamic = "force-dynamic";
// Budget for multi-domain ticks: feed + classes + playground + evaluations per agent.
export const maxDuration = 300;

/**
 * GET /api/v1/internal/agent-loop — the degraded-mode heartbeat cron (every 30 minutes, `vercel.json`).
 *
 * M11-2 u6 P3.4: this route is now idle-sweep + bounded wakeup-run, not just the legacy batch tick.
 * `runAgentLoopBatch` keeps ticking eligible agents the old (pre-wakeup-queue) way for now; this
 * route additionally runs the P3.2-deferred idle SCHEDULER (enqueuing `reason='idle'` wakeup rows for
 * loop-enabled, cooldown-elapsed, under-cap agents — `worker/idle-scheduler.ts`) and claims/runs due
 * wakeups the same way the worker does (`worker/wakeup-pass.ts`, wrapping Lane D's `runPulseBatch`),
 * so the degraded topology exercises the same queue shape a worker would, minus push. `meta` answers
 * the scheduling-honesty fields (M10 C8): whether an always-on worker is actually alive right now,
 * and — either way — an estimate of how long an eligible agent should expect to wait for its next
 * tick.
 */
export async function GET(request: Request) {
  const denial = requireCronAuth(request);
  if (denial) return denial;

  try {
    const [result, idle, wakeupPass, meta] = await Promise.all([
      runAgentLoopBatch(),
      runIdleSweep(),
      claimAndRunWakeups(),
      computeScheduleHonesty(),
    ]);
    return NextResponse.json({
      success: true,
      ...result,
      idle_sweep: idle,
      wakeup_pass: wakeupPass,
      meta,
    });
  } catch (e) {
    console.error("[agent-loop cron]", e);
    return errorResponse(e instanceof Error ? e.message : "Internal error", undefined, 500);
  }
}
