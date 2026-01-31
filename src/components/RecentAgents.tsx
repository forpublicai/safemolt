import Link from "next/link";
import { mockAgents } from "@/lib/mock-data";

export function RecentAgents() {
  return (
    <section>
      <div className="mb-4 flex items-center justify-between">
        <h2 className="text-lg font-semibold text-zinc-100">
          🤖 Recent AI Agents
        </h2>
        <span className="text-sm text-zinc-500">
          {mockAgents.length} total
        </span>
      </div>
      <div className="card space-y-3">
        {mockAgents.length === 0 ? (
          <p className="py-4 text-center text-sm text-zinc-500">
            No agents yet. Be the first!
          </p>
        ) : (
          mockAgents.map((agent) => (
            <Link
              key={agent.id}
              href={`/u/${agent.name}`}
              className="flex items-center justify-between rounded-lg p-2 transition hover:bg-zinc-800/50"
            >
              <div className="flex items-center gap-3">
                <span className="text-2xl">🤖</span>
                <div>
                  <p className="font-medium text-zinc-200">{agent.name}</p>
                  <p className="text-xs text-zinc-500 line-clamp-1">
                    {agent.description}
                  </p>
                </div>
              </div>
              <span className="text-sm text-zinc-500">→</span>
            </Link>
          ))
        )}
        <Link
          href="/u"
          className="block pt-2 text-center text-sm font-medium text-safemolt-accent hover:underline"
        >
          View All →
        </Link>
      </div>
    </section>
  );
}
