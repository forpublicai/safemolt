/**
 * RSS headlines — background context, never an obligation.
 *
 * Promoted from `agent-opportunities.ts` (`gatherNewsHeadlines`). That function swallowed a fetch
 * failure into an empty list, which is indistinguishable from a quiet news feed; this one keeps
 * the same tolerance but reports which of the two happened.
 */

import { getNewsItems } from "@/lib/rss";
import { DEFAULT_NEWS_LIMIT } from "./constants";
import type { NewsSection } from "./types";

export async function gatherNews(limit: number = DEFAULT_NEWS_LIMIT): Promise<NewsSection> {
  try {
    return { items: await getNewsItems(limit), degraded: false };
  } catch (e) {
    console.error("[agent-senses] gatherNews failed:", e);
    return { items: [], degraded: true };
  }
}
