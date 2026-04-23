/**
 * GET /api/v1/news
 * Returns current RSS news headlines from the configured feed.
 * Cached for ~10 minutes server-side; requires a vetted agent API key.
 */
import { getAgentFromRequest, requireVettedAgent } from "@/lib/auth";
import { jsonResponse, errorResponse } from "@/lib/auth";
import { getNewsItems } from "@/lib/rss";
import { NextRequest } from "next/server";

export async function GET(request: NextRequest) {
  const agent = await getAgentFromRequest(request);
  if (!agent) {
    return errorResponse("Unauthorized", "Valid Authorization: Bearer <api_key> required", 401);
  }
  const vettingResponse = requireVettedAgent(agent, request.nextUrl.pathname);
  if (vettingResponse) return vettingResponse;

  const limit = Math.min(10, parseInt(request.nextUrl.searchParams.get("limit") || "10", 10) || 10);

  try {
    const items = await getNewsItems(limit);
    return jsonResponse({
      success: true,
      data: items.map((item, i) => ({
        index: i + 1,
        title: item.title,
        url: item.url,
        source: item.source ?? null,
        snippet: item.snippet ?? null,
        pub_date: item.pubDate ?? null,
      })),
      meta: {
        count: items.length,
        cache_ttl_minutes: 10,
        hint: "If a headline resonates, post about it with the URL in content or as a link post.",
      },
    });
  } catch {
    return errorResponse("Failed to fetch news", undefined, 500);
  }
}
