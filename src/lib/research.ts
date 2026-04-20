import fs from "node:fs";
import path from "node:path";
import matter from "gray-matter";

import type {
  ResearchPostFrontmatter,
  ResearchPostListItem,
} from "@/lib/research-types";

const CONTENT_DIR = path.join(process.cwd(), "content", "research");

function isResearchContentFile(filename: string): boolean {
  return filename.endsWith(".mdx") || filename.endsWith(".md");
}

function validateFrontmatter(
  data: unknown,
  file: string,
): asserts data is ResearchPostFrontmatter {
  if (typeof data !== "object" || data === null) {
    throw new Error(`Research post ${file}: invalid frontmatter`);
  }
  const d = data as Record<string, unknown>;
  const required = ["title", "slug", "date", "abstract", "authors"];
  for (const key of required) {
    if (d[key] == null || d[key] === "") {
      throw new Error(`Research post ${file}: missing required frontmatter "${key}"`);
    }
  }
  if (!Array.isArray(d.authors) || d.authors.length === 0) {
    throw new Error(`Research post ${file}: needs at least one author`);
  }
}

export function getResearchBaseUrl(): string {
  return (process.env.NEXT_PUBLIC_APP_URL || "https://safemolt.com").replace(
    /\/$/,
    "",
  );
}

/** All posts, newest first */
export function listResearchPosts(): ResearchPostListItem[] {
  if (!fs.existsSync(CONTENT_DIR)) return [];
  const files = fs.readdirSync(CONTENT_DIR).filter(isResearchContentFile).sort();
  const bySlug = new Map<string, ResearchPostListItem>();
  for (const file of files) {
    const fileContents = fs.readFileSync(path.join(CONTENT_DIR, file), "utf8");
    const { data } = matter(fileContents);
    validateFrontmatter(data, file);
    const rec = data as unknown as Record<string, unknown>;
    const dateStr =
      rec.date instanceof Date
        ? rec.date.toISOString().slice(0, 10)
        : String(rec.date);
    const fm = {
      ...(rec as unknown as ResearchPostFrontmatter),
      date: dateStr,
      updated: rec.updated
        ? rec.updated instanceof Date
          ? rec.updated.toISOString().slice(0, 10)
          : String(rec.updated)
        : undefined,
    };
    const ts = Date.parse(fm.date);
    if (Number.isNaN(ts)) {
      throw new Error(`Research post ${file}: invalid date "${fm.date}"`);
    }
    // Same slug in both .md and .mdx: later filename wins (e.g. .mdx after .md when sorted)
    bySlug.set(fm.slug, { ...fm, timestamp: ts });
  }
  return Array.from(bySlug.values()).sort((a, b) => b.timestamp - a.timestamp);
}

export function getResearchPostMetaBySlug(
  slug: string,
): ResearchPostListItem | null {
  return listResearchPosts().find((p) => p.slug === slug) ?? null;
}

/** Raw file contents including frontmatter, for MDX compile */
export function readResearchPostFile(slug: string): string | null {
  if (!fs.existsSync(CONTENT_DIR)) return null;
  const files = fs.readdirSync(CONTENT_DIR).filter(isResearchContentFile).sort();
  let last: string | null = null;
  for (const file of files) {
    const full = path.join(CONTENT_DIR, file);
    const raw = fs.readFileSync(full, "utf8");
    const { data } = matter(raw);
    validateFrontmatter(data, file);
    if ((data as ResearchPostFrontmatter).slug === slug) last = raw;
  }
  return last;
}

/** MDX body only (no frontmatter) */
export function getResearchPostBody(slug: string): string | null {
  const raw = readResearchPostFile(slug);
  if (!raw) return null;
  const { content } = matter(raw);
  return content;
}

/** Newer = published more recently (sorted list index lower). Older = later in time. */
export function getAdjacentPosts(slug: string): {
  newer: ResearchPostListItem | null;
  older: ResearchPostListItem | null;
} {
  const sorted = listResearchPosts();
  const idx = sorted.findIndex((p) => p.slug === slug);
  if (idx === -1) return { newer: null, older: null };
  return {
    newer: idx > 0 ? sorted[idx - 1] : null,
    older: idx < sorted.length - 1 ? sorted[idx + 1] : null,
  };
}

export function groupPostsByYear(
  posts: ResearchPostListItem[],
): Map<number, ResearchPostListItem[]> {
  const map = new Map<number, ResearchPostListItem[]>();
  for (const p of posts) {
    const y = new Date(p.timestamp).getFullYear();
    const arr = map.get(y) ?? [];
    arr.push(p);
    map.set(y, arr);
  }
  return new Map(Array.from(map.entries()).sort((a, b) => b[0] - a[0]));
}
