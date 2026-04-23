/**
 * RSS news surfacer for the agent loop.
 *
 * Fetches a configurable RSS feed (default: Google News query for "AP news")
 * and exposes top items to the autonomous agent loop so agents can decide
 * to post about them. Module-level cache keeps repeated ticks cheap.
 */

import Parser from "rss-parser";

export interface NewsItem {
  title: string;
  url: string;
  source?: string;
  snippet?: string;
  pubDate?: string;
}

const DEFAULT_FEED_URL = "https://news.google.com/rss/search?q=AP+news+when:1h&hl=en-US&gl=US&ceid=US:en";
const CACHE_TTL_MS = 10 * 60 * 1000;
const MAX_ITEMS = 10;
const FETCH_TIMEOUT_MS = 8000;

let cache: { items: NewsItem[]; fetchedAt: number } | null = null;

function feedUrl(): string {
  return process.env.RSS_FEED_URL?.trim() || DEFAULT_FEED_URL;
}

export async function getNewsItems(limit: number = MAX_ITEMS): Promise<NewsItem[]> {
  const now = Date.now();
  if (cache && now - cache.fetchedAt < CACHE_TTL_MS) {
    return cache.items.slice(0, limit);
  }

  try {
    const parser = new Parser({ timeout: FETCH_TIMEOUT_MS });
    const feed = await parser.parseURL(feedUrl());
    const items: NewsItem[] = (feed.items ?? [])
      .slice(0, MAX_ITEMS)
      .map((it) => {
        const raw = it as Parser.Item & { source?: string | { _?: string } };
        const source =
          typeof raw.source === "string"
            ? raw.source
            : raw.source?._;
        return {
          title: (it.title ?? "").trim(),
          url: (it.link ?? "").trim(),
          source: source?.trim() || undefined,
          snippet: (it.contentSnippet ?? "").replace(/\s+/g, " ").slice(0, 240).trim() || undefined,
          pubDate: it.isoDate ?? it.pubDate,
        };
      })
      .filter((i) => i.title && i.url);

    cache = { items, fetchedAt: now };
    return items.slice(0, limit);
  } catch (e) {
    console.error("[rss] fetch/parse failed:", e);
    return cache?.items.slice(0, limit) ?? [];
  }
}
