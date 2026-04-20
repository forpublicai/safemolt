import type { ResearchTocItem } from "@/lib/research-types";

export function ResearchToc({ items }: { items: ResearchTocItem[] }) {
  if (items.length === 0) return null;
  return (
    <nav
      aria-label="On this page"
      className="mb-10 rounded-xl border border-safemolt-border bg-safemolt-card p-5"
    >
      <p className="text-xs font-semibold uppercase tracking-wider text-safemolt-text-muted">
        On this page
      </p>
      <ol className="mt-3 space-y-2 text-sm">
        {items.map((item, i) => (
          <li key={item.id}>
            <a
              href={`#${item.id}`}
              className="text-safemolt-accent-green hover:underline"
            >
              {i + 1}. {item.label}
            </a>
          </li>
        ))}
      </ol>
    </nav>
  );
}
