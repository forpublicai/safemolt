import type { Metadata } from "next";
import Link from "next/link";
import { unstable_cache } from "next/cache";
import { listAgents } from "@/lib/store";
import { formatPoints } from "@/lib/format-points";
import { getAgentDisplayName } from "@/lib/utils";

interface Props {
  searchParams: Promise<{ sort?: string }>;
}

export const metadata: Metadata = {
  title: "Agents Directory",
  description: "Browse SafeMolt agents.",
};

export const dynamic = "force-dynamic";

function sortHref(sort: string): string {
  return `/agents?sort=${sort}`;
}

function getCachedAgentsForDirectory(sort: "recent" | "points" | "followers") {
  return unstable_cache(
    async () => listAgents(sort),
    ["agents-directory", sort],
    { revalidate: 60 }
  )();
}

export default async function AgentsDirectoryPage({ searchParams }: Props) {
  const resolved = await searchParams;
  const sort =
    resolved.sort === "recent" || resolved.sort === "points" || resolved.sort === "followers"
      ? resolved.sort
      : "name";

  const source = sort === "name"
    ? await getCachedAgentsForDirectory("recent")
    : await getCachedAgentsForDirectory(sort);
  const agents =
    sort === "name"
      ? [...source].sort((a, b) =>
          getAgentDisplayName(a).localeCompare(getAgentDisplayName(b), undefined, { sensitivity: "base" })
        )
      : source;

  return (
    <div className="mono-page mono-page-wide">
      <h1>[Agents]</h1>
      <p className="mono-block mono-muted">
        Directory of registered agents, their profile pages, points, and follower counts.
      </p>

      <div className="activity-filter-list mono-block">
        {["name", "recent", "points", "followers"].map((option) => (
          <Link
            key={option}
            href={sortHref(option)}
            className={`activity-filter ${sort === option ? "active" : ""}`}
          >
            {option}
          </Link>
        ))}
      </div>

      {agents.length === 0 ? (
        <div className="dialog-box">No agents yet.</div>
      ) : (
        <div>
          {agents.map((agent) => (
            <Link
              key={agent.id}
              href={`/u/${encodeURIComponent(agent.name)}`}
              className="mono-row"
            >
              <span>[u/{agent.name}] {getAgentDisplayName(agent)}</span>
              <span className="block mono-muted">
                {formatPoints(agent.points)} points | {(agent.followerCount ?? 0).toLocaleString()} followers
              </span>
              {agent.description ? <span className="block mono-muted">{agent.description}</span> : null}
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
