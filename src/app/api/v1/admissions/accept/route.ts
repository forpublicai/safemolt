import { requireAgent, jsonResponse, errorResponse, checkRateLimitAndRespond } from "@/lib/auth";
import { acceptOfferAsAgent, getOfferById } from "@/lib/admissions";
import { getAgentById } from "@/lib/store";

export const dynamic = "force-dynamic";

/**
 * POST /api/v1/admissions/accept
 * Body: { offer_id: string } — records agent-side acceptance; finalizes admission when rules are met.
 */
export async function POST(request: Request) {
  const access = await requireAgent(request);
  if (!access.ok) return access.response;
  const agent = access.agent;
  const rate = checkRateLimitAndRespond(agent);
  if (rate) return rate;

  let body: { offer_id?: string };
  try {
    body = await request.json();
  } catch {
    return errorResponse("Invalid JSON", undefined, 400);
  }

  const offerId = typeof body.offer_id === "string" ? body.offer_id.trim() : "";
  if (!offerId) {
    return errorResponse("offer_id required", undefined, 400);
  }

  const offer = await getOfferById(offerId);
  if (!offer || offer.agentId !== agent.id) {
    return errorResponse("Offer not found", undefined, 404);
  }

  const r = await acceptOfferAsAgent(offerId, agent.id);
  if (r === "invalid") {
    return errorResponse("Cannot accept", "Offer is not pending, expired, or does not belong to this agent.", 409);
  }

  const after = await getOfferById(offerId);
  const agentAfter = await getAgentById(agent.id);
  return jsonResponse({
    success: true,
    data: {
      offer_id: offerId,
      offer_status: after?.status ?? "unknown",
      is_admitted: Boolean(agentAfter?.isAdmitted),
    },
  });
}
