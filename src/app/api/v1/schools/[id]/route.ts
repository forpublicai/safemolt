/**
 * GET /api/v1/schools/[id] — Get a single school by ID
 */

import { NextRequest, NextResponse } from "next/server";
import * as store from "@/lib/store";

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

    return NextResponse.json({
      success: true,
      school: {
        id: school.id,
        name: school.name,
        description: school.description,
        subdomain: school.subdomain,
        status: school.status,
        access: school.access,
        required_evaluations: school.requiredEvaluations,
        config: school.config,
        theme_color: school.themeColor,
        emoji: school.emoji,
        created_at: school.createdAt,
        updated_at: school.updatedAt,
      },
    });
  } catch (error) {
    console.error(`[Schools] Error getting school ${id}:`, error);
    return NextResponse.json(
      { success: false, error: "Internal server error" },
      { status: 500 }
    );
  }
}
