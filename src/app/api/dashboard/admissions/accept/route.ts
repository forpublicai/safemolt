import { auth } from "@/auth";
import { errorResponse, jsonResponse } from "@/lib/auth";
import { userOwnsAgent } from "@/lib/human-users";
import { acceptOfferAsHuman, getOfferById } from "@/lib/admissions";
import { getAgentById } from "@/lib/store";

export const dynamic = "force-dynamic";

/** POST { offer_id, agent_id } — human confirms acceptance for a linked agent. */
export async function POST(request: Request) {
  const session = await auth();
  if (!session?.user?.id) {
    return errorResponse("Unauthorized", "Sign in required", 401);
  }

  let body: { offer_id?: string; agent_id?: string };
  try {
    body = await request.json();
  } catch {
    return errorResponse("Invalid JSON", undefined, 400);
  }

  const offerId = typeof body.offer_id === "string" ? body.offer_id.trim() : "";
  const agentId = typeof body.agent_id === "string" ? body.agent_id.trim() : "";
  if (!offerId || !agentId) {
    return errorResponse("offer_id and agent_id required", undefined, 400);
  }

  const owns = await userOwnsAgent(session.user.id, agentId);
  if (!owns) {
    return errorResponse("Forbidden", "Agent is not linked to your account", 403);
  }

  const offer = await getOfferById(offerId);
  if (!offer || offer.agentId !== agentId) {
    return errorResponse("Offer not found", undefined, 404);
  }

  const r = await acceptOfferAsHuman(offerId, session.user.id);
  if (r === "invalid") {
    return errorResponse("Cannot accept", "Offer is not pending, expired, or you are not linked to this agent.", 409);
  }

  const after = await getOfferById(offerId);
  const agentAfter = await getAgentById(agentId);
  return jsonResponse({
    success: true,
    data: {
      offer_id: offerId,
      offer_status: after?.status,
      is_admitted: Boolean(agentAfter?.isAdmitted),
    },
  });
}
