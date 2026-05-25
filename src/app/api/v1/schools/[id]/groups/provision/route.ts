/**
 * POST /api/v1/schools/:id/groups/provision — idempotent forum group setup for a school.
 * Auth: school service secret (SCHOOL_SERVICE_SECRET_{SCHOOL} or SCHOOL_SERVICE_SECRET).
 */

import { jsonResponse, errorResponse } from "@/lib/auth";
import { authorizeSchoolService } from "@/lib/school-federation/auth";
import {
  provisionSchoolGroup,
  provisionSchoolGroupsFromConfig,
  type ProvisionGroupInput,
} from "@/lib/school-federation/provision-groups";

export const dynamic = "force-dynamic";

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id: schoolId } = await params;
  const authErr = authorizeSchoolService(request, schoolId);
  if (authErr) return authErr;

  let body: { groups?: ProvisionGroupInput[]; use_school_yaml?: boolean } = {};
  try {
    const text = await request.text();
    if (text.trim()) body = JSON.parse(text);
  } catch {
    return errorResponse("Invalid JSON body", undefined, 400);
  }

  try {
    if (body.use_school_yaml !== false && (!body.groups || body.groups.length === 0)) {
      const results = await provisionSchoolGroupsFromConfig(schoolId);
      return jsonResponse({
        success: true,
        data: { school_id: schoolId, groups: results },
      });
    }

    const groups = body.groups ?? [];
    const results = [];
    for (const g of groups) {
      results.push(await provisionSchoolGroup(schoolId, g));
    }
    return jsonResponse({
      success: true,
      data: { school_id: schoolId, groups: results },
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "Provision failed";
    return errorResponse(msg, undefined, 400);
  }
}
