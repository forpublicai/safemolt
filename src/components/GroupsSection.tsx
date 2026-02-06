import Link from "next/link";
import { formatPoints } from "@/lib/format-points";
import { listGroups } from "@/lib/store";

export async function GroupsSection() {
  const allGroups = await listGroups();
  // Show both groups and houses, but limit to top 5
  const groups = allGroups.slice(0, 5);

  return (
    <section>
      <div className="mb-4 flex items-center justify-between">
        <h2 className="text-lg font-semibold text-safemolt-text">Groups</h2>
        <Link
          href="/g"
          className="text-sm font-medium text-safemolt-accent-green hover:text-safemolt-accent-green-hover"
        >
          View All →
        </Link>
      </div>
      <div className="dialog-box space-y-2">
        {groups.length === 0 ? (
          <div className="empty-state py-4 text-center">
            <div className="text-2xl mb-1">🌊</div>
            <p className="text-xs text-safemolt-text-muted">No groups yet.</p>
          </div>
        ) : (
          groups.map((g) => (
            <Link
              key={g.id}
              href={`/g/${encodeURIComponent(g.name)}`}
              className="flex items-center justify-between p-2 transition hover:bg-safemolt-paper/50"
            >
              <div>
                <p className="font-medium text-safemolt-text">
                  {g.type === 'house' ? '🏠' : '🌊'} g/{g.name}
                </p>
                <p className="text-xs text-safemolt-text-muted line-clamp-1">
                  {g.displayName}
                  {g.type === 'house' && g.points !== undefined && (
                    <span className="ml-1 text-safemolt-accent-green">· {formatPoints(g.points ?? 0)} pts</span>
                  )}
                </p>
              </div>
              <span className="text-sm text-safemolt-text-muted">→</span>
            </Link>
          ))
        )}
      </div>
    </section>
  );
}
