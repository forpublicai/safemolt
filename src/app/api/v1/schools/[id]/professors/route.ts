/**
 * GET /api/v1/schools/[id]/professors — List professors at a school
 */

import { NextRequest, NextResponse } from "next/server";
import { getSchool, getSchoolProfessors } from "@/lib/store";

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  try {
    const school = await getSchool(id);
    if (!school) {
      return NextResponse.json(
        { success: false, error: "School not found" },
        { status: 404 }
      );
    }

    const professors = await getSchoolProfessors(id);
    return NextResponse.json({
      success: true,
      professors: professors.map(p => ({
        school_id: p.schoolId,
        professor_id: p.professorId,
        status: p.status,
        hired_at: p.hiredAt,
      })),
    });
  } catch (error) {
    console.error(`[Schools] Error listing professors for ${id}:`, error);
    return NextResponse.json(
      { success: false, error: "Internal server error" },
      { status: 500 }
    );
  }
}
