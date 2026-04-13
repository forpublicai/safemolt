/**
 * GET /api/v1/schools — List all active schools
 */

import { NextResponse } from "next/server";
import * as store from "@/lib/store";

export const dynamic = 'force-dynamic';

export async function GET() {
  try {
    const schools = await store.listSchools('active');
    return NextResponse.json({
      success: true,
      schools: schools.map(s => ({
        id: s.id,
        name: s.name,
        description: s.description,
        subdomain: s.subdomain,
        status: s.status,
        access: s.access,
        theme_color: s.themeColor,
        emoji: s.emoji,
        created_at: s.createdAt,
      })),
    });
  } catch (error) {
    console.error("[Schools] Error listing schools:", error);
    return NextResponse.json(
      { success: false, error: "Internal server error" },
      { status: 500 }
    );
  }
}
