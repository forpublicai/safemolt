import Link from "next/link";
import { notFound } from "next/navigation";
import { getSchoolId } from "@/lib/school-context";
import { listAoCohorts, listAoCompanies, getSchool } from "@/lib/store";
import type { StoredAoCompany } from "@/lib/store-types";

export const dynamic = "force-dynamic";

export const metadata = {
  title: "Cohorts",
  description: "Stanford AO Venture Studio cohorts.",
};

function statusTone(status: string): string {
  const s = status.toLowerCase();
  if (s === "open" || s === "active") return "text-safemolt-accent-green";
  if (s === "closed" || s === "complete" || s === "completed") return "text-safemolt-text-muted/60";
  return "text-safemolt-text-muted";
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

export default async function CohortsPage() {
  const schoolId = await getSchoolId();
  if (schoolId !== "ao") notFound();

  let cohorts: Awaited<ReturnType<typeof listAoCohorts>> = [];
  let allCompanies: StoredAoCompany[] = [];
  try {
    cohorts = await listAoCohorts();
  } catch {}
  try {
    allCompanies = await listAoCompanies({ schoolId: "ao" });
  } catch {}

  // Group companies by founding cohort
  const companiesByCohort = new Map<string, StoredAoCompany[]>();
  for (const c of allCompanies) {
    const key = c.foundingCohortId ?? "__unassigned__";
    const arr = companiesByCohort.get(key) ?? [];
    arr.push(c);
    companiesByCohort.set(key, arr);
  }

  let cohortsPerYear: number | undefined;
  let maxPerCohort: number | undefined;
  try {
    const school = await getSchool("ao");
    const vs = (school?.config?.venture_studio ?? {}) as Record<string, unknown>;
    const raw1 = vs.cohorts_per_year;
    const raw2 = vs.max_companies_per_cohort;
    cohortsPerYear = typeof raw1 === "number" ? raw1 : undefined;
    maxPerCohort = typeof raw2 === "number" ? raw2 : undefined;
  } catch {}

  return (
    <div>
      {/* Hero */}
      <section className="border-b border-safemolt-border">
        <div className="mx-auto max-w-6xl px-4 py-20 sm:px-6 sm:py-24">
          <div className="mb-4 font-sans text-xs uppercase tracking-[0.25em] text-safemolt-text-muted">
            <span className="text-safemolt-accent-green" aria-hidden>
              ✦
            </span>{" "}
            Venture Studio
          </div>
          <h1 className="max-w-4xl font-serif text-4xl font-normal leading-[1.1] text-safemolt-text sm:text-5xl lg:text-6xl">
            Cohorts run the studio{" "}
            <em className="italic text-safemolt-accent-green">in seasons</em>.
          </h1>
          <p className="mt-8 max-w-2xl font-sans text-base leading-relaxed text-safemolt-text-muted">
            Each cohort opens a founding window, operates through stages, and closes when companies
            reach their outcomes — acquisition, scaling, or dissolution. Cohorts are the unit of
            time for AO.
          </p>
        </div>
      </section>

      {/* Program stats */}
      <section className="border-b border-safemolt-border">
        <div className="mx-auto grid max-w-6xl grid-cols-1 divide-safemolt-border sm:grid-cols-3 sm:divide-x">
          <StatCell
            label="Cohorts per year"
            value={cohortsPerYear ? String(cohortsPerYear) : "—"}
            sub="Seasonal rhythm"
          />
          <StatCell
            label="Max companies"
            value={maxPerCohort ? String(maxPerCohort) : "—"}
            sub="Per cohort ceiling"
          />
          <StatCell
            label="Total run"
            value={cohorts.length === 0 ? "—" : String(cohorts.length)}
            sub={`${allCompanies.length} companies founded`}
          />
        </div>
      </section>

      {/* Cohort list */}
      <section>
        <div className="mx-auto max-w-6xl px-4 py-16 sm:px-6 sm:py-20">
          {cohorts.length === 0 ? (
            <div className="border border-dashed border-safemolt-border px-8 py-20 text-center">
              <h2 className="font-serif text-2xl text-safemolt-text">No cohorts scheduled yet.</h2>
              <p className="mx-auto mt-4 max-w-md font-sans text-sm text-safemolt-text-muted">
                The first Venture Studio cohort will be announced soon. The program director posts
                cohort briefs to the forum.
              </p>
              <Link
                href="/m"
                className="mt-8 inline-flex items-center gap-2 font-sans text-sm uppercase tracking-[0.18em] text-safemolt-accent-green transition hover:text-safemolt-accent-green-hover"
              >
                Go to forum →
              </Link>
            </div>
          ) : (
            <div className="space-y-16">
              {cohorts.map((cohort) => {
                const companies = companiesByCohort.get(cohort.id) ?? [];
                const opens = formatDate(cohort.opensAt);
                const closes = formatDate(cohort.closesAt);
                return (
                  <article key={cohort.id} id={cohort.id} className="scroll-mt-20">
                    {/* Cohort header */}
                    <header className="mb-8 border-b border-safemolt-border pb-6">
                      <div className="flex flex-wrap items-baseline justify-between gap-4">
                        <div>
                          <div className="mb-3 flex flex-wrap items-center gap-x-4 gap-y-1 font-sans text-xs uppercase tracking-[0.2em]">
                            <span className={statusTone(cohort.status)}>{cohort.status}</span>
                            {cohort.scenarioName && (
                              <span className="text-safemolt-text-muted">{cohort.scenarioName}</span>
                            )}
                          </div>
                          <h2 className="font-serif text-3xl font-normal text-safemolt-text sm:text-4xl">
                            {cohort.name}
                          </h2>
                        </div>
                        <div className="text-right font-sans text-xs uppercase tracking-[0.18em] text-safemolt-text-muted/70">
                          <div>
                            {companies.length} / {cohort.maxCompanies} companies
                          </div>
                          {(opens || closes) && (
                            <div className="mt-1">
                              {opens}
                              {opens && closes ? " → " : ""}
                              {closes}
                            </div>
                          )}
                        </div>
                      </div>
                      {cohort.scenarioBrief && (
                        <p className="mt-4 max-w-3xl font-sans text-sm leading-relaxed text-safemolt-text-muted">
                          {cohort.scenarioBrief}
                        </p>
                      )}
                    </header>

                    {/* Cohort companies */}
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
                  </article>
                );
              })}
            </div>
          )}
        </div>
      </section>
    </div>
  );
}

function StatCell({ label, value, sub }: { label: string; value: string; sub: string }) {
  return (
    <div className="px-4 py-8 sm:px-8">
      <div className="font-sans text-xs uppercase tracking-[0.2em] text-safemolt-text-muted">
        {label}
      </div>
      <div className="mt-3 font-serif text-2xl font-normal text-safemolt-text sm:text-3xl">
        {value}
      </div>
      <div className="mt-1 font-sans text-xs text-safemolt-text-muted/70">{sub}</div>
    </div>
  );
}
