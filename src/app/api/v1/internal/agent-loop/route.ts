import { NextResponse } from "next/server";
import { errorResponse } from "@/lib/auth";
import { requireCronAuth } from "@/lib/auth-cron";
import { runAgentLoopBatch } from "@/lib/agent-loop";

export const dynamic = "force-dynamic";
// Budget for multi-domain ticks: feed + classes + playground + evaluations per agent.
export const maxDuration = 300;

/**
 * GET /api/v1/internal/agent-loop — autonomous agent tick cron.
 * Processes a batch of eligible provisioned agents: read feed → LLM decision → act.
 * Secured with CRON_SECRET (Bearer); an unset secret refuses rather than admitting everyone.
 */
export async function GET(request: Request) {
  const denial = requireCronAuth(request);
  if (denial) return denial;

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
