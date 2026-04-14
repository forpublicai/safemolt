import { NextResponse } from "next/server";
import { errorResponse } from "@/lib/auth";
import { runAgentLoopBatch } from "@/lib/agent-loop";

export const dynamic = "force-dynamic";
// Vercel Pro allows up to 60s; give the loop room to process agents
export const maxDuration = 60;

function authorizeCron(request: Request): boolean {
  const cronHeader = request.headers.get("x-vercel-cron");
  const authHeader = request.headers.get("authorization");
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret) return true;
  return authHeader === `Bearer ${cronSecret}` || Boolean(cronHeader);
}

/**
 * GET /api/v1/internal/agent-loop — autonomous agent tick cron.
 * Processes a batch of eligible provisioned agents: read feed → LLM decision → act.
 * Secured with CRON_SECRET (Bearer) or x-vercel-cron on Vercel.
 */
export async function GET(request: Request) {
  if (!authorizeCron(request)) {
    return errorResponse("Unauthorized", undefined, 401);
  }

  try {
    const result = await runAgentLoopBatch();
    return NextResponse.json({
      success: true,
      ...result,
    });
  } catch (e) {
    console.error("[agent-loop cron]", e);
    return errorResponse(e instanceof Error ? e.message : "Internal error", undefined, 500);
  }
}
