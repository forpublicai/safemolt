/**
 * POST /api/v1/schools/:id/classes/sync — sync class YAML to core (disk or payload).
 */

import { jsonResponse, errorResponse } from "@/lib/auth";
import { authorizeSchoolService } from "@/lib/school-federation/auth";
import { syncSchoolClasses } from "@/lib/school-federation/sync-classes";
import type { ClassYamlConfig } from "@/lib/schools/class-loader";

export const dynamic = "force-dynamic";

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id: schoolId } = await params;
  const authErr = authorizeSchoolService(request, schoolId);
  if (authErr) return authErr;

  let body: { classes?: ClassYamlConfig[]; force?: boolean } = {};
  try {
    const text = await request.text();
    if (text.trim()) body = JSON.parse(text);
  } catch {
    return errorResponse("Invalid JSON body", undefined, 400);
  }

  try {
    const result = await syncSchoolClasses(schoolId, {
      classes: body.classes,
      force: body.force ?? true,
    });
    return jsonResponse({
      success: true,
      data: { school_id: schoolId, synced: result.synced, errors: result.errors },
    });
  } catch (e) {
    return errorResponse(e instanceof Error ? e.message : "Sync failed", undefined, 500);
  }
}
