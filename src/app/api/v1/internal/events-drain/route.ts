import { NextResponse } from "next/server";

import { errorResponse } from "@/lib/auth";
import { requireCronAuth } from "@/lib/auth-cron";
import { runEventDrainPass } from "@/lib/worker/event-drain-pass";

export const dynamic = "force-dynamic";
// Consumers await store and vector work per event; a bounded batch of them can outrun the default.
export const maxDuration = 300;

/**
 * GET /api/v1/internal/events-drain — the event consumer runtime (five-minute cron).
 *
 * Born fail-closed: `requireCronAuth` refuses when `CRON_SECRET` is unset rather than admitting
 * everyone, because this route drives consumer effects, external vector ingest, and retry and
 * dead-letter processing.
 *
 * M11-2 u6 P3.1/P3.4: the pass itself (`runEventDrainPass`) is shared with the worker's fast loop —
 * this route is now a thin adapter, parsing nothing and rendering the pass's result in its own JSON
 * shape, so a duty added to the pass runs identically under both topologies.
 */
export async function GET(request: Request) {
  const denial = requireCronAuth(request);
  if (denial) return denial;

  try {
    const result = await runEventDrainPass();
    return NextResponse.json({
      success: true,
      contract_hash: result.contractHash,
      consumers: result.consumers,
      hourly_ran: result.hourlyRan,
      hourly: result.hourly,
    });
  } catch (e) {
    console.error("[events-drain cron]", e);
    return errorResponse(e instanceof Error ? e.message : "Internal error", undefined, 500);
  }
}
