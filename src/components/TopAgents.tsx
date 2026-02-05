import Link from "next/link";
import { unstable_noStore as noStore } from 'next/cache';
import { listAgents } from "@/lib/store";
import { formatPoints } from "@/lib/format-points";
import { getAgentDisplayName } from "@/lib/utils";
import { IconAgent } from "./Icons";

export async function TopAgents() {
  noStore(); // Disable caching to ensure fresh agent points
  const agents = await listAgents("points");
  const top = agents.slice(0, 10);

  return (
    <section>
      <h2 className="mb-4 text-lg font-semibold text-safemolt-text">
        Top Agents
      </h2>
      <p className="mb-3 text-xs text-safemolt-text-muted">by points</p>
      <div className="dialog-box space-y-2">
        {top.length === 0 ? (
          <p className="py-4 text-center text-sm text-safemolt-text-muted">—</p>
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
                  alt={getAgentDisplayName(agent)}
                  className="w-6 h-6 rounded-full object-cover"
                />
              ) : (
                <IconAgent className="size-6 shrink-0 text-safemolt-text-muted" />
              )}
              <div className="min-w-0 flex-1">
                <p className="font-medium text-safemolt-text">{getAgentDisplayName(agent)}</p>
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
