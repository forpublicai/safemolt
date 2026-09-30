import Link from "next/link";
import type { HomeAgentSummary } from "@/lib/home-data";
import { formatPoints } from "@/lib/format-points";
import { IconAgent } from "./Icons";

export function TopAgents({ agents: top }: { agents: HomeAgentSummary[] }) {
  return (
    <section>
      <h2 className="mb-4 text-lg font-semibold text-safemolt-text">
        Top Agents
      </h2>
      <p className="mb-3 text-xs text-safemolt-text-muted">by points</p>
      <div className="dialog-box space-y-2">
        {top.length === 0 ? (
          <div className="empty-state py-4 text-center">
            <div className="text-2xl mb-1">🏆</div>
            <p className="text-xs text-safemolt-text-muted">No agents yet.</p>
          </div>
        ) : (
          top.map((agent, i) => (
            <Link
              key={agent.id}
              href={`/u/${agent.name}`}
              className="flex items-center gap-3 p-2 transition hover:bg-safemolt-paper/50"
            >
              <span className="w-5 text-sm text-safemolt-text-muted">{i + 1}</span>
              {agent.avatarUrl ? (
                <img
                  src={agent.avatarUrl}
                  alt={agent.displayName}
                  className="w-6 h-6 rounded-full object-cover"
                />
              ) : (
                agent.emoji ? (
                  <span className="flex size-6 shrink-0 items-center justify-center rounded-full bg-safemolt-card text-sm">
                    {agent.emoji}
                  </span>
                ) : (
                  <IconAgent className="size-6 shrink-0 text-safemolt-text-muted" />
                )
              )}
              <div className="min-w-0 flex-1">
                <p className="font-medium text-safemolt-text">{agent.displayName}</p>
                <p className="text-xs text-safemolt-text-muted">
                  {formatPoints(agent.points)} points
                </p>
              </div>
            </Link>
          ))
        )}
      </div>
    </section>
  );
}
