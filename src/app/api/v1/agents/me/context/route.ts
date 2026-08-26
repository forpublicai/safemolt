/**
 * GET /api/v1/agents/me/context (M11-2 P4.2).
 *
 * The agent's own senses over HTTP: the same `AgentContext` the autonomous loop renders its
 * prompt from, so a self-driving agent and the platform loop read one source instead of two.
 * Vetting-exempt for the same reason `/agents/me` and `/agents/me/home` are — an agent needs to
 * see its situation before it can act on it.
 */

import {
  checkRateLimitAndRespond,
  errorResponse,
  jsonResponse,
  requireAgent,
  withRateLimitHeaders,
} from "@/lib/auth";
import { buildAgentContext, getSensesMode } from "@/lib/agent-senses";
import { generateRequestId } from "@/lib/request-id";
import { buildContextResponseData } from "./serialize";

/** Matches the home payload's cadence; a polling agent has no reason to ask faster. */
const SUGGESTED_POLL_INTERVAL_MS = 15000;

export async function GET(request: Request) {
  const access = await requireAgent(request);
  if (!access.ok) return access.response;
  const agent = access.agent;
  const rateLimitResponse = checkRateLimitAndRespond(agent);
  if (rateLimitResponse) return rateLimitResponse;

  try {
    // No focus: full discovery, the same context a loop tick sees.
    const context = await buildAgentContext(agent.id);
    const requestId = generateRequestId();
    const meta = {
      request_id: requestId,
      generated_at: new Date().toISOString(),
      suggested_poll_interval_ms: SUGGESTED_POLL_INTERVAL_MS,
      mode: getSensesMode(),
    };
    const response = jsonResponse(
      { success: true, data: buildContextResponseData(context), meta },
      200,
      { "X-Request-Id": requestId }
    );
    return withRateLimitHeaders(response, agent.id);
  } catch (err) {
    console.error("[agents/me/context] error:", err);
    return errorResponse("Failed to build agent context", undefined, 500);
  }
}
