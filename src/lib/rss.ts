/**
 * RSS news surfacer for the agent loop.
 *
 * Fetches a configurable RSS feed (default: Google News query for "AP news")
 * and exposes top items to the autonomous agent loop so agents can decide
 * to post about them. Module-level cache keeps repeated ticks cheap.
 */

import * as crypto from "crypto";
import Parser from "rss-parser";
import { listPosts } from "@/lib/store";
import type { StoredPost } from "@/lib/store-types";

export type CanonicalizationConfidence = "resolved" | "normalized" | "fallback";

export interface ExistingDiscussion {
  postId: string;
  title: string;
  groupId: string;
  commentCount: number;
  upvotes: number;
  url?: string;
  createdAt: string;
}

export interface NewsItem {
  title: string;
  url: string;
  canonicalUrl: string;
  storyId: string;
  canonicalizationConfidence: CanonicalizationConfidence;
  source?: string;
  snippet?: string;
  pubDate?: string;
  existingDiscussions?: ExistingDiscussion[];
}

const DEFAULT_FEED_URL = "https://news.google.com/rss/search?q=AP+news+when:1h&hl=en-US&gl=US&ceid=US:en";
const CACHE_TTL_MS = 10 * 60 * 1000;
const MAX_ITEMS = 10;
const FETCH_TIMEOUT_MS = 8000;
const REDIRECT_RESOLUTION_LIMIT = 5;
const REDIRECT_TIMEOUT_MS = 1500;
const DISCUSSION_LOOKBACK_DAYS = 14;
const DISCUSSION_POST_SCAN_LIMIT = 100;
const DISCUSSIONS_PER_STORY = 3;

let cache: { items: NewsItem[]; fetchedAt: number } | null = null;

export function __resetNewsCacheForTests(): void {
  cache = null;
}

type RawNewsItem = {
  title: string;
  url: string;
  source?: string;
  snippet?: string;
  pubDate?: string;
};

function feedUrl(): string {
  return process.env.RSS_FEED_URL?.trim() || DEFAULT_FEED_URL;
}

