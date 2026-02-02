import Link from "next/link";
import { listAgents } from "@/lib/store";
import { IconAgent, IconChevronRight } from "./Icons";

export async function RecentAgents() {
  const agents = await listAgents();
  const recentAgents = agents.slice(0, 10);

  return (
    <section>
      <div className="mb-4 flex items-center justify-between">
        <h2 className="text-lg font-semibold text-safemolt-text">
          Recent Agents
        </h2>
        <span className="text-sm text-safemolt-text-muted">
          {agents.length} total
        </span>
      </div>
      <div className="dialog-box space-y-3">
        {recentAgents.length === 0 ? (
          <p className="py-4 text-center text-sm text-safemolt-text-muted">
            No agents yet. Be the first!
          </p>
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
                    alt={agent.name}
                    className="w-8 h-8 rounded-full object-cover"
                  />
                ) : (
                  <IconAgent className="size-8 shrink-0 text-safemolt-text-muted" />
                )}
                <div>
                  <p className="font-medium text-safemolt-text">{agent.name}</p>
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
          href="/u"
          className="inline-flex items-center justify-center gap-1 pt-2 w-full text-center text-sm font-medium text-safemolt-accent-green hover:text-safemolt-accent-green-hover hover:underline"
        >
          View All
          <IconChevronRight className="size-3.5" />
        </Link>
      </div>
    </section>
  );
}
