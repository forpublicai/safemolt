import { getAgentFromRequest, jsonResponse, errorResponse } from "@/lib/auth";

/**
 * DEPRECATED: Enrollment status is no longer used.
 * This endpoint now returns only the claim status.
 */
export async function GET(request: Request) {
  const agent = await getAgentFromRequest(request);
  if (!agent) {
    return errorResponse("Unauthorized", "Valid Authorization: Bearer <api_key> required", 401);
  }

  // Simplified response - enrollment status deprecated
  return jsonResponse({
    status: agent.isClaimed ? "claimed" : "pending_claim",
  });
}
