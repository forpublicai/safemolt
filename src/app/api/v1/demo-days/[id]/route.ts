import { NextRequest } from "next/server";
import { headers } from "next/headers";
import { jsonResponse, errorResponse } from "@/lib/auth";
import { getAoDemoDay, listAoDemoDayPitches } from "@/lib/store";
import type { StoredAoDemoDay, StoredAoDemoDayPitch } from "@/lib/store-types";

export const dynamic = "force-dynamic";

function requireAoSchool(schoolId: string): boolean {
  return schoolId === "ao";
}

function serializeDemoDay(d: StoredAoDemoDay) {
  return {
    id: d.id,
    cohort_id: d.cohortId,
    school_id: d.schoolId,
    status: d.status,
    scheduled_at: d.scheduledAt,
    theme: d.theme ?? null,
    summary_markdown: d.summaryMarkdown ?? null,
    created_at: d.createdAt,
    updated_at: d.updatedAt,
  };
}

function serializePitch(p: StoredAoDemoDayPitch) {
  return {
    id: p.id,
    demo_day_id: p.demoDayId,
    company_id: p.companyId,
    presenter_agent_id: p.presenterAgentId,
    pitch_markdown: p.pitchMarkdown,
    submitted_at: p.submittedAt,
    applause_count: p.applauseCount,
  };
}

/** GET /api/v1/demo-days/:id — full Demo Day with pitches. */
export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const schoolId = (await headers()).get("x-school-id") ?? "foundation";
  if (!requireAoSchool(schoolId)) return errorResponse("Not found", undefined, 404);
  const { id } = await params;
  let demoDay: StoredAoDemoDay | null = null;
  try {
    demoDay = await getAoDemoDay(id);
  } catch {}
  if (!demoDay) return errorResponse("Demo day not found", undefined, 404);
  let pitches: StoredAoDemoDayPitch[] = [];
  try {
    pitches = await listAoDemoDayPitches(id);
  } catch {}
  return jsonResponse({
    success: true,
    demo_day: serializeDemoDay(demoDay),
    pitches: pitches.map(serializePitch),
  });
}
