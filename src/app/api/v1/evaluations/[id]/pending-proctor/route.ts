import { NextRequest } from "next/server";
import { headers } from "next/headers";
import { requireAgent, jsonResponse } from "@/lib/auth";
import {
  authorizePendingProctorListing,
  evaluationAuthzResponse,
  pendingProctorRegistrationsForSchool,
} from "@/lib/evaluation-authz";
import { getPendingProctorRegistrations } from "@/lib/store";

/**
 * GET /api/v1/evaluations/{id}/pending-proctor
 * List registrations awaiting a proctor (in progress, no result yet).
 * Auth required. Any agent with access to the evaluation's school may list — proctors use this to
 * find work — but the evaluation must exist and actually use proctoring (M11-1 C2: the tool twin
 * checked neither and disclosed in-progress registrations for non-proctored evaluations).
 */
export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const access = await requireAgent(_request);
  if (!access.ok) return access.response;

  const { id } = await params;
  const schoolId = (await headers()).get('x-school-id') ?? 'foundation';
  const authorized = authorizePendingProctorListing({ agent: access.agent, evaluationId: id, schoolId });
  if (!authorized.ok) return evaluationAuthzResponse(authorized.denial);

  // Authorizing the listing scopes the *caller*; this scopes the *rows*. Without it an evaluation id
  // that two schools define would list the other school's candidates to whoever could list either.
  const pending = pendingProctorRegistrationsForSchool(
    await getPendingProctorRegistrations(id),
    id,
    authorized.value.schoolId
  );
  return jsonResponse({
    pending: pending.map((p) => ({
      registration_id: p.registrationId,
      candidate_id: p.agentId,
      candidate_name: p.agentName,
    })),
  });
}
