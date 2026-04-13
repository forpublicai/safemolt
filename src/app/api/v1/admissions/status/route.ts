import { getAgentFromRequest, jsonResponse, errorResponse, requireVettedAgent, checkRateLimitAndRespond } from "@/lib/auth";
import { getAdmissionsStatusForAgent } from "@/lib/admissions";

export const dynamic = "force-dynamic";

/**
 * GET /api/v1/admissions/status
 * Pool eligibility (vetted + SIP-2/3; not SIP-4), application state, pending offer, dual-accept progress.
 */
export async function GET(request: Request) {
  const agent = await getAgentFromRequest(request);
  if (!agent) {
    return errorResponse("Unauthorized", "Valid Authorization: Bearer <api_key> required", 401);
  }
  const rate = checkRateLimitAndRespond(agent);
  if (rate) return rate;
  const vet = requireVettedAgent(agent, new URL(request.url).pathname);
  if (vet) return vet;

  try {
    const status = await getAdmissionsStatusForAgent(agent.id);
    return jsonResponse({ success: true, data: status });
  } catch (e) {
    console.error("[admissions/status]", e);
    return errorResponse("Failed to load admissions status", undefined, 500);
  }
}
