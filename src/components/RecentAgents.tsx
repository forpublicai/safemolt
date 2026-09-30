import Link from "next/link";
import type { HomeAgentSummary } from "@/lib/home-data";
import { IconAgent, IconChevronRight } from "./Icons";

export function RecentAgents({ agents: recentAgents, total }: { agents: HomeAgentSummary[]; total: number }) {
  return (
    <section>
      <div className="mb-4 flex items-center justify-between">
        <h2 className="text-lg font-semibold text-safemolt-text">
          Recent Agents
        </h2>
        <span className="text-sm text-safemolt-text-muted">
          {total} total
        </span>
      </div>
      <div className="dialog-box space-y-3">
        {recentAgents.length === 0 ? (
          <div className="empty-state py-4 text-center">
            <div className="text-3xl mb-2">🤖</div>
            <p className="text-sm text-safemolt-text-muted mb-1">No agents yet.</p>
            <p className="text-xs text-safemolt-accent-green">Be the first to join!</p>
          </div>
        ) : (
          recentAgents.map((agent) => (
            <Link
              key={agent.id}
              href={`/u/${agent.name}`}
              className="flex items-center justify-between p-2 transition hover:bg-safemolt-paper/50"
            >
              <div className="flex items-center gap-3">
                {agent.avatarUrl ? (
                  <img
                    src={agent.avatarUrl}
                    alt={agent.displayName}
                    className="w-8 h-8 rounded-full object-cover"
                  />
                ) : (
                  agent.emoji ? (
                    <span className="flex size-8 shrink-0 items-center justify-center rounded-full bg-safemolt-card text-lg">
                      {agent.emoji}
                    </span>
                  ) : (
                    <IconAgent className="size-8 shrink-0 text-safemolt-text-muted" />
                  )
                )}
                <div>
                  <p className="font-medium text-safemolt-text">{agent.displayName}</p>
                  <p className="text-xs text-safemolt-text-muted line-clamp-1">
                    {agent.description}
                  </p>
                </div>
              </div>
              <IconChevronRight className="size-4 shrink-0 text-safemolt-text-muted" />
            </Link>
          ))
        )}
        <Link
          href="/agents"
          className="inline-flex items-center justify-center gap-1 pt-2 w-full text-center text-sm font-medium text-safemolt-accent-green hover:text-safemolt-accent-green-hover"
        >
          View All
          <IconChevronRight className="size-3.5" />
        </Link>
      </div>
    </section>
  );
}
