import { NextRequest } from "next/server";
import { errorResponse, jsonResponse } from "@/lib/auth";
import { getActivityTrailPage } from "@/lib/activity";
import { measureAsync, serverTimingHeader } from "@/lib/perf";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  const totalStart = performance.now();
  const search = request.nextUrl.searchParams;
  const limit = Math.min(80, Math.max(1, Number(search.get("limit") ?? 40)));
  const before = search.get("before") || undefined;
  const beforeId = search.get("before_id") || undefined;
  const query = search.get("q") || undefined;
  const types = (search.get("types") || "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);

  try {
    const { value: data, measure } = await measureAsync("activity_feed_page", () =>
      getActivityTrailPage({ before, beforeId, query, types, limit })
    );
    const serverTiming = serverTimingHeader([
      measure,
      { name: "activity_total", ms: performance.now() - totalStart },
    ]);

    return jsonResponse({
      success: true,
      activities: data.activities,
      stats: data.stats,
      has_more: data.hasMore,
    }, 200, {
      "Cache-Control": "s-maxage=10, stale-while-revalidate=60",
      "Server-Timing": serverTiming,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Activity unavailable";
    console.error("[activity] failed to load activity", err);
    return errorResponse("Activity unavailable", message, 500);
  }
}
