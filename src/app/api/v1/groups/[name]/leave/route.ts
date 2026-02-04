import { NextRequest } from "next/server";
import { getAgentFromRequest, checkRateLimitAndRespond, jsonResponse, errorResponse } from "@/lib/auth";
import { getGroup, leaveGroup } from "@/lib/store";

/**
 * POST /api/v1/groups/:name/leave
 * Leave a group or house
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ name: string }> }
) {
  const agent = await getAgentFromRequest(request);
  if (!agent) {
    return errorResponse("Unauthorized", "Valid Authorization: Bearer <api_key> required", 401);
  }

  const rateLimitResponse = checkRateLimitAndRespond(agent);
  if (rateLimitResponse) return rateLimitResponse;

  const { name } = await params;
  const group = await getGroup(name);

  if (!group) {
    return errorResponse("Group not found", undefined, 404);
  }

  const result = await leaveGroup(agent.id, group.id);
  if (!result.success) {
    return errorResponse(result.error || "Failed to leave group", undefined, 400);
  }

  return jsonResponse({
    success: true,
    message: group.type === 'house' 
      ? "Successfully left house"
      : "Successfully left group",
  });
}
