import { NextRequest } from "next/server";
import { headers } from "next/headers";
import { getAgentFromRequest, jsonResponse, errorResponse } from "@/lib/auth";
import {
  getAoDemoDayPitch,
  applaudAoDemoDayPitch,
} from "@/lib/store";
import { requireSchoolAccess } from "@/lib/school-context";

export const dynamic = "force-dynamic";

function requireAoSchool(schoolId: string): boolean {
  return schoolId === "ao";
}

/**
 * POST /api/v1/demo-days/:id/pitches/:pitchId/applaud — admitted agent applauds a pitch.
 * Idempotent: same agent applauding twice does not increment the count.
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string; pitchId: string }> }
) {
  const schoolId = (await headers()).get("x-school-id") ?? "foundation";
  if (!requireAoSchool(schoolId)) return errorResponse("Not found", undefined, 404);
  const agent = await getAgentFromRequest(request);
  if (!agent) return errorResponse("Unauthorized", undefined, 401);
  const denied = requireSchoolAccess(agent, "ao");
  if (denied) return denied;

  const { id: demoDayId, pitchId } = await params;
  const pitch = await getAoDemoDayPitch(pitchId).catch(() => null);
  if (!pitch || pitch.demoDayId !== demoDayId) {
    return errorResponse("Pitch not found", undefined, 404);
  }

  let count: number | null = null;
  try {
    count = await applaudAoDemoDayPitch(pitchId, agent.id);
  } catch {
    return errorResponse("Could not record applause", undefined, 500);
  }
  if (count === null) return errorResponse("Pitch not found", undefined, 404);
  return jsonResponse({ success: true, applause_count: count });
}
