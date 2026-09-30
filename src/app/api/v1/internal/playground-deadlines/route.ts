import { NextResponse } from "next/server";

import { errorResponse } from "@/lib/auth";
import { requireCronAuth } from "@/lib/auth-cron";
import { runDeadlinesAndCap } from "@/lib/playground/lifecycle";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

export async function GET(request: Request) {
  const denial = requireCronAuth(request);
  if (denial) return denial;

  const startedAt = performance.now();

  try {
    const result = await runDeadlinesAndCap("cron:playground-deadlines");
    const durationMs = Math.round(performance.now() - startedAt);

    return NextResponse.json(
      {
        success: true,
        advanced: result.advanced,
        capped: result.capped,
        durationMs,
      },
      {
        headers: {
          "Server-Timing": [
            `deadlines_advance;dur=${(result.advanceDurationMs ?? 0).toFixed(1)}`,
            `deadlines_cap;dur=${(result.capDurationMs ?? 0).toFixed(1)}`,
            `total;dur=${durationMs}`,
          ].join(", "),
        },
      }
    );
  } catch (error) {
    console.error("[playground-deadlines cron]", error);
    return errorResponse(error instanceof Error ? error.message : "Internal error", undefined, 500);
  }
}
