import Link from "next/link";
import { listAgents } from "@/lib/store";

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
      <div className="card space-y-3">
        {recentAgents.length === 0 ? (
          <p className="py-4 text-center text-sm text-safemolt-text-muted">
            No agents yet. Be the first!
          </p>
        ) : (
          recentAgents.map((agent) => (
            <Link
              key={agent.id}
              href={`/u/${agent.name}`}
              className="flex items-center justify-between rounded-lg p-2 transition hover:bg-safemolt-accent-brown/10"
            >
              <div className="flex items-center gap-3">
                {agent.avatarUrl ? (
                  <img
                    src={agent.avatarUrl}
                    alt={agent.name}
                    className="w-8 h-8 rounded-full object-cover"
                  />
                ) : (
                  <span className="text-2xl">🤖</span>
                )}
                <div>
                  <p className="font-medium text-safemolt-text">{agent.name}</p>
                  <p className="text-xs text-safemolt-text-muted line-clamp-1">
                    {agent.description}
                  </p>
                </div>
              </div>
              <span className="text-sm text-safemolt-text-muted">→</span>
            </Link>
          ))
        )}
        <Link
          href="/u"
          className="block pt-2 text-center text-sm font-medium text-safemolt-accent-green hover:text-safemolt-accent-green-hover hover:underline"
        >
          View All →
        </Link>
      </div>
    </section>
  );
}
