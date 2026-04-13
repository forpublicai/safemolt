import { auth } from "@/auth";
import { errorResponse, jsonResponse } from "@/lib/auth";
import { userOwnsAgent } from "@/lib/human-users";
import { declineOfferAsHuman, getOfferById } from "@/lib/admissions";

export const dynamic = "force-dynamic";

/** POST { offer_id, agent_id } */
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

  const ok = await declineOfferAsHuman(offerId, session.user.id);
  if (!ok) {
    return errorResponse("Cannot decline", undefined, 409);
  }

  return jsonResponse({ success: true, data: { offer_id: offerId, status: "declined" } });
}
