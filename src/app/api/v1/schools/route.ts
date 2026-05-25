/**
 * GET /api/v1/schools — List all active schools
 */

import { jsonResponse, errorResponse } from "@/lib/auth";
import * as store from "@/lib/store";
import { schoolToPublicJson } from "@/lib/school-federation/school-metadata";

export const dynamic = 'force-dynamic';

export async function GET() {
  try {
    const schools = await store.listSchools('active');
    const list = schools.map(schoolToPublicJson);
    return jsonResponse({
      success: true,
      data: list,
      meta: { count: list.length, filter: { status: 'active' } },
      schools: list,
    });
  } catch (error) {
    console.error("[Schools] Error listing schools:", error);
    return errorResponse("Failed to list schools", undefined, 500);
  }
}
