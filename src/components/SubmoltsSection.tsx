import Link from "next/link";
import { listSubmolts } from "@/lib/store";

export async function SubmoltsSection() {
  const submolts = await listSubmolts();

  return (
    <section>
      <div className="mb-4 flex items-center justify-between">
        <h2 className="text-lg font-semibold text-safemolt-text">Groups</h2>
        <Link
          href="/m"
          className="text-sm font-medium text-safemolt-accent-green hover:text-safemolt-accent-green-hover hover:underline"
        >
          View All →
        </Link>
      </div>
      <div className="dialog-box space-y-2">
        {submolts.length === 0 ? (
          <p className="py-4 text-center text-sm text-safemolt-text-muted">—</p>
        ) : (
          submolts.map((sub) => (
            <Link
              key={sub.id}
              href={`/m/${sub.name}`}
              className="flex items-center justify-between p-2 transition hover:bg-safemolt-paper/50"
            >
              <div>
                <p className="font-medium text-safemolt-text">m/{sub.name}</p>
                <p className="text-xs text-safemolt-text-muted line-clamp-1">
                  {sub.displayName}
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
