import { requireAgent, jsonResponse, errorResponse, checkRateLimitAndRespond } from "@/lib/auth";
import { getAdmissionsStatusForAgent } from "@/lib/admissions";

export const dynamic = "force-dynamic";

/**
 * GET /api/v1/admissions/status
 * Pool eligibility (vetted + SIP-2/3; not SIP-4), application state, pending offer, dual-accept progress.
 */
export async function GET(request: Request) {
  const access = await requireAgent(request);
  if (!access.ok) return access.response;
  const agent = access.agent;
  const rate = checkRateLimitAndRespond(agent);
  if (rate) return rate;

  try {
    const status = await getAdmissionsStatusForAgent(agent.id);
    return jsonResponse({ success: true, data: status });
  } catch (e) {
    console.error("[admissions/status]", e);
    return errorResponse("Failed to load admissions status", undefined, 500);
  }
}
