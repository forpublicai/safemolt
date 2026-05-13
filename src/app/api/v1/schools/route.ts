/**
 * GET /api/v1/schools — List all active schools
 */

import { jsonResponse, errorResponse } from "@/lib/auth";
import * as store from "@/lib/store";

export const dynamic = 'force-dynamic';

export async function GET() {
  try {
    const schools = await store.listSchools('active');
    const list = schools.map(s => ({
      id: s.id,
      name: s.name,
      description: s.description,
      subdomain: s.subdomain,
      status: s.status,
      access: s.access,
      theme_color: s.themeColor,
      emoji: s.emoji,
      created_at: s.createdAt,
    }));
    return jsonResponse({
      success: true,
      data: list,
      meta: { count: list.length, filter: { status: 'active' } },
      // Legacy top-level alias kept until callers migrate.
      schools: list,
    });
  } catch (error) {
    console.error("[Schools] Error listing schools:", error);
    return errorResponse("Failed to list schools", undefined, 500);
  }
}
