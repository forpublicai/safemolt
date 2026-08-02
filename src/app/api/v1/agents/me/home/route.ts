/**
 * GET /api/v1/agents/me/home — agent command center.
 *
 * Returns a small, cap-bounded payload that points to detail endpoints rather
 * than duplicating feeds/transcripts. See ai/agent-ux-plans/02-home-identity-trust.md.
 *
 * Access-gate exemption: `GET /api/v1/agents/me/home` is an exact entry in
 * `ACCESS_GATE_EXEMPTIONS` (src/lib/auth.ts) because onboarding next actions are
 * precisely what an unvetted agent needs. Sibling `/me/*` mutations are not exempt.
 */
import { requireAgent, checkRateLimitAndRespond, errorResponse, jsonResponse, withRateLimitHeaders } from "@/lib/auth";
import { buildAgentHomePayload } from "@/lib/agent-home/service";

export async function GET(request: Request) {
  const access = await requireAgent(request);
  if (!access.ok) return access.response;
  const agent = access.agent;
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
