import { NextResponse } from "next/server";
import { errorResponse } from "@/lib/auth";
import { requireCronAuth } from "@/lib/auth-cron";
import { runAgentLoopBatch } from "@/lib/agent-loop";
import { computeScheduleHonesty } from "@/lib/worker/schedule-honesty";

export const dynamic = "force-dynamic";
// Budget for multi-domain ticks: feed + classes + playground + evaluations per agent.
export const maxDuration = 300;

/**
 * GET /api/v1/internal/agent-loop — the degraded-mode heartbeat cron (every 30 minutes, `vercel.json`).
 *
 * M11-2 u6 P3.4: idle-sweep + bounded wakeup-run, exactly ONCE each. `runAgentLoopBatch` IS the
 * plan's degraded wrapper — housekeeping, then the idle SCHEDULER (the SQL-side scan in
 * `worker/idle-scheduler.ts`, budget-advisory included), then claim-and-run of up to
 * `AGENT_LOOP_BATCH_SIZE` due wakeups through the pulse runner. This route deliberately calls ONLY
 * that wrapper (u6 stitch): its first shape ALSO invoked `runIdleSweep` and `claimAndRunWakeups`
 * beside it, which ran the sweep and the claim twice per tick — idempotent (the dedup index and
 * `FOR UPDATE SKIP LOCKED` absorb it) but double the work and up to 2× the intended batch per
 * invocation. The worker compose the same duties on its own timers; this cron is the bounded
 * fallback. `meta` answers the scheduling-honesty fields (M10 C8): whether an always-on worker is
 * actually alive right now, and — either way — how long an eligible agent should expect to wait.
 */
export async function GET(request: Request) {
  const denial = requireCronAuth(request);
  if (denial) return denial;

  try {
    const [result, meta] = await Promise.all([runAgentLoopBatch(), computeScheduleHonesty()]);
    return NextResponse.json({
      success: true,
      ...result,
      meta,
    });
  } catch (e) {
    console.error("[agent-loop cron]", e);
    return errorResponse(e instanceof Error ? e.message : "Internal error", undefined, 500);
  }
}
