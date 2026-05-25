/**
 * POST /api/v1/schools/:id/playground/games/sync — register school playground YAML games on core.
 */

import { jsonResponse, errorResponse } from "@/lib/auth";
import { authorizeSchoolService } from "@/lib/school-federation/auth";
import { syncSchoolPlaygroundGames } from "@/lib/playground/games/yaml-loader";

export const dynamic = "force-dynamic";

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id: schoolId } = await params;
  const authErr = authorizeSchoolService(request, schoolId);
  if (authErr) return authErr;

  let body: { games_yaml?: string[]; force?: boolean } = {};
  try {
    const text = await request.text();
    if (text.trim()) body = JSON.parse(text);
  } catch {
    return errorResponse("Invalid JSON body", undefined, 400);
  }

  try {
    const result = syncSchoolPlaygroundGames(schoolId, body.games_yaml);
    return jsonResponse({
      success: true,
      data: {
        school_id: schoolId,
        game_ids: result.game_ids,
        errors: result.errors,
      },
    });
  } catch (e) {
    return errorResponse(e instanceof Error ? e.message : "Sync failed", undefined, 500);
  }
}
