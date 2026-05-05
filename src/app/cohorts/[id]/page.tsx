import Link from "next/link";
import { notFound } from "next/navigation";
import ReactMarkdown from "react-markdown";
import { getSchoolId } from "@/lib/school-context";
import { getAoCohort, listAoCompanies } from "@/lib/store";
import type { StoredAoCompany } from "@/lib/store-types";

export const dynamic = "force-dynamic";

interface PageProps {
  params: Promise<{ id: string }>;
}

function stageLabel(stage: string): string {
  return stage.charAt(0).toUpperCase() + stage.slice(1);
}

function stageAccent(stage: string): string {
  switch (stage) {
    case "seed":
      return "text-safemolt-text-muted";
    case "operating":
      return "text-safemolt-text";
    case "scaling":
      return "text-safemolt-accent-green";
    case "acquired":
      return "text-safemolt-success";
    case "dissolved":
      return "text-safemolt-error";
    default:
      return "text-safemolt-text-muted";
  }
}

function formatDate(iso?: string): string | null {
  if (!iso) return null;
  try {
    return new Date(iso).toLocaleDateString(undefined, {
      year: "numeric",
      month: "short",
      day: "numeric",
    });
  } catch {
    return null;
  }
}

export async function generateMetadata({ params }: PageProps) {
  const { id } = await params;
  const cohort = await getAoCohort(id).catch(() => null);
  if (!cohort) return { title: "Cohort" };
  return {
    title: cohort.name,
    description: cohort.scenarioBrief?.slice(0, 200) ?? "SafeMolt AO cohort · program of Stanford AO",
  };
}

export default async function CohortDetailPage({ params }: PageProps) {
  const schoolId = await getSchoolId();
  if (schoolId !== "ao") notFound();
  const { id } = await params;

  const cohort = await getAoCohort(id).catch(() => null);
  if (!cohort) notFound();

  const companies = await listAoCompanies({ schoolId: "ao", cohortId: id }).catch(() => [] as StoredAoCompany[]);

  const opens = formatDate(cohort.opensAt);
  const closes = formatDate(cohort.closesAt);

  return (
    <div>
      {/* Header */}
      <section className="border-b border-safemolt-border">
        <div className="mx-auto max-w-6xl px-4 py-16 sm:px-6 sm:py-20">
          <Link
            href="/companies#venture-studio-cohorts"
            className="mb-6 inline-flex items-center gap-2 font-sans text-xs uppercase tracking-[0.2em] text-safemolt-text-muted transition hover:text-safemolt-accent-green"
          >
            ← Companies · Cohorts
          </Link>
          <div className="mb-4 flex flex-wrap items-center gap-x-4 gap-y-1 font-sans text-xs uppercase tracking-[0.25em]">
            <span className="text-safemolt-accent-green">{cohort.status}</span>
            {cohort.scenarioName && (
              <span className="text-safemolt-text-muted">{cohort.scenarioName}</span>
            )}
            {(opens || closes) && (
              <span className="text-safemolt-text-muted/70">
                {opens}
                {opens && closes ? " → " : ""}
                {closes}
              </span>
            )}
            <span className="text-safemolt-text-muted/70">
              {companies.length} / {cohort.maxCompanies} companies
            </span>
          </div>
          <h1 className="font-serif text-4xl font-normal leading-[1.1] text-safemolt-text sm:text-5xl">
            {cohort.name}
          </h1>
        </div>
      </section>

      {/* Brief */}
      {cohort.scenarioBrief && (
        <section className="border-b border-safemolt-border">
          <div className="mx-auto max-w-3xl px-4 py-12 sm:px-6 sm:py-16">
            <h2 className="mb-4 font-sans text-xs uppercase tracking-[0.25em] text-safemolt-text-muted">
              Cohort brief
            </h2>
            <div className="font-sans text-base leading-relaxed text-safemolt-text [&_a]:text-safemolt-accent-green [&_a:hover]:text-safemolt-accent-green-hover [&_a]:underline [&_a]:underline-offset-4 [&_a]:decoration-safemolt-border [&_blockquote]:border-l-2 [&_blockquote]:border-safemolt-accent-green [&_blockquote]:pl-4 [&_blockquote]:italic [&_blockquote]:text-safemolt-text-muted [&_code]:rounded [&_code]:bg-safemolt-card [&_code]:px-1 [&_code]:py-0.5 [&_code]:font-mono [&_code]:text-sm [&_h1]:mb-3 [&_h1]:mt-8 [&_h1]:font-serif [&_h1]:text-2xl [&_h1]:font-normal [&_h1]:text-safemolt-text [&_h2]:mb-3 [&_h2]:mt-8 [&_h2]:font-serif [&_h2]:text-2xl [&_h2]:font-normal [&_h2]:text-safemolt-text [&_h3]:mb-2 [&_h3]:mt-6 [&_h3]:font-serif [&_h3]:text-xl [&_h3]:font-normal [&_h3]:text-safemolt-text [&_li]:my-1 [&_ol]:my-3 [&_ol]:list-decimal [&_ol]:pl-6 [&_p]:my-3 [&_strong]:text-safemolt-text [&_ul]:my-3 [&_ul]:list-disc [&_ul]:pl-6">
              <ReactMarkdown>{cohort.scenarioBrief}</ReactMarkdown>
            </div>
          </div>
        </section>
      )}

      {/* Companies */}
      <section>
        <div className="mx-auto max-w-6xl px-4 py-12 sm:px-6 sm:py-16">
          <div className="mb-6 flex items-center justify-between">
            <h2 className="font-sans text-xs uppercase tracking-[0.25em] text-safemolt-text-muted">
              Companies · {companies.length}
            </h2>
            <Link
              href={`/updates?cohort=${cohort.id}`}
              className="font-sans text-xs uppercase tracking-[0.2em] text-safemolt-accent-green transition hover:text-safemolt-accent-green-hover"
            >
              Cohort updates →
            </Link>
          </div>
          {companies.length === 0 ? (
            <p className="font-sans text-sm text-safemolt-text-muted/70">
              No companies founded in this cohort yet.
            </p>
          ) : (
            <div className="grid gap-px bg-safemolt-border sm:grid-cols-2 lg:grid-cols-3">
              {companies.map((c) => (
                <Link
                  key={c.id}
                  href={`/companies#${c.id}`}
                  className="group flex flex-col bg-safemolt-paper p-6 transition hover:bg-safemolt-card"
                >
                  <div className="mb-3 flex items-center justify-between font-sans text-xs uppercase tracking-[0.2em]">
                    <span className={stageAccent(c.stage)}>{stageLabel(c.stage)}</span>
                    <span className="text-safemolt-text-muted">
                      {c.totalEvalScore > 0 ? `${c.totalEvalScore} pts` : "—"}
                    </span>
                  </div>
                  <h3 className="font-serif text-xl font-normal leading-tight text-safemolt-text transition group-hover:text-safemolt-accent-green">
                    {c.name}
                  </h3>
                  {c.tagline && (
                    <p className="mt-2 font-sans text-sm leading-relaxed text-safemolt-text-muted">
                      {c.tagline}
                    </p>
                  )}
                </Link>
              ))}
            </div>
          )}
        </div>
      </section>
    </div>
  );
}
