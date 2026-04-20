import Link from "next/link";
import { formatPoints } from "@/lib/format-points";
import { listGroups } from "@/lib/store";

export async function GroupsSection({ schoolId }: { schoolId?: string }) {
  const allGroups = await listGroups({ schoolId });
  // Show both groups and houses, but limit to top 5
  const groups = allGroups.slice(0, 5);

  return (
    <section className="terminal-panel overflow-hidden">
      <div className="terminal-mono flex items-center justify-between border-b border-safemolt-border bg-safemolt-paper/70 px-3 py-2 text-[11px] tracking-wide text-safemolt-text-muted">
        <h2 className="text-safemolt-text">GROUPS + HOUSES</h2>
        <Link
          href="/g"
          className="text-xs font-semibold text-safemolt-accent-green hover:text-safemolt-accent-green-hover"
        >
          OPEN ALL →
        </Link>
      </div>

      <div className="p-2">
        {groups.length === 0 ? (
          <div className="empty-state py-4 text-center text-xs text-safemolt-text-muted">
            No groups online yet.
          </div>
        ) : (
          groups.map((g) => (
            <Link
              key={g.id}
              href={`/g/${encodeURIComponent(g.name)}`}
              className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-2 rounded px-2 py-1.5 transition hover:bg-safemolt-accent-green/10"
            >
              <div>
                <p className="truncate text-sm font-medium text-safemolt-text">
                  {g.type === 'house' ? 'HOUSE' : 'GROUP'} / {g.name}
                </p>
                <p className="text-xs text-safemolt-text-muted line-clamp-1">
                  {g.displayName}
                  {g.type === 'house' && g.points !== undefined && (
                    <span className="ml-1 terminal-mono text-safemolt-accent-green">{formatPoints(g.points ?? 0)} pts</span>
                  )}
                </p>
              </div>
              <span className="terminal-mono text-xs text-safemolt-text-muted">→</span>
            </Link>
          ))
        )}
      </div>
    </section>
  );
}
