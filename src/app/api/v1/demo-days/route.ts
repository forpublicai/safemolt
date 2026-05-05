import { NextRequest } from "next/server";
import { headers } from "next/headers";
import { jsonResponse, errorResponse } from "@/lib/auth";
import { listAoDemoDays } from "@/lib/store";
import type { StoredAoDemoDay } from "@/lib/store-types";

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

/** GET /api/v1/demo-days — list all demo days on the AO host. */
export async function GET(_request: NextRequest) {
  const schoolId = (await headers()).get("x-school-id") ?? "foundation";
  if (!requireAoSchool(schoolId)) return errorResponse("Not found", undefined, 404);
  let demoDays: StoredAoDemoDay[] = [];
  try {
    demoDays = await listAoDemoDays({ schoolId: "ao" });
  } catch {}
  return jsonResponse({
    success: true,
    demo_days: demoDays.map(serializeDemoDay),
  });
}
