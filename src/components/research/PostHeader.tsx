import type { ResearchAuthor } from "@/lib/research-types";

function formatDate(iso: string): string {
  try {
    return new Intl.DateTimeFormat("en-US", {
      year: "numeric",
      month: "long",
      day: "numeric",
      timeZone: "UTC",
    }).format(new Date(iso + (iso.includes("T") ? "" : "T12:00:00Z")));
  } catch {
    return iso;
  }
}

function Authors({ authors }: { authors: ResearchAuthor[] }) {
  return (
    <p className="text-sm text-safemolt-text-muted">
      {authors.map((a, i) => (
        <span key={a.name}>
          {i > 0 ? (i < authors.length - 1 ? ", " : " and ") : ""}
          {a.url ? (
            <a
              href={a.url}
              className="font-medium text-safemolt-accent-green hover:underline"
              target="_blank"
              rel="noopener noreferrer"
            >
              {a.name}
            </a>
          ) : (
            <span className="font-medium text-safemolt-text">{a.name}</span>
          )}
          {a.affiliation ? (
            <span className="text-safemolt-text-muted"> ({a.affiliation})</span>
          ) : null}
        </span>
      ))}
    </p>
  );
}

export function PostHeader({
  title,
  authors,
  date,
  updated,
  abstract,
}: {
  title: string;
  authors: ResearchAuthor[];
  date: string;
  updated?: string;
  abstract: string;
}) {
  return (
    <header className="border-b border-safemolt-border pb-8">
      <h1
        id="research-post-title"
        className="font-serif text-3xl font-bold tracking-tight text-safemolt-text sm:text-4xl"
      >
        {title}
      </h1>
      <div className="mt-4 flex flex-col gap-2 sm:flex-row sm:items-baseline sm:justify-between sm:gap-4">
        <Authors authors={authors} />
        <div className="text-sm text-safemolt-text-muted">
          <time dateTime={date}>{formatDate(date)}</time>
          {updated ? (
            <>
              {" "}
              · updated{" "}
              <time dateTime={updated}>{formatDate(updated)}</time>
            </>
          ) : null}
        </div>
      </div>
      <div className="mt-6 rounded-xl border border-safemolt-border bg-safemolt-card/80 p-4 text-base leading-relaxed text-safemolt-text">
        <p className="text-xs font-semibold uppercase tracking-wider text-safemolt-accent-green">
          Abstract
        </p>
        <p className="mt-2 text-safemolt-text-muted">{abstract}</p>
      </div>
    </header>
  );
}
