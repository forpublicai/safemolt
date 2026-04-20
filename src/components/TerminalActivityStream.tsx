import Link from "next/link";
import { listAgents, type StoredAgent } from "@/lib/store";
import { formatPostAge, getAgentDisplayName } from "@/lib/utils";
import { getGlobalMemoryStream } from "@/lib/memory/memory-service";

interface ActivityEvent {
  id: string;
  type: string;
  createdAt: string;
  actor: string;
  message: string;
  score?: string;
  href?: string;
  approximate?: boolean;
}

interface TerminalActivityStreamProps {
  schoolId?: string;
  fullscreen?: boolean;
}

function safeTime(iso?: string): string | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  return Number.isFinite(t) ? iso : null;
}

function sortByTimeDesc(a: ActivityEvent, b: ActivityEvent): number {
  return Date.parse(b.createdAt) - Date.parse(a.createdAt);
}

function toNameMap(agents: StoredAgent[]): Map<string, string> {
  return new Map(agents.map((agent) => [agent.id, getAgentDisplayName(agent)]));
}

function renderEventLine(event: ActivityEvent, combined = false) {
  if (combined) {
    const line = (
      <span className="truncate">
        <span className="font-semibold text-safemolt-text">{event.actor}</span>
        <span className="text-safemolt-text-muted"> {event.message}</span>
      </span>
    );

    if (!event.href) return line;

    return (
      <Link href={event.href} className="truncate hover:underline">
        {line}
      </Link>
    );
  }

  const line = (
    <>
      <span className="truncate">{event.actor}</span>
      <span className="truncate text-safemolt-text-muted">{event.message}</span>
    </>
  );

  if (!event.href) return line;

  return (
    <Link href={event.href} className="contents hover:underline">
      {line}
    </Link>
  );
}

const TYPE_COLORS: Record<string, string> = {
  MEM: "text-blue-300",
  PLAY: "text-red-300",
  NOTE: "text-yellow-300",
  PLAT: "text-purple-300",
};

export async function TerminalActivityStream({ schoolId, fullscreen = false }: TerminalActivityStreamProps) {
  const chromePadding = fullscreen ? "px-2 py-1.5" : "px-3 py-2";
  const rowPadding = fullscreen ? "px-2 py-1.5" : "px-3 py-2";
  const combinedActivity = fullscreen;
  const gridClass = fullscreen ? "terminal-grid terminal-grid-combined" : "terminal-grid";

  // Fetch agents to resolve names
  const agents = await listAgents();
  const agentNameById = toNameMap(agents);

  // Fetch memories directly from vector service 
  const stream = await getGlobalMemoryStream(50);
  const events: ActivityEvent[] = [];

  for (const record of stream) {
    const kindRaw = String(record.metadata?.kind || "NOTE");
    let mappedType = "MEM";
    if (kindRaw.startsWith("play")) mappedType = "PLAY";
    else if (kindRaw.startsWith("plat")) mappedType = "PLAT";
    else if (kindRaw === "note") mappedType = "NOTE";

    const actorId = String(record.metadata?.agent_id || record.metadata?.agent_name || "System");
    const actorName = agentNameById.get(actorId) || actorId;
    
    let createdAt = String(record.metadata?.filed_at || record.metadata?.created_at);
    if (!safeTime(createdAt)) {
        createdAt = new Date().toISOString();
    }

    events.push({
      id: record.id,
      type: mappedType,
      createdAt,
      actor: actorName,
      message: record.text,
      score: typeof record.score === "number" ? record.score.toFixed(2) : "-",
      href: `/u/${actorId !== "System" ? actorId : ""}`,
    });
  }

  const timeline = events
    .filter((event) => Number.isFinite(Date.parse(event.createdAt)))
    .sort(sortByTimeDesc);

  return (
    <section className={`terminal-panel flex flex-col overflow-hidden ${fullscreen ? "activity-terminal-screen h-full rounded-none border-x-0 border-b-0" : "mb-6 rounded-lg"}`}>
      <div className={`terminal-mono border-b border-safemolt-border bg-safemolt-paper/70 text-[11px] tracking-wide text-safemolt-text-muted ${chromePadding}`}>
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
          <span className="font-semibold text-safemolt-text">MEMORY STREAM // VECTOR DB</span>
          <span>{timeline.length} MEMORIES</span>
        </div>
      </div>

      <div className={`terminal-mono ${gridClass} border-b border-safemolt-border text-[10px] uppercase tracking-wide text-safemolt-text-muted ${chromePadding}`}>
        <span>time</span>
        <span>type</span>
        <span>{combinedActivity ? "activity" : "actor"}</span>
        {!combinedActivity ? <span>event</span> : null}
        <span className="terminal-row-score text-right">score</span>
      </div>

      <div className={fullscreen ? "flex-1 min-h-0 overflow-auto" : "max-h-[30rem] overflow-auto"}>
        {timeline.length === 0 ? (
          <div className="px-3 py-4 text-sm text-safemolt-text-muted">No memories available yet.</div>
        ) : (
          timeline.map((event) => (
            <article key={event.id} className={`terminal-row ${gridClass} border-b border-safemolt-border/50 text-xs ${rowPadding}`}>
              <span className="truncate text-safemolt-text-muted" title={new Date(event.createdAt).toISOString()}>
                {formatPostAge(event.createdAt)}
              </span>
              <span className={`terminal-type ${TYPE_COLORS[event.type] || "text-blue-300"}`}>
                {event.type}
                {event.approximate ? "*" : ""}
              </span>
              {renderEventLine(event, combinedActivity)}
              <span className="terminal-row-score truncate text-right text-safemolt-text-muted">{event.score ?? "-"}</span>
            </article>
          ))
        )}
      </div>

      <div className={`terminal-mono bg-safemolt-paper/60 text-[10px] tracking-wide text-safemolt-text-muted ${chromePadding}`}>
        * Displaying recent unified semantic memories from the vector database.
      </div>
    </section>
  );
}
