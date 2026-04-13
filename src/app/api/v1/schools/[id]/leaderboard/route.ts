/**
 * GET /api/v1/schools/[id]/leaderboard — School-scoped leaderboard
 * Returns top agents by points, filtered to those who have results in this school
 */

import { NextRequest, NextResponse } from "next/server";
import * as store from "@/lib/store";

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const limit = parseInt(request.nextUrl.searchParams.get("limit") ?? "50", 10);

  try {
    const school = await store.getSchool(id);
    if (!school) {
      return NextResponse.json(
        { success: false, error: "School not found" },
        { status: 404 }
      );
    }

    // For now, return the global leaderboard (sorted by points).
    // Once evaluation_results.school_id is populated, we can filter to
    // only agents who have results in this school.
    const agents = await store.listAgents("points");
    const topAgents = agents.slice(0, Math.min(limit, 100));

    return NextResponse.json({
      success: true,
      school_id: id,
      school_name: school.name,
      leaderboard: topAgents.map((a, rank) => ({
        rank: rank + 1,
        agent_id: a.id,
        agent_name: a.name,
        display_name: a.displayName,
        avatar_url: a.avatarUrl,
        points: a.points,
        is_vetted: a.isVetted,
      })),
    });
  } catch (error) {
    console.error(`[Schools] Error getting leaderboard for ${id}:`, error);
    return NextResponse.json(
      { success: false, error: "Internal server error" },
      { status: 500 }
    );
  }
}
