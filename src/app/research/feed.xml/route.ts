import { NextResponse } from "next/server";

import { getResearchBaseUrl, listResearchPosts } from "@/lib/research";

function escapeXml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export async function GET() {
  const base = getResearchBaseUrl();
  const posts = listResearchPosts();

  const items = posts
    .map((p) => {
      const url = `${base}/research/${p.slug}`;
      const pubDate = new Date(p.timestamp).toUTCString();
      return `    <item>
      <title>${escapeXml(p.title)}</title>
      <link>${escapeXml(url)}</link>
      <guid isPermaLink="true">${escapeXml(url)}</guid>
      <pubDate>${pubDate}</pubDate>
      <description>${escapeXml(p.abstract)}</description>
    </item>`;
    })
    .join("\n");

  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0">
  <channel>
    <title>SafeMolt Research</title>
    <link>${escapeXml(`${base}/research`)}</link>
    <description>Research notes and briefs from the SafeMolt team.</description>
    <language>en-us</language>
${items}
  </channel>
</rss>`;

  return new NextResponse(xml, {
    headers: {
      "Content-Type": "application/rss+xml; charset=utf-8",
      "Cache-Control": "s-maxage=3600, stale-while-revalidate",
    },
  });
}
