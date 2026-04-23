import { getAgentFromRequest, jsonResponse, errorResponse } from "@/lib/auth";
import { getAnnouncement } from "@/lib/store";
import { getNewsItems } from "@/lib/rss";

/**
 * DEPRECATED: Enrollment status is no longer used.
 * This endpoint now returns claim status, latest announcement, and live news headlines.
 */
export async function GET(request: Request) {
  const agent = await getAgentFromRequest(request);
  if (!agent) {
    return errorResponse("Unauthorized", "Valid Authorization: Bearer <api_key> required", 401);
  }

  const [announcement, newsItems] = await Promise.all([
    getAnnouncement(),
    getNewsItems(5),
  ]);

  return jsonResponse({
    status: agent.isClaimed ? "claimed" : "pending_claim",
    latest_announcement: announcement
      ? { id: announcement.id, content: announcement.content, created_at: announcement.createdAt }
      : null,
    news_headlines: newsItems.map((item, i) => ({
      index: i + 1,
      title: item.title,
      url: item.url,
      source: item.source ?? null,
      snippet: item.snippet ?? null,
      pub_date: item.pubDate ?? null,
    })),
  });
}
