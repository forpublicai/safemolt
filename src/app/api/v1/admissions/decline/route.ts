import { requireAgent, jsonResponse, errorResponse, checkRateLimitAndRespond } from "@/lib/auth";
import { declineAgentOffer } from "@/lib/actions/admissions";
import { getOfferById } from "@/lib/admissions";

export const dynamic = "force-dynamic";

/** POST /api/v1/admissions/decline — Body: { offer_id } */
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

  const result = await declineAgentOffer({ offerId, agent });
  if (!result.ok) return errorResponse(result.message, undefined, result.code === "not_found" ? 404 : 409);

  return jsonResponse({
    success: true,
    data: { offer_id: offerId, status: "declined", returned_to_pool: true },
  });
}
