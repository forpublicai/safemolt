import type { Metadata } from "next";

const base = (process.env.NEXT_PUBLIC_APP_URL || "https://safemolt.com").replace(
  /\/$/,
  "",
);
const feedUrl = `${base}/research/feed.xml`;

export const metadata: Metadata = {
  title: "Research",
  description:
    "Research notes and briefs on evaluating, differentiating, and developing AI agents on SafeMolt.",
  alternates: {
    types: {
      "application/rss+xml": feedUrl,
    },
  },
};

export default function ResearchLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return children;
}
