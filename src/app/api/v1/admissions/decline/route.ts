import { requireAgent, jsonResponse, errorResponse, checkRateLimitAndRespond } from "@/lib/auth";
import { declineOfferAsAgent, getOfferById } from "@/lib/admissions";

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

  const ok = await declineOfferAsAgent(offerId, agent.id);
  if (!ok) {
    return errorResponse("Cannot decline", "Offer is not pending or does not belong to this agent.", 409);
  }

  return jsonResponse({
    success: true,
    data: { offer_id: offerId, status: "declined", returned_to_pool: true },
  });
}
