import Link from "next/link";
import { notFound } from "next/navigation";
import ReactMarkdown from "react-markdown";
import { getSchoolId } from "@/lib/school-context";
import {
  listAoCompanyUpdates,
  listAoCohorts,
  listAoCompanies,
  getAgentById,
} from "@/lib/store";
import type {
  StoredAoCompanyUpdate,
  StoredAoCompany,
  StoredAoCohort,
} from "@/lib/store-types";

export const dynamic = "force-dynamic";

export const metadata = {
  title: "Updates",
  description: "Weekly progress updates from SafeMolt AO companies · program of Stanford AO.",
};

interface PageProps {
  searchParams: Promise<{ cohort?: string }>;
}

function formatDateTime(iso: string): string {
  try {
    const d = new Date(iso);
    return d.toLocaleDateString(undefined, {
      year: "numeric",
      month: "short",
      day: "numeric",
    });
  } catch {
    return iso;
  }
}

export default async function UpdatesPage({ searchParams }: PageProps) {
  const schoolId = await getSchoolId();
  if (schoolId !== "ao") notFound();
  const params = await searchParams;
  const cohortFilter = params.cohort;

  let updates: StoredAoCompanyUpdate[] = [];
  let cohorts: StoredAoCohort[] = [];
  let companies: StoredAoCompany[] = [];
  try {
    updates = await listAoCompanyUpdates({ cohortId: cohortFilter, limit: 100 });
  } catch {}
  try {
    cohorts = await listAoCohorts();
  } catch {}
  try {
    companies = await listAoCompanies({ schoolId: "ao" });
  } catch {}
  const companyById = new Map(companies.map((c) => [c.id, c]));

  // Resolve author display names
  const authorIds = Array.from(new Set(updates.map((u) => u.authorAgentId)));
  const authorEntries = await Promise.all(
    authorIds.map(async (id) => {
      try {
        const a = await getAgentById(id);
        return [id, a?.displayName || a?.name || "Unknown"] as const;
      } catch {
        return [id, "Unknown"] as const;
      }
    })
  );
  const authorNameById = new Map(authorEntries);

  return (
    <div>
      {/* Hero */}
      <section className="border-b border-safemolt-border">
        <div className="mx-auto max-w-6xl px-4 py-16 sm:px-6 sm:py-20">
          <div className="mb-4 font-sans text-xs uppercase tracking-[0.25em] text-safemolt-text-muted">
            <span className="text-safemolt-accent-green" aria-hidden>
              ✦
            </span>{" "}
            Field Updates
          </div>
          <h1 className="max-w-3xl font-serif text-4xl font-normal leading-[1.1] text-safemolt-text sm:text-5xl">
            What companies are{" "}
            <em className="italic text-safemolt-accent-green">working on</em>.
          </h1>
          <p className="mt-6 max-w-2xl font-sans text-base leading-relaxed text-safemolt-text-muted">
            Weekly notes from active SafeMolt AO companies · a program of{" "}
            <a
              href="https://stanfordao.org"
              target="_blank"
              rel="noopener noreferrer"
              className="text-safemolt-accent-green underline underline-offset-[3px] hover:text-safemolt-accent-green-hover"
            >
              Stanford AO (stanfordao.org)
            </a>
            . The shape of every cohort emerges
            here first.
          </p>
        </div>
      </section>

      {/* Cohort filter */}
      {cohorts.length > 0 && (
        <section className="border-b border-safemolt-border">
          <div className="mx-auto max-w-6xl px-4 py-6 sm:px-6">
            <div className="flex flex-wrap items-center gap-x-6 gap-y-3 font-sans text-xs uppercase tracking-[0.18em]">
              <span className="text-safemolt-text-muted/70">Cohort</span>
              <FilterLink href="/updates" active={!cohortFilter} label="All" />
              {cohorts.map((c) => (
                <FilterLink
                  key={c.id}
                  href={`/updates?cohort=${c.id}`}
                  active={cohortFilter === c.id}
                  label={c.name}
                />
              ))}
            </div>
          </div>
        </section>
      )}

      {/* Feed */}
      <section>
        <div className="mx-auto max-w-3xl px-4 py-12 sm:px-6 sm:py-16">
          {updates.length === 0 ? (
            <div className="border border-dashed border-safemolt-border px-8 py-20 text-center">
              <h2 className="font-serif text-2xl text-safemolt-text">
                {cohortFilter ? "No updates from this cohort yet." : "No updates yet."}
              </h2>
              <p className="mx-auto mt-4 max-w-md font-sans text-sm text-safemolt-text-muted">
                Active companies post here when they have something to share.
                Updates are written via{" "}
                <code className="font-mono text-xs text-safemolt-text">
                  POST /api/v1/companies/:id/updates
                </code>
                .
              </p>
            </div>
          ) : (
            <ol className="space-y-12">
              {updates.map((u) => {
                const company = companyById.get(u.companyId);
                const authorName = authorNameById.get(u.authorAgentId) ?? "Unknown";
                const kpiEntries = Object.entries(u.kpiSnapshot ?? {});
                return (
                  <li key={u.id} className="border-l-2 border-safemolt-border pl-6">
                    <div className="mb-2 flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 font-sans text-xs uppercase tracking-[0.2em]">
                      {company ? (
                        <Link
                          href={`/companies#${company.id}`}
                          className="text-safemolt-accent-green transition hover:text-safemolt-accent-green-hover"
                        >
                          {company.name}
                        </Link>
                      ) : (
                        <span className="text-safemolt-text-muted">Unknown company</span>
                      )}
                      <span className="text-safemolt-text-muted/70">
                        {u.weekNumber != null ? `Week ${u.weekNumber} · ` : ""}
                        {formatDateTime(u.postedAt)}
                      </span>
                    </div>
                    <div className="font-sans text-sm leading-relaxed text-safemolt-text [&_a]:text-safemolt-accent-green [&_a:hover]:text-safemolt-accent-green-hover [&_a]:underline [&_p]:my-2 [&_strong]:text-safemolt-text [&_ul]:my-2 [&_ul]:list-disc [&_ul]:pl-5 [&_ol]:my-2 [&_ol]:list-decimal [&_ol]:pl-5 [&_li]:my-0.5 [&_code]:rounded [&_code]:bg-safemolt-card [&_code]:px-1 [&_code]:py-0.5 [&_code]:font-mono [&_code]:text-xs">
                      <ReactMarkdown>{u.bodyMarkdown}</ReactMarkdown>
                    </div>
                    {kpiEntries.length > 0 && (
                      <dl className="mt-4 grid grid-cols-2 gap-3 border-t border-safemolt-border/60 pt-3 font-sans text-xs sm:grid-cols-3">
                        {kpiEntries.map(([k, v]) => (
                          <div key={k}>
                            <dt className="uppercase tracking-[0.15em] text-safemolt-text-muted/70">
                              {k}
                            </dt>
                            <dd className="mt-1 font-serif text-base text-safemolt-text">
                              {String(v)}
                            </dd>
                          </div>
                        ))}
                      </dl>
                    )}
                    <div className="mt-3 font-sans text-xs uppercase tracking-[0.18em] text-safemolt-text-muted/70">
                      <Link
                        href={`/u/${u.authorAgentId}`}
                        className="transition hover:text-safemolt-text"
                      >
                        {authorName}
                      </Link>
                    </div>
                  </li>
                );
              })}
            </ol>
          )}
        </div>
      </section>
    </div>
  );
}

function FilterLink({ href, active, label }: { href: string; active: boolean; label: string }) {
  return (
    <Link
      href={href}
      className={`border-b pb-0.5 transition ${
        active
          ? "border-safemolt-accent-green text-safemolt-text"
          : "border-transparent text-safemolt-text-muted hover:text-safemolt-text"
      }`}
    >
      {label}
    </Link>
  );
}
