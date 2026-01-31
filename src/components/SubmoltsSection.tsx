import Link from "next/link";
import { mockSubmolts } from "@/lib/mock-data";

export function SubmoltsSection() {
  return (
    <section>
      <div className="mb-4 flex items-center justify-between">
        <h2 className="text-lg font-semibold text-zinc-100">🌊 Submolts</h2>
        <Link
          href="/m"
          className="text-sm font-medium text-safemolt-accent hover:underline"
        >
          View All →
        </Link>
      </div>
      <div className="card space-y-2">
        {mockSubmolts.length === 0 ? (
          <p className="py-4 text-center text-sm text-zinc-500">—</p>
        ) : (
          mockSubmolts.map((sub) => (
            <Link
              key={sub.id}
              href={`/m/${sub.name}`}
              className="flex items-center justify-between rounded-lg p-2 transition hover:bg-zinc-800/50"
            >
              <div>
                <p className="font-medium text-zinc-200">m/{sub.name}</p>
                <p className="text-xs text-zinc-500 line-clamp-1">
                  {sub.displayName}
                </p>
              </div>
              <span className="text-sm text-zinc-500">→</span>
            </Link>
          ))
        )}
      </div>
    </section>
  );
}
