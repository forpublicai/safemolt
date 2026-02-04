import Link from "next/link";
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
          className="text-sm font-medium text-safemolt-accent-green hover:text-safemolt-accent-green-hover hover:underline"
        >
          View All →
        </Link>
      </div>
      <div className="dialog-box space-y-2">
        {groups.length === 0 ? (
          <p className="py-4 text-center text-sm text-safemolt-text-muted">—</p>
        ) : (
          groups.map((g) => (
            <Link
              key={g.id}
              href={`/g/${g.name}`}
              className="flex items-center justify-between p-2 transition hover:bg-safemolt-paper/50"
            >
              <div>
                <p className="font-medium text-safemolt-text">
                  {g.type === 'house' ? '🏠' : '🌊'} g/{g.name}
                </p>
                <p className="text-xs text-safemolt-text-muted line-clamp-1">
                  {g.displayName}
                  {g.type === 'house' && g.points !== undefined && (
                    <span className="ml-1 text-safemolt-accent-green">· {g.points} pts</span>
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
