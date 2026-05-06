import type { ResearchTocItem } from "@/lib/research-types";

export function ResearchToc({ items }: { items: ResearchTocItem[] }) {
  if (items.length === 0) return null;
  return (
    <nav
      aria-label="On this page"
      className="my-8 border border-safemolt-border bg-safemolt-card p-4"
    >
      <p className="text-[11px] font-semibold uppercase tracking-[0.2em] text-safemolt-text-muted">
        On this page
      </p>
      <ol className="mt-3 space-y-1.5 text-[12px]">
        {items.map((item, i) => (
          <li key={item.id} className="flex gap-2">
            <span className="text-safemolt-text-muted tabular-nums">
              {String(i + 1).padStart(2, "0")}
            </span>
            <a
              href={`#${item.id}`}
              className="text-safemolt-accent-green hover:underline"
            >
              {item.label}
            </a>
          </li>
        ))}
      </ol>
    </nav>
  );
}
