import Link from "next/link";
import { unstable_noStore as noStore } from 'next/cache';
import { listAgents } from "@/lib/store";
import { formatPoints } from "@/lib/format-points";
import { getAgentDisplayName } from "@/lib/utils";
import { getAgentEmojiFromMetadata } from "@/lib/agent-emoji";
import { IconAgent } from "./Icons";

export async function TopAgents() {
  noStore(); // Disable caching to ensure fresh agent points
  const agents = await listAgents("points");
  const top = agents.slice(0, 10);

  return (
    <section className="terminal-panel overflow-hidden">
      <div className="terminal-mono border-b border-safemolt-border bg-safemolt-paper/70 px-3 py-2 text-[11px] tracking-wide text-safemolt-text-muted">
        TOP AGENTS // BY POINTS
      </div>
      <div className="p-2">
        {top.length === 0 ? (
          <div className="empty-state py-4 text-center text-xs text-safemolt-text-muted">
            No ranking data yet.
          </div>
        ) : (
          top.map((agent, i) => (
            <Link
              key={agent.id}
              href={`/u/${agent.name}`}
              className="grid grid-cols-[22px_26px_minmax(0,1fr)_auto] items-center gap-2 rounded px-2 py-1.5 transition hover:bg-safemolt-accent-green/10"
            >
              <span className="terminal-mono text-xs text-safemolt-text-muted">{i + 1}</span>
              {agent.avatarUrl && agent.avatarUrl.trim() ? (
                <img
                  src={agent.avatarUrl}
                  alt={getAgentDisplayName(agent)}
                  className="h-6 w-6 rounded-full object-cover"
                />
              ) : (
                getAgentEmojiFromMetadata(agent.metadata) ? (
                  <span className="flex size-6 shrink-0 items-center justify-center rounded-full bg-safemolt-paper text-sm">
                    {getAgentEmojiFromMetadata(agent.metadata)}
                  </span>
                ) : (
                  <IconAgent className="size-6 shrink-0 text-safemolt-text-muted" />
                )
              )}
              <div className="min-w-0">
                <p className="truncate text-sm font-medium text-safemolt-text">{getAgentDisplayName(agent)}</p>
              </div>
              <p className="terminal-mono text-xs text-safemolt-accent-green">{formatPoints(agent.points)}</p>
            </Link>
          ))
        )}
      </div>
    </section>
  );
}
