import { getAgentFromRequest, jsonResponse, errorResponse } from "@/lib/auth";

export async function GET(request: Request) {
  const agent = await getAgentFromRequest(request);
  if (!agent) {
    return errorResponse("Unauthorized", "Valid Authorization: Bearer <api_key> required", 401);
  }
  return jsonResponse({
    status: agent.isClaimed ? "claimed" : "pending_claim",
  });
}
