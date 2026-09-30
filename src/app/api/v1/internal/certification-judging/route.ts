import { NextResponse } from "next/server";

import { errorResponse } from "@/lib/auth";
import { requireCronAuth } from "@/lib/auth-cron";
import { reclaimExpiredCertificationJobs, listStaleSubmittedCertificationJobs } from "@/lib/store";
import { judgeCertificationJob } from "@/lib/evaluations/judge";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

/** How long a submitted job may sit unclaimed before its inline dispatch is presumed dead. */
const STALE_SUBMITTED_MS = 5 * 60 * 1000;
const DISPATCH_BATCH = 20;

/**
 * M11-1 C22 — reclaim-and-dispatch for certification judging.
 *
 * Judging is normally dispatched exactly once, inline, when the transcript arrives. Two shapes
 * strand a job forever behind the live-job unique index, converting a billing guard into an
 * availability bug:
 *   - a claimant that crashed mid-judging: the lease lapses with the job stuck in `judging`;
 *   - an inline dispatch that never ran (the process died after commit): the job sits in
 *     `submitted` with no claim ever taken.
 * This entry point returns lapsed claims to `submitted` (clearing the token, which invalidates
 * the stalled claimant's fence) and dispatches both sets. Each dispatch re-contends on the CAS
 * lease, so two overlapping cron firings still invoke the paid model at most once per job.
 */
export async function GET(request: Request) {
  const denial = requireCronAuth(request);
  if (denial) return denial;

  const startedAt = performance.now();

  try {
    const reclaimed = await reclaimExpiredCertificationJobs(DISPATCH_BATCH);
    const stale = await listStaleSubmittedCertificationJobs(STALE_SUBMITTED_MS, DISPATCH_BATCH);

    const jobIds = Array.from(new Set([...reclaimed, ...stale].map((job) => job.id)));
    let judged = 0;
    const failures: string[] = [];
    for (const jobId of jobIds) {
      try {
        const verdict = await judgeCertificationJob(jobId);
        if (verdict) judged += 1;
      } catch (error) {
        // One broken job must not strand the rest of the batch; it stays fenced/failed and is
        // reported rather than retried in a loop.
        failures.push(jobId);
        console.error(`[certification-judging cron] job ${jobId}:`, error);
      }
    }

    return NextResponse.json({
      success: true,
      reclaimed: reclaimed.length,
      stale_submitted: stale.length,
      judged,
      failed: failures.length,
      duration_ms: Math.round(performance.now() - startedAt),
    });
  } catch (error) {
    console.error("[certification-judging cron]", error);
    return errorResponse(error instanceof Error ? error.message : "Internal error", undefined, 500);
  }
}
