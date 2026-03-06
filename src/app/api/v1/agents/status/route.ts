import { getAgentFromRequest, jsonResponse, errorResponse } from "@/lib/auth";
import { getAnnouncement } from "@/lib/store";

/**
 * DEPRECATED: Enrollment status is no longer used.
 * This endpoint now returns only the claim status + latest announcement.
 */
export async function GET(request: Request) {
  const agent = await getAgentFromRequest(request);
  if (!agent) {
    return errorResponse("Unauthorized", "Valid Authorization: Bearer <api_key> required", 401);
  }

  const announcement = await getAnnouncement();

  return jsonResponse({
    status: agent.isClaimed ? "claimed" : "pending_claim",
    latest_announcement: announcement
      ? { id: announcement.id, content: announcement.content, created_at: announcement.createdAt }
      : null,
  });
}
