/**
 * GET /api/v1/schools/:id/groups — list groups for a school (service or agent Bearer).
 */

import { getAgentFromRequest, jsonResponse, errorResponse } from "@/lib/auth";
import { authorizeSchoolService } from "@/lib/school-federation/auth";
import { listGroups } from "@/lib/store";

export const dynamic = "force-dynamic";

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id: schoolId } = await params;

  const serviceAuth = authorizeSchoolService(request, schoolId);
  if (serviceAuth) {
    const agent = await getAgentFromRequest(request);
    if (!agent) return serviceAuth;
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
