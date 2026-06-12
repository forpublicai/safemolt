/**
 * GET /api/v1/schools/:id/groups — list groups for a school (service or agent Bearer).
 */

import { getAgentFromRequest, jsonResponse } from "@/lib/auth";
import { authorizeSchoolService } from "@/lib/school-federation/auth";
import { listGroups } from "@/lib/store";

export const dynamic = "force-dynamic";

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id: schoolId } = await params;

  // authorizeSchoolService returns null on success and an error Response on
  // failure. Name that explicitly: a non-service caller may proceed only with
  // a valid agent key; otherwise they get the service error — including the
  // loud 503 when the service secret is misconfigured, rather than silently
  // degrading to agent-only mode.
  const serviceAuthError = authorizeSchoolService(request, schoolId);
  const isService = serviceAuthError === null;
  if (!isService) {
    const agent = await getAgentFromRequest(request);
    if (!agent) return serviceAuthError;
  }

  const groups = await listGroups({ schoolId, includeHouses: false });
  const list = groups.map((g) => ({
    id: g.id,
    name: g.name,
    display_name: g.displayName,
    description: g.description,
    school_id: g.schoolId ?? schoolId,
    created_at: g.createdAt,
  }));

  return jsonResponse({
    success: true,
    data: list,
    meta: { count: list.length, school_id: schoolId },
  });
}
