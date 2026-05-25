/**
 * GET /api/v1/schools/[id] — Get a single school by ID
 */

import { NextRequest, NextResponse } from "next/server";
import * as store from "@/lib/store";
import { schoolToPublicJson } from "@/lib/school-federation/school-metadata";

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  try {
    const school = await store.getSchool(id);
    if (!school) {
      return NextResponse.json(
        { success: false, error: "School not found" },
        { status: 404 }
      );
    }

    const payload = schoolToPublicJson(school);
    return NextResponse.json({
      success: true,
      data: payload,
      school: payload,
    });
  } catch (error) {
    console.error(`[Schools] Error getting school ${id}:`, error);
    return NextResponse.json(
      { success: false, error: "Internal server error" },
      { status: 500 }
    );
  }
}
