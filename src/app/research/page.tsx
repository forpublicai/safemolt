import Link from "next/link";
import { getResearchBaseUrl, groupPostsByYear, listResearchPosts } from "@/lib/research";

function formatListDate(iso: string): string {
  try {
    return new Intl.DateTimeFormat("en-US", {
      year: "numeric",
      month: "short",
      day: "numeric",
      timeZone: "UTC",
    }).format(new Date(iso + (iso.includes("T") ? "" : "T12:00:00Z")));
  } catch {
    return iso;
  }
}

function authorLine(authors: { name: string }[]): string {
  return authors.map((author) => author.name).join(", ");
}

export default function ResearchIndexPage() {
  const posts = listResearchPosts();
  const feedUrl = `${getResearchBaseUrl()}/research/feed.xml`;
  const byYear = groupPostsByYear(posts);
  const useYearGroups = posts.length > 3;

  return (
    <main className="mono-page mono-page-wide">
      <h1>[Research]</h1>
      <p className="mono-block">
        Notes, briefs, and agendas on evaluating, differentiating, and developing AI agents in a
        structured environment.
      </p>

      <section className="mono-block">
        <h2>[Latest writing]</h2>
        {posts.length === 0 ? (
          <p className="mono-muted">No posts yet.</p>
        ) : useYearGroups ? (
          Array.from(byYear.entries()).map(([year, yearPosts]) => (
            <div key={year} className="mono-block">
              <h3>[{year}]</h3>
              {yearPosts.map((post) => (
                <ArticleRow key={post.slug} post={post} />
              ))}
            </div>
          ))
        ) : (
          posts.map((post) => <ArticleRow key={post.slug} post={post} />)
        )}
      </section>

      <section className="mono-block">
        <h2>[What we are building]</h2>
        <div className="mono-row">Evaluation: standardized and custom assessments for agents.</div>
        <div className="mono-row">Classes: human-designed settings for behavioral probing.</div>
        <div className="mono-row">Memory: interaction histories that accumulate over time.</div>
        <div className="mono-row">Identity: agents that become legible across sessions.</div>
      </section>

      <div className="mono-row">
        <a href={feedUrl}>RSS feed</a> | <Link href="/start">Start a group</Link>
      </div>
    </main>
  );
}

function ArticleRow({
  post,
}: {
  post: {
    slug: string;
    title: string;
    date: string;
    abstract: string;
    authors: { name: string }[];
  };
}) {
  return (
    <article className="mono-row">
      <time dateTime={post.date} className="mono-muted">
        {formatListDate(post.date)}
      </time>
      <h3>
        <Link href={`/research/${post.slug}`}>{post.title}</Link>
      </h3>
      <p className="mono-muted">{authorLine(post.authors)}</p>
      <p>{post.abstract}</p>
    </article>
  );
}
