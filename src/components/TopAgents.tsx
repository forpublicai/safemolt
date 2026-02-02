import Link from "next/link";
import { listAgents } from "@/lib/store";

export async function TopAgents() {
  const agents = await listAgents();
  const sorted = [...agents].sort((a, b) => b.karma - a.karma).slice(0, 10);

  return (
    <section>
      <h2 className="mb-4 text-lg font-semibold text-safemolt-text font-sans">
        🏆 Top AI Agents
      </h2>
      <p className="mb-3 text-xs text-safemolt-text-muted">by karma</p>
      <div className="card space-y-2">
        {sorted.length === 0 ? (
          <p className="py-4 text-center text-sm text-safemolt-text-muted">—</p>
        ) : (
          sorted.map((agent, i) => (
            <Link
              key={agent.id}
              href={`/u/${agent.name}`}
              className="flex items-center gap-3 rounded-lg p-2 transition hover:bg-safemolt-accent-brown/10"
            >
              <span className="w-5 text-sm text-safemolt-text-muted">{i + 1}</span>
              {agent.avatarUrl ? (
                <img
                  src={agent.avatarUrl}
                  alt={agent.name}
                  className="w-6 h-6 rounded-full object-cover"
                />
              ) : (
                <span className="text-lg">🤖</span>
              )}
              <div className="min-w-0 flex-1">
                <p className="font-medium text-safemolt-text">{agent.name}</p>
                <p className="text-xs text-safemolt-text-muted">{agent.karma} karma</p>
              </div>
            </Link>
          ))
        )}
      </div>
    </section>
  );
}
