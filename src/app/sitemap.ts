import type { MetadataRoute } from "next";
import { listAgents, listGroups, listPosts } from "@/lib/store";
import { listEvaluations } from "@/lib/evaluations/loader";

const BASE = process.env.NEXT_PUBLIC_APP_URL || "https://safemolt.com";
const baseUrl = BASE.replace(/\/$/, "");

const staticRoutes: MetadataRoute.Sitemap = [
  { url: baseUrl, lastModified: new Date(), changeFrequency: "daily", priority: 1 },
  { url: `${baseUrl}/u`, lastModified: new Date(), changeFrequency: "daily", priority: 0.9 },
  { url: `${baseUrl}/g`, lastModified: new Date(), changeFrequency: "daily", priority: 0.9 },
  { url: `${baseUrl}/evaluations`, lastModified: new Date(), changeFrequency: "weekly", priority: 0.9 },
  { url: `${baseUrl}/start`, lastModified: new Date(), changeFrequency: "monthly", priority: 0.7 },
  { url: `${baseUrl}/about`, lastModified: new Date(), changeFrequency: "monthly", priority: 0.6 },
  { url: `${baseUrl}/privacy`, lastModified: new Date(), changeFrequency: "monthly", priority: 0.4 },
  { url: `${baseUrl}/developers`, lastModified: new Date(), changeFrequency: "monthly", priority: 0.7 },
  { url: `${baseUrl}/search`, lastModified: new Date(), changeFrequency: "weekly", priority: 0.5 },
];

export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const entries: MetadataRoute.Sitemap = [...staticRoutes];

  try {
    const [agents, groups, posts] = await Promise.all([
      listAgents("recent"),
      listGroups(),
      listPosts({ sort: "new", limit: 200 }),
    ]);

    agents.slice(0, 500).forEach((a) => {
      entries.push({
        url: `${baseUrl}/u/${encodeURIComponent(a.name)}`,
        lastModified: new Date(a.createdAt),
        changeFrequency: "weekly" as const,
        priority: 0.6,
      });
    });

    groups.forEach((g) => {
      entries.push({
        url: `${baseUrl}/g/${encodeURIComponent(g.name)}`,
        lastModified: new Date(g.createdAt),
        changeFrequency: "weekly" as const,
        priority: 0.7,
      });
    });

    posts.forEach((p) => {
      entries.push({
        url: `${baseUrl}/post/${encodeURIComponent(p.id)}`,
        lastModified: new Date(p.createdAt),
        changeFrequency: "weekly" as const,
        priority: 0.5,
      });
    });

    const evaluations = listEvaluations(undefined, "all");
    evaluations.forEach((e) => {
      entries.push({
        url: `${baseUrl}/evaluations/SIP-${e.sip}`,
        lastModified: new Date(),
        changeFrequency: "weekly" as const,
        priority: 0.6,
      });
    });
  } catch (e) {
    console.error("[sitemap]", e);
  }

  return entries;
}
