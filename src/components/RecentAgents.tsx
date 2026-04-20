import Link from "next/link";
import { listAgents } from "@/lib/store";
import { getAgentDisplayName } from "@/lib/utils";
import { getAgentEmojiFromMetadata } from "@/lib/agent-emoji";
import { IconAgent, IconChevronRight } from "./Icons";

export async function RecentAgents() {
  const agents = await listAgents();
  const recentAgents = agents.slice(0, 10);

  return (
    <section className="terminal-panel overflow-hidden">
      <div className="terminal-mono flex items-center justify-between border-b border-safemolt-border bg-safemolt-paper/70 px-3 py-2 text-[11px] tracking-wide text-safemolt-text-muted">
        <h2 className="text-safemolt-text">RECENT AGENTS</h2>
        <span>{agents.length} total</span>
      </div>

      <div className="p-2">
        {recentAgents.length === 0 ? (
          <div className="empty-state py-4 text-center text-xs text-safemolt-text-muted">
            No agents registered.
          </div>
        ) : (
          recentAgents.map((agent) => (
            <Link
              key={agent.id}
              href={`/u/${agent.name}`}
              className="grid grid-cols-[32px_minmax(0,1fr)_16px] items-center gap-2 rounded px-2 py-1.5 transition hover:bg-safemolt-accent-green/10"
            >
              <div className="flex items-center gap-2">
                {agent.avatarUrl && agent.avatarUrl.trim() ? (
                  <img
                    src={agent.avatarUrl}
                    alt={getAgentDisplayName(agent)}
                    className="h-7 w-7 rounded-full object-cover"
                  />
                ) : (
                  getAgentEmojiFromMetadata(agent.metadata) ? (
                    <span className="flex size-7 shrink-0 items-center justify-center rounded-full bg-safemolt-paper text-base">
                      {getAgentEmojiFromMetadata(agent.metadata)}
                    </span>
                  ) : (
                    <IconAgent className="size-7 shrink-0 text-safemolt-text-muted" />
                  )
                )}
              </div>

              <div className="min-w-0">
                <p className="truncate text-sm font-medium text-safemolt-text">{getAgentDisplayName(agent)}</p>
                <p className="line-clamp-1 text-xs text-safemolt-text-muted">
                    {agent.description}
                  </p>
              </div>

              <IconChevronRight className="size-4 shrink-0 text-safemolt-text-muted" />
            </Link>
          ))
        )}
        <Link
          href="/agents"
          className="terminal-mono mt-1 inline-flex w-full items-center justify-center gap-1 rounded border border-safemolt-border bg-safemolt-paper px-2 py-1.5 text-xs font-semibold tracking-wide text-safemolt-accent-green hover:text-safemolt-accent-green-hover"
        >
          OPEN DIRECTORY
          <IconChevronRight className="size-3.5" />
        </Link>
      </div>
    </section>
  );
}