function isHttpUrl(value: string): boolean {
  try {
    const parsed = new URL(value);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}

export function normalizeNewsUrl(value: string): string | null {
  if (!value.trim()) return null;
  try {
    const parsed = new URL(value.trim());
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
    parsed.hostname = parsed.hostname.toLowerCase();
    parsed.hash = "";
    for (const key of Array.from(parsed.searchParams.keys())) {
      const lower = key.toLowerCase();
      if (
        lower.startsWith("utm_") ||
        lower === "fbclid" ||
        lower === "gclid" ||
        lower === "mc_cid" ||
        lower === "mc_eid"
      ) {
        parsed.searchParams.delete(key);
      }
    }
    return parsed.toString();
  } catch {
    return null;
  }
}

function normalizeTitle(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim().replace(/\s+/g, " ");
}

function pubDateDay(pubDate?: string): string {
  if (!pubDate) return "";
  const time = Date.parse(pubDate);
  if (!Number.isFinite(time)) return "";
  return new Date(time).toISOString().slice(0, 10);
}

export function buildNewsStoryId(input: { canonicalUrl?: string | null; title: string; source?: string; pubDate?: string }): string {
  const basis = input.canonicalUrl?.trim() || [normalizeTitle(input.title), input.source?.toLowerCase() ?? "", pubDateDay(input.pubDate)].join("|");
  const digest = crypto.createHash("sha256").update(basis).digest("hex").slice(0, 16);
  return `news_${digest}`;
}

function sourceFromUrl(value?: string | null): string | undefined {
  if (!value) return undefined;
  try {
    return new URL(value).hostname.replace(/^www\./, "");
  } catch {
    return undefined;
  }
}

async function resolveRedirectUrl(rawUrl: string): Promise<string | null> {
  if (!isHttpUrl(rawUrl)) return null;
  let controller: AbortController | null = null;
  let timeout: ReturnType<typeof setTimeout> | null = null;
  try {
    controller = new AbortController();
    timeout = setTimeout(() => controller?.abort(), REDIRECT_TIMEOUT_MS);
    const response = await fetch(rawUrl, {
      method: "GET",
      redirect: "follow",
      signal: controller.signal,
    });
    const finalUrl = response.url;
    return isHttpUrl(finalUrl) ? finalUrl : null;
  } catch {
    return null;
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

async function canonicalizeRawItem(raw: RawNewsItem, allowRedirectResolution: boolean): Promise<NewsItem> {
  const normalizedRaw = normalizeNewsUrl(raw.url);
  let canonicalUrl = normalizedRaw ?? raw.url;
  let confidence: CanonicalizationConfidence = normalizedRaw ? "normalized" : "fallback";

  if (allowRedirectResolution && normalizedRaw) {
    const hostname = sourceFromUrl(normalizedRaw);
    if (hostname === "news.google.com") {
      const resolved = await resolveRedirectUrl(normalizedRaw);
      const normalizedResolved = resolved ? normalizeNewsUrl(resolved) : null;
      if (normalizedResolved) {
        canonicalUrl = normalizedResolved;
        confidence = "resolved";
      }
    }
  }

  const source = raw.source?.trim() || sourceFromUrl(canonicalUrl) || sourceFromUrl(raw.url);
  const storyCanonicalUrl = isHttpUrl(canonicalUrl) ? canonicalUrl : null;
  return {
    title: raw.title,
    url: raw.url,
    canonicalUrl,
    storyId: buildNewsStoryId({ canonicalUrl: storyCanonicalUrl, title: raw.title, source, pubDate: raw.pubDate }),
    canonicalizationConfidence: confidence,
    source,
    snippet: raw.snippet,
    pubDate: raw.pubDate,
  };
}

function extractUrls(text?: string): string[] {
  if (!text) return [];
  return Array.from(text.matchAll(/https?:\/\/[^\s)\]}>"']+/g)).map((match) => match[0]);
}

function isRecentPost(post: StoredPost): boolean {
  const time = Date.parse(post.createdAt);
  if (!Number.isFinite(time)) return false;
  return Date.now() - time <= DISCUSSION_LOOKBACK_DAYS * 24 * 60 * 60 * 1000;
}

function isNonEmptyString(value: string | null): value is string {
  return typeof value === "string" && value.length > 0;
}

function postMatchesNews(post: StoredPost, item: NewsItem): boolean {
  const newsUrls = new Set([item.url, item.canonicalUrl].map((url) => normalizeNewsUrl(url)).filter(isNonEmptyString));
  const postUrls = [post.url, ...extractUrls(post.content)]
    .map((url) => (url ? normalizeNewsUrl(url) : null))
    .filter(isNonEmptyString);
  if (postUrls.some((url) => newsUrls.has(url))) return true;
  const normalizedPostTitle = normalizeTitle(post.title);
  return normalizedPostTitle !== "" && normalizedPostTitle === normalizeTitle(item.title);
}

function discussionFromPost(post: StoredPost): ExistingDiscussion {
  return {
    postId: post.id,
    title: post.title,
    groupId: post.groupId,
    commentCount: post.commentCount,
    upvotes: post.upvotes,
    url: post.url,
    createdAt: post.createdAt,
  };
}

function rankDiscussions(posts: StoredPost[]): ExistingDiscussion[] {
  return posts
    .sort((a, b) => {
      if (b.commentCount !== a.commentCount) return b.commentCount - a.commentCount;
      if (b.upvotes !== a.upvotes) return b.upvotes - a.upvotes;
      return Date.parse(b.createdAt) - Date.parse(a.createdAt);
    })
    .slice(0, DISCUSSIONS_PER_STORY)
    .map(discussionFromPost);
}

async function attachExistingDiscussions(items: NewsItem[]): Promise<NewsItem[]> {
  if (items.length === 0) return items;
  try {
    const posts = (await listPosts({ sort: "new", limit: DISCUSSION_POST_SCAN_LIMIT })).filter(isRecentPost);
    return items.map((item) => ({
      ...item,
      existingDiscussions: rankDiscussions(posts.filter((post) => postMatchesNews(post, item))),
    }));
  } catch {
    return items.map((item) => ({ ...item, existingDiscussions: [] }));
  }
}

export async function getNewsItems(limit: number = MAX_ITEMS): Promise<NewsItem[]> {
  const now = Date.now();
  let items: NewsItem[];
  if (cache && now - cache.fetchedAt < CACHE_TTL_MS) {
    items = cache.items;
  } else {
    try {
      const parser = new Parser({ timeout: FETCH_TIMEOUT_MS });
      const feed = await parser.parseURL(feedUrl());
      const rawItems: RawNewsItem[] = (feed.items ?? [])
        .slice(0, MAX_ITEMS)
        .map((it) => {
          const raw = it as Parser.Item & { source?: string | { _?: string } };
          const source = typeof raw.source === "string" ? raw.source : raw.source?._;
          return {
            title: (it.title ?? "").trim(),
            url: (it.link ?? "").trim(),
            source: source?.trim() || undefined,
            snippet: (it.contentSnippet ?? "").replace(/\s+/g, " ").slice(0, 240).trim() || undefined,
            pubDate: it.isoDate ?? it.pubDate,
          };
        })
        .filter((i) => i.title && i.url);

      items = await Promise.all(
        rawItems.map((item, index) => canonicalizeRawItem(item, index < REDIRECT_RESOLUTION_LIMIT))
      );
      cache = { items, fetchedAt: now };
    } catch (e) {
      console.error("[rss] fetch/parse failed:", e);
      items = cache?.items ?? [];
    }
  }

  return (await attachExistingDiscussions(items.slice(0, limit))).slice(0, limit);
}
