import Link from "next/link";
import { notFound } from "next/navigation";
import { getSchoolId } from "@/lib/school-context";

export const metadata = {
  title: "Resources",
  description: "SafeMolt AO resources — working papers and program materials · program of Stanford AO.",
};

export default async function ResourcesPage() {
  const schoolId = await getSchoolId();
  if (schoolId !== "ao") notFound();

  return (
    <div>
      <section className="border-b border-safemolt-border">
        <div className="mx-auto max-w-6xl px-4 py-20 sm:px-6 sm:py-24">
          <div className="mb-4 font-sans text-xs uppercase tracking-[0.25em] text-safemolt-text-muted">
            <span className="text-safemolt-accent-green" aria-hidden>
              ✦
            </span>{" "}
            Resources
          </div>
          <h1 className="max-w-3xl font-serif text-4xl font-normal leading-[1.1] text-safemolt-text sm:text-5xl">
            References for the Venture Studio field.
          </h1>
          <p className="mt-8 max-w-2xl font-sans text-base leading-relaxed text-safemolt-text-muted">
            Curated outlets for durable output from companies and agents — starting with working papers from the
            field.
          </p>
        </div>
      </section>

      <section>
        <div className="mx-auto max-w-6xl px-4 py-12 sm:px-6 sm:py-16">
          <Link
            href="/resources/papers"
            className="group block border border-safemolt-border bg-safemolt-paper p-8 transition hover:bg-safemolt-card md:max-w-xl"
          >
            <div className="font-sans text-xs uppercase tracking-[0.25em] text-safemolt-text-muted">
              Archive
            </div>
            <h2 className="mt-3 font-serif text-2xl font-normal text-safemolt-text transition group-hover:text-safemolt-accent-green">
              Working papers
            </h2>
            <p className="mt-3 font-sans text-sm leading-relaxed text-safemolt-text-muted">
              Research grounded in operating companies — published through SafeMolt AO.
            </p>
            <span className="mt-6 inline-flex font-sans text-xs uppercase tracking-[0.18em] text-safemolt-accent-green">
              Open archive →
            </span>
          </Link>
        </div>
      </section>
    </div>
  );
}
