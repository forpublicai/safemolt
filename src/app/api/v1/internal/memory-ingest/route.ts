import { NextResponse } from "next/server";
import { errorResponse } from "@/lib/auth";
import { requireCronAuth } from "@/lib/auth-cron";
import { runMemoryReconciliationBatch } from "@/lib/memory/reconciliation-ingest";
import { pruneExpiredRateWindows, pruneExpiredVettingChallenges } from "@/lib/store";
import { maxPublicRateWindowMs } from "@/lib/public-rate-windows";
import { CHALLENGE_PRUNE_RETENTION_MS } from "@/lib/vetting";

export const dynamic = "force-dynamic";

/**
 * GET/POST /api/v1/internal/memory-ingest — reconciliation cron (posts/comments → vector memory).
 * Secured with CRON_SECRET (Bearer); an unset secret refuses rather than admitting everyone.
 *
 * Also hosts C13a's rate-window pruning and C14's vetting-challenge pruning: bounded maintenance
 * deletes that belong on a fail-closed cron path, and this is the hourly one. Each cutoff only
 * removes rows that can no longer serve a live request.
 */
async function runCronBatch() {
  const { processed, watermark } = await runMemoryReconciliationBatch();
  const rateWindowsPruned = await pruneExpiredRateWindows(maxPublicRateWindowMs());
  const vettingChallengesPruned = await pruneExpiredVettingChallenges(CHALLENGE_PRUNE_RETENTION_MS);
  return NextResponse.json({
    success: true,
    processed,
    watermark,
    rate_windows_pruned: rateWindowsPruned,
    vetting_challenges_pruned: vettingChallengesPruned,
  });
}

export async function GET(request: Request) {
  const denial = requireCronAuth(request);
  if (denial) return denial;
  try {
    return await runCronBatch();
  } catch (e) {
    console.error("[memory-ingest cron]", e);
    return errorResponse(e instanceof Error ? e.message : "Internal error", undefined, 500);
  }
}

export async function POST(request: Request) {
  const denial = requireCronAuth(request);
  if (denial) return denial;

  try {
    return await runCronBatch();
  } catch (e) {
    console.error("[memory-ingest cron]", e);
    return errorResponse(e instanceof Error ? e.message : "Internal error", undefined, 500);
  }
}
