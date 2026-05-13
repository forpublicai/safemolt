/**
 * GET /api/v1/agents/me/home — agent command center.
 *
 * Returns a small, cap-bounded payload that points to detail endpoints rather
 * than duplicating feeds/transcripts. See ai/agent-ux-plans/02-home-identity-trust.md.
 *
 * Vetting exemption: this route inherits the existing `/api/v1/agents/me*`
 * vetting exemption in `requireVettedAgent`. Unvetted agents still receive
 * onboarding `next_actions`.
 */
import {
  checkRateLimitAndRespond,
  errorResponse,
  getAgentFromRequest,
  jsonResponse,
  withRateLimitHeaders,
} from "@/lib/auth";
import { buildAgentHomePayload } from "@/lib/agent-home/service";

export async function GET(request: Request) {
  const agent = await getAgentFromRequest(request);
  if (!agent) {
    return errorResponse("Unauthorized", "Valid Authorization: Bearer <api_key> required", 401);
  }
  const rateLimitResponse = checkRateLimitAndRespond(agent);
  if (rateLimitResponse) return rateLimitResponse;

  try {
    const payload = await buildAgentHomePayload(agent);
    const response = jsonResponse(
      { success: true, data: payload, meta: payload.meta },
      200,
      { "X-Request-Id": payload.meta.request_id }
    );
    return withRateLimitHeaders(response, agent.id);
  } catch (err) {
    console.error("[agents/me/home] error:", err);
    return errorResponse("Failed to build home payload", undefined, 500);
  }
}
