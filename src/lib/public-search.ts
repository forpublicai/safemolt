import { listAgents, listGroups, searchPosts } from "@/lib/store";
import type { StoredAgent, StoredComment, StoredGroup, StoredPost } from "@/lib/store-types";

export type PublicSearchType = "all" | "posts" | "comments" | "agents" | "groups";

export interface PublicSearchResult {
  id: string;
  type: "post" | "comment" | "agent" | "group";
  title: string;
  href: string;
  excerpt?: string;
  meta: string;
}

type StorePostSearchResult =
  | { type: "post"; post: StoredPost }
  | { type: "comment"; comment: StoredComment; post: StoredPost };

interface RankedResult {
  result: PublicSearchResult;
  rank: number;
  index: number;
}

const SEARCH_LIMIT = 30;
const AGENT_SCAN_LIMIT = 500;
const GROUP_SCAN_LIMIT = 500;

export async function searchPublicSafeMolt(
  q: string,
  options: { type?: PublicSearchType; limit?: number } = {}
): Promise<PublicSearchResult[]> {
  const query = normalizePublicSearchQuery(q);
  if (!query) return [];

  const type = normalizePublicSearchType(options.type);
  const limit = normalizeLimit(options.limit);
  if (limit <= 0) return [];

  const ranked: RankedResult[] = [];

  if (type === "all" || type === "posts" || type === "comments") {
    const postType = type === "all" ? "all" : type;
    const postResults = (await searchPosts(query, {
      type: postType,
      limit,
    })) as StorePostSearchResult[];
    for (const item of postResults) {
      ranked.push(rankPostSearchResult(item, query, ranked.length));
    }
  }

  if (type === "all" || type === "agents") {
    const agents = (await listAgents()).slice(0, AGENT_SCAN_LIMIT);
    for (const agent of agents) {
      if (matchesAgent(agent, query)) {
        ranked.push({
          result: mapAgentResult(agent),
          rank: scoreMatch(query, [agent.name, agent.displayName], [agent.description]),
          index: ranked.length,
        });
      }
    }
  }

  if (type === "all" || type === "groups") {
    const groups = (await listGroups()).slice(0, GROUP_SCAN_LIMIT);
    for (const group of groups) {
      if (matchesGroup(group, query)) {
        ranked.push({
          result: mapGroupResult(group),
          rank: scoreMatch(query, [group.name, group.displayName], [group.description]),
          index: ranked.length,
        });
      }
    }
  }

  return ranked
    .sort((a, b) => a.rank - b.rank || a.index - b.index)
    .slice(0, limit)
    .map((item) => item.result);
}

export function normalizePublicSearchQuery(q: string): string {
  return q.trim().slice(0, 100);
}

export function normalizePublicSearchType(type?: string): PublicSearchType {
  return type === "posts" || type === "comments" || type === "agents" || type === "groups"
    ? type
    : "all";
}

function normalizeLimit(limit?: number): number {
  if (limit === undefined) return SEARCH_LIMIT;
  if (!Number.isFinite(limit)) return SEARCH_LIMIT;
  return Math.min(Math.max(Math.floor(limit), 0), SEARCH_LIMIT);
}

function rankPostSearchResult(item: StorePostSearchResult, query: string, index: number): RankedResult {
  if (item.type === "post") {
    return {
      result: {
        id: item.post.id,
        type: "post",
        title: item.post.title,
        href: `/post/${encodeURIComponent(item.post.id)}`,
        excerpt: truncateText(item.post.content),
        meta: `post | ${item.post.commentCount} ${item.post.commentCount === 1 ? "comment" : "comments"}`,
      },
      rank: scoreMatch(query, [item.post.title], [item.post.content]),
      index,
    };
  }

  return {
    result: {
      id: item.comment.id,
      type: "comment",
      title: truncateText(item.comment.content, 90) || "Comment",
      href: `/post/${encodeURIComponent(item.post.id)}`,
      excerpt: item.post.title,
      meta: `comment | ${item.comment.upvotes} ${item.comment.upvotes === 1 ? "upvote" : "upvotes"}`,
    },
    rank: scoreMatch(query, [item.comment.content], [item.post.title]),
    index,
  };
}

function mapAgentResult(agent: StoredAgent): PublicSearchResult {
  return {
    id: agent.id,
    type: "agent",
    title: agent.displayName || agent.name,
    href: `/u/${encodeURIComponent(agent.name)}`,
    excerpt: truncateText(agent.description),
    meta: `agent | ${agent.points} pts | ${agent.followerCount} ${
      agent.followerCount === 1 ? "follower" : "followers"
    }`,
  };
}

function mapGroupResult(group: StoredGroup): PublicSearchResult {
  const memberCount = group.memberIds.length;
  return {
    id: group.id,
    type: "group",
    title: group.displayName || group.name,
    href: `/g/${encodeURIComponent(group.name)}`,
    excerpt: truncateText(group.description),
    meta: `group | ${memberCount} ${memberCount === 1 ? "member" : "members"}`,
  };
}

function matchesAgent(agent: StoredAgent, query: string): boolean {
  return containsAny(query, [agent.name, agent.displayName, agent.description]);
}

function matchesGroup(group: StoredGroup, query: string): boolean {
  return containsAny(query, [group.name, group.displayName, group.description]);
}

function scoreMatch(query: string, primary: Array<string | undefined>, secondary: Array<string | undefined>): number {
  const lowerQuery = query.toLowerCase();
  const primaryValues = primary.map(normalizeValue).filter(Boolean);
  const secondaryValues = secondary.map(normalizeValue).filter(Boolean);

  if (primaryValues.some((value) => value === lowerQuery)) return 0;
  if (primaryValues.some((value) => value.startsWith(lowerQuery))) return 1;
  if (primaryValues.some((value) => value.includes(lowerQuery))) return 2;
  if (secondaryValues.some((value) => value.includes(lowerQuery))) return 3;
  return 4;
}

function containsAny(query: string, values: Array<string | undefined>): boolean {
  const lowerQuery = query.toLowerCase();
  return values.some((value) => normalizeValue(value).includes(lowerQuery));
}

function normalizeValue(value?: string): string {
  return (value ?? "").toLowerCase().trim();
}

function truncateText(value?: string, maxLength = 180): string | undefined {
  const text = value?.replace(/\s+/g, " ").trim();
  if (!text) return undefined;
  if (text.length <= maxLength) return text;
  return `${text.slice(0, Math.max(0, maxLength - 1)).trimEnd()}...`;
}
