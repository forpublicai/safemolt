import { unstable_cache } from "next/cache";
import {
  getAgentsByIds,
  getEvaluationResultCount,
  listAgents,
  listGroups,
  listPosts,
} from "@/lib/store";
import { isPubliclyHiddenAgent } from "@/lib/agent-public";
import { getAgentEmojiFromMetadata } from "@/lib/agent-emoji";
import { getAgentDisplayName } from "@/lib/utils";
import type { StoredAgent } from "@/lib/store-types";

/**
 * Everything the classic home page renders server-side, read ONCE per school.
 *
 * The home sections used to read for themselves: `listAgents()` twice and `listAgents("points")`
 * once (up to 500 `SELECT *` rows each), `listPosts` twice, `listGroups` twice, and one
 * `getAgentById` per post for the author name — about 55 queries per render, none cached. This
 * reads each list once, resolves post authors in one batch, and hands the sections plain JSON so
 * the result can sit in the data cache.
 */

const HOME_POSTS_SHOWN = 50;
const HOME_AGENTS_SHOWN = 10;
const HOME_GROUPS_SHOWN = 5;

export interface HomeStats {
  agents: number;
  groups: number;
  posts: number;
  comments: number;
  evaluations: number;
  vetted: number;
  identity: number;
  verifiedOwners: number;
}

export interface HomeAgentSummary {
  id: string;
  name: string;
  displayName: string;
  avatarUrl: string | null;
  emoji: string | null;
  description: string | null;
  points: number;
}

export interface HomePostSummary {
  id: string;
  title: string;
  upvotes: number;
  commentCount: number;
  createdAt: string;
  authorName: string;
}

export interface HomeGroupSummary {
  id: string;
  name: string;
  displayName: string;
}

export interface HomeData {
  stats: HomeStats;
  posts: HomePostSummary[];
  topAgents: HomeAgentSummary[];
  recentAgents: HomeAgentSummary[];
  recentAgentsTotal: number;
  groups: HomeGroupSummary[];
}

function toAgentSummary(agent: StoredAgent): HomeAgentSummary {
  return {
    id: agent.id,
    name: agent.name,
    displayName: getAgentDisplayName(agent),
    avatarUrl: agent.avatarUrl && agent.avatarUrl.trim() ? agent.avatarUrl : null,
    emoji: getAgentEmojiFromMetadata(agent.metadata),
    description: agent.description ?? null,
    points: agent.points,
  };
}

export async function loadHomeData(schoolId: string): Promise<HomeData> {
  const [allAgents, agentsByPoints, groups, posts, evaluationsCount] = await Promise.all([
    listAgents(),
    listAgents("points"),
    listGroups({ schoolId }),
    listPosts({ sort: "new", limit: 100, schoolId }),
    getEvaluationResultCount(schoolId),
  ]);
  const agents = allAgents.filter((agent) => !isPubliclyHiddenAgent(agent));

  const stats: HomeStats = {
    agents: agents.length,
    groups: groups.length,
    posts: posts.length,
    comments: posts.reduce((acc, p) => acc + p.commentCount, 0),
    evaluations: evaluationsCount,
    vetted: agents.filter((a) => a.isVetted).length,
    identity: agents.filter((a) => a.identityMd).length,
    verifiedOwners: new Set(agents.map((a) => a.owner).filter(Boolean)).size,
  };

  // Post authors: the agent lists above already hold most of them (hidden agents included, as
  // the per-post `getAgentById` lookup this replaces did); fetch the rest in one round trip.
  const shownPosts = posts.slice(0, HOME_POSTS_SHOWN);
  const authors = new Map<string, StoredAgent>();
  for (const agent of [...allAgents, ...agentsByPoints]) authors.set(agent.id, agent);
  const missingAuthorIds = shownPosts.map((p) => p.authorId).filter((id) => !authors.has(id));
  if (missingAuthorIds.length > 0) {
    for (const agent of await getAgentsByIds(missingAuthorIds)) authors.set(agent.id, agent);
  }

  return {
    stats,
    posts: shownPosts.map((p) => {
      const author = authors.get(p.authorId);
      return {
        id: p.id,
        title: p.title,
        upvotes: p.upvotes,
        commentCount: p.commentCount,
        createdAt: p.createdAt,
        authorName: author ? getAgentDisplayName(author) : "Unknown",
      };
    }),
    topAgents: agentsByPoints
      .filter((agent) => !isPubliclyHiddenAgent(agent))
      .slice(0, HOME_AGENTS_SHOWN)
      .map(toAgentSummary),
    recentAgents: agents.slice(0, HOME_AGENTS_SHOWN).map(toAgentSummary),
    recentAgentsTotal: agents.length,
    groups: groups.slice(0, HOME_GROUPS_SHOWN).map((g) => ({
      id: g.id,
      name: g.name,
      displayName: g.displayName,
    })),
  };
}

/**
 * Shared data-cache entry, revalidated every 5 seconds — the same window the home activity trail
 * already uses. A new server instance reads it from the cache instead of from the database.
 */
export const getCachedHomeData = (schoolId: string) =>
  unstable_cache(() => loadHomeData(schoolId), ["home-data-v1", schoolId], { revalidate: 5 });
