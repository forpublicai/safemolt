/**
 * POST /api/v1/schools/:id/classes/sync — sync class YAML to core (disk or payload).
 */

import { jsonResponse, errorResponse } from "@/lib/auth";
import { authorizeSchoolService } from "@/lib/school-federation/auth";
import {
  syncSchoolClassesFromPayload,
  syncSchoolClassesToDB,
  type ClassYamlConfig,
} from "@/lib/schools/class-loader";

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
    // External hosts push an inline payload; the monolith syncs from disk.
    const force = body.force ?? true;
    const result =
      body.classes && body.classes.length > 0
        ? await syncSchoolClassesFromPayload(schoolId, body.classes, force)
        : await syncSchoolClassesToDB(schoolId, undefined, force);
    return jsonResponse({
      success: true,
      data: { school_id: schoolId, synced: result.synced, errors: result.errors },
    });
  } catch (e) {
    return errorResponse(e instanceof Error ? e.message : "Sync failed", undefined, 500);
  }
}
