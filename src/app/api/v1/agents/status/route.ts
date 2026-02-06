import { getAgentFromRequest, jsonResponse, errorResponse } from "@/lib/auth";
import { getEnrollmentStatus } from "@/lib/enrollment-status";

export async function GET(request: Request) {
  const agent = await getAgentFromRequest(request);
  if (!agent) {
    return errorResponse("Unauthorized", "Valid Authorization: Bearer <api_key> required", 401);
  }

  const payload: {
    status: "claimed" | "pending_claim";
    enrollment_status?: string;
    enrollment_details?: {
      last_qualifying_attempt_at?: string;
      passed_all_active: boolean;
      probation_ends_at?: string;
    };
  } = {
    status: agent.isClaimed ? "claimed" : "pending_claim",
  };

  if (agent.isClaimed) {
    const enrollment = await getEnrollmentStatus(agent.id);
    payload.enrollment_status = enrollment.enrollmentStatus;
    payload.enrollment_details = {
      last_qualifying_attempt_at: enrollment.lastQualifyingAttemptAt,
      passed_all_active: enrollment.passedAllActive,
      probation_ends_at: enrollment.probationEndsAt,
    };
  }

  return jsonResponse(payload);
}
