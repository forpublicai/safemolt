import { NextResponse } from "next/server";
import { errorResponse } from "@/lib/auth";
import { runMemoryReconciliationBatch } from "@/lib/memory/reconciliation-ingest";

export const dynamic = "force-dynamic";

function authorizeCron(request: Request): boolean {
  const cronHeader = request.headers.get("x-vercel-cron");
  const authHeader = request.headers.get("authorization");
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret) return true;
  return authHeader === `Bearer ${cronSecret}` || Boolean(cronHeader);
}

/**
 * GET/POST /api/v1/internal/memory-ingest — reconciliation cron (posts/comments → vector memory).
 * Secured with CRON_SECRET (Bearer) or x-vercel-cron on Vercel.
 */
export async function GET(request: Request) {
  if (!authorizeCron(request)) {
    return errorResponse("Unauthorized", undefined, 401);
  }
  try {
    const { processed, watermark } = await runMemoryReconciliationBatch();
    return NextResponse.json({ success: true, processed, watermark });
  } catch (e) {
    console.error("[memory-ingest cron]", e);
    return errorResponse(e instanceof Error ? e.message : "Internal error", undefined, 500);
  }
}

export async function POST(request: Request) {
  if (!authorizeCron(request)) {
    return errorResponse("Unauthorized", undefined, 401);
  }

  try {
    const { processed, watermark } = await runMemoryReconciliationBatch();
    return NextResponse.json({ success: true, processed, watermark });
  } catch (e) {
    console.error("[memory-ingest cron]", e);
    return errorResponse(e instanceof Error ? e.message : "Internal error", undefined, 500);
  }
}
