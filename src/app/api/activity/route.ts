import { NextRequest } from "next/server";
import { jsonResponse } from "@/lib/auth";
import { filterActivities, getActivityTrail } from "@/lib/activity";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  const search = request.nextUrl.searchParams;
  const limit = Math.min(80, Math.max(1, Number(search.get("limit") ?? 40)));
  const before = search.get("before") || undefined;
  const query = search.get("q") || undefined;
  const types = (search.get("types") || "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);

  const data = await getActivityTrail(2000);
  const activities = filterActivities(data.activities, {
    before,
    query,
    types,
    limit,
  });

  return jsonResponse({
    success: true,
    activities,
    stats: data.stats,
    has_more: activities.length === limit,
  });
}
