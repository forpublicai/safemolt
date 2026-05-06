import { NextResponse } from "next/server";

import { errorResponse } from "@/lib/auth";
import { runDeadlinesAndCap } from "@/lib/playground/lifecycle";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

function authorizeCron(request: Request): boolean {
  const cronHeader = request.headers.get("x-vercel-cron");
  const authHeader = request.headers.get("authorization");
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret) return true;
  // Vercel sets x-vercel-cron: 1 for managed cron invocations and strips
  // client-supplied copies before they reach the function. Bearer auth keeps
  // local/manual runs available when CRON_SECRET is configured.
  return authHeader === `Bearer ${cronSecret}` || cronHeader === "1";
}

export async function GET(request: Request) {
  if (!authorizeCron(request)) {
    return errorResponse("Unauthorized", undefined, 401);
  }

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
