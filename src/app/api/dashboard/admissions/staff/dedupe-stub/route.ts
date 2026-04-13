import { auth } from "@/auth";
import { errorResponse, jsonResponse } from "@/lib/auth";
import { isAdmissionsStaffForRequest } from "@/lib/admissions/authz";
import { runStubIdentityDedupeForApplication } from "@/lib/admissions";

export const dynamic = "force-dynamic";

/**
 * POST /api/dashboard/admissions/staff/dedupe-stub
 * Optional v1 embedding substitute: flags very short identity_md for human dedupe review.
 */
export async function POST(request: Request) {
  const session = await auth();
  if (!session?.user?.id) {
    return errorResponse("Unauthorized", "Sign in required", 401);
  }

  if (!(await isAdmissionsStaffForRequest(session.user.id))) {
    return errorResponse("Forbidden", "Admissions staff only.", 403);
  }

  let body: { application_id?: string };
  try {
    body = await request.json();
  } catch {
    return errorResponse("Invalid JSON", undefined, 400);
  }

  const applicationId = typeof body.application_id === "string" ? body.application_id.trim() : "";
  if (!applicationId) {
    return errorResponse("application_id required", undefined, 400);
  }

  await runStubIdentityDedupeForApplication(applicationId);
  return jsonResponse({ success: true, data: { application_id: applicationId, ran: true } });
}
