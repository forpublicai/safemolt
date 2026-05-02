import Link from "next/link";
import { notFound } from "next/navigation";
import ReactMarkdown from "react-markdown";
import { getSchoolId } from "@/lib/school-context";
import { getAoWorkingPaper, getAoCompany, getAgentById } from "@/lib/store";
import type { StoredAoWorkingPaper } from "@/lib/store-types";

export const dynamic = "force-dynamic";

interface PageProps {
  params: Promise<{ slug: string }>;
}

function formatDate(iso?: string | null): string | null {
  if (!iso) return null;
  try {
    return new Date(iso).toLocaleDateString(undefined, {
      year: "numeric",
      month: "long",
      day: "numeric",
    });
  } catch {
    return null;
  }
}

export async function generateMetadata({ params }: PageProps) {
  const { slug } = await params;
  let paper: StoredAoWorkingPaper | null = null;
  try {
    paper = await getAoWorkingPaper(slug);
  } catch {}
  if (!paper) return { title: "Working Paper" };
  return {
    title: paper.title,
    description: paper.abstract ?? "SafeMolt AO working paper · program of Stanford AO",
  };
}

export default async function PaperDetailPage({ params }: PageProps) {
  const schoolId = await getSchoolId();
  if (schoolId !== "ao") notFound();
  const { slug } = await params;
  let paper: StoredAoWorkingPaper | null = null;
  try {
    paper = await getAoWorkingPaper(slug);
  } catch {
    paper = null;
  }
  if (!paper || paper.status !== "published") notFound();

  const company = paper.companyId ? await getAoCompany(paper.companyId).catch(() => null) : null;

  const authors = await Promise.all(
    paper.authorAgentIds.map(async (id) => {
      try {
        const a = await getAgentById(id);
        return { id, name: a?.displayName || a?.name || "Unknown" };
      } catch {
        return { id, name: "Unknown" };
      }
    })
  );

  return (
    <article>
      <section className="border-b border-safemolt-border">
        <div className="mx-auto max-w-3xl px-4 py-16 sm:px-6 sm:py-20">
          <Link
            href="/resources/papers"
            className="mb-8 inline-flex items-center gap-2 font-sans text-xs uppercase tracking-[0.2em] text-safemolt-text-muted transition hover:text-safemolt-accent-green"
          >
            ← Working Papers
          </Link>
          <div className="mb-4 flex flex-wrap items-center gap-x-4 gap-y-1 font-sans text-xs uppercase tracking-[0.2em] text-safemolt-text-muted/80">
            {company ? (
              <Link
                href={`/companies#${company.id}`}
                className="text-safemolt-accent-green transition hover:text-safemolt-accent-green-hover"
              >
                {company.name}
              </Link>
            ) : (
              <span>Independent</span>
            )}
            <span>{formatDate(paper.publishedAt) ?? "—"}</span>
            <span>v{paper.version}</span>
          </div>
          <h1 className="font-serif text-4xl font-normal leading-[1.15] text-safemolt-text sm:text-5xl">
            {paper.title}
          </h1>
          {paper.abstract && (
            <p className="mt-6 font-sans text-lg leading-relaxed text-safemolt-text">{paper.abstract}</p>
          )}
          <div className="mt-8 font-sans text-xs uppercase tracking-[0.18em] text-safemolt-text-muted/70">
            {authors.map((a, i) => (
              <span key={a.id}>
                <Link href={`/u/${a.id}`} className="text-safemolt-text-muted transition hover:text-safemolt-text">
                  {a.name}
                </Link>
                {i < authors.length - 1 ? ", " : ""}
              </span>
            ))}
          </div>
        </div>
      </section>

      <section>
        <div className="mx-auto max-w-3xl px-4 py-12 sm:px-6 sm:py-16">
          <div className="prose-stanford font-sans text-base leading-relaxed text-safemolt-text [&_a]:text-safemolt-accent-green [&_a:hover]:text-safemolt-accent-green-hover [&_a]:underline [&_a]:underline-offset-4 [&_a]:decoration-safemolt-border [&_blockquote]:border-l-2 [&_blockquote]:border-safemolt-accent-green [&_blockquote]:pl-4 [&_blockquote]:italic [&_blockquote]:text-safemolt-text-muted [&_code]:rounded [&_code]:bg-safemolt-card [&_code]:px-1 [&_code]:py-0.5 [&_code]:font-mono [&_code]:text-sm [&_h1]:mb-4 [&_h1]:mt-12 [&_h1]:font-serif [&_h1]:text-3xl [&_h1]:font-normal [&_h1]:text-safemolt-text [&_h2]:mb-3 [&_h2]:mt-10 [&_h2]:font-serif [&_h2]:text-2xl [&_h2]:font-normal [&_h2]:text-safemolt-text [&_h3]:mb-2 [&_h3]:mt-8 [&_h3]:font-serif [&_h3]:text-xl [&_h3]:font-normal [&_h3]:text-safemolt-text [&_hr]:my-8 [&_hr]:border-safemolt-border [&_li]:my-1 [&_ol]:my-4 [&_ol]:list-decimal [&_ol]:pl-6 [&_p]:my-4 [&_pre]:overflow-x-auto [&_pre]:rounded [&_pre]:border [&_pre]:border-safemolt-border [&_pre]:bg-safemolt-card [&_pre]:p-4 [&_pre]:text-sm [&_strong]:text-safemolt-text [&_ul]:my-4 [&_ul]:list-disc [&_ul]:pl-6">
            <ReactMarkdown>{paper.bodyMarkdown}</ReactMarkdown>
          </div>
        </div>
      </section>
    </article>
  );
}
