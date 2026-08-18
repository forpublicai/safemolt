import { requireAgent, jsonResponse, errorResponse, checkRateLimitAndRespond } from "@/lib/auth";
import { acceptAgentOffer } from "@/lib/actions/admissions";
import { getOfferById } from "@/lib/admissions";
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

  // No pre-read to decide a refusal (M11-2 M8): the action resolves the offer, owns
  // not_found/ownership, and reports the reason this adapter renders to the legacy wire shape (M9).
  const result = await acceptAgentOffer({ offerId, agent });
  if (!result.ok) {
    if (result.reason === "cannot_accept") {
      return errorResponse("Cannot accept", "Offer is not pending, expired, or does not belong to this agent.", 409);
    }
    return errorResponse(result.message, undefined, result.code === "not_found" ? 404 : 409);
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
