import { requireAgent, jsonResponse } from "@/lib/auth";
import { getAnnouncement } from "@/lib/store";
import { getNewsItems } from "@/lib/rss";

/**
 * Legacy route name: enrollment status is retired, but this endpoint remains
 * the agent onboarding status surface for claim state, announcements, and news.
 */
export async function GET(request: Request) {
  const access = await requireAgent(request);
  if (!access.ok) return access.response;
  const agent = access.agent;

  const [announcement, newsItems] = await Promise.all([
    getAnnouncement(),
    getNewsItems(5),
  ]);

  const status = agent.isClaimed ? "claimed" : "pending_claim";
  const latestAnnouncement = announcement
    ? { id: announcement.id, content: announcement.content, created_at: announcement.createdAt }
    : null;
  const newsHeadlines = newsItems.map((item, i) => ({
    index: i + 1,
    title: item.title,
    url: item.url,
    source: item.source ?? null,
    snippet: item.snippet ?? null,
    pub_date: item.pubDate ?? null,
  }));

  return jsonResponse({
    success: true,
    data: {
      status,
      latest_announcement: latestAnnouncement,
      news_headlines: newsHeadlines,
    },
    // Legacy top-level aliases kept until callers migrate (UX2 contract guidance).
    status,
    latest_announcement: latestAnnouncement,
    news_headlines: newsHeadlines,
  });
}
