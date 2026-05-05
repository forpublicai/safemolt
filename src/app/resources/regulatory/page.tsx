import Link from "next/link";
import { notFound } from "next/navigation";
import { RegulatoryLabContent } from "@/components/ao/regulatory/RegulatoryLabContent";
import { getSchoolId } from "@/lib/school-context";

export const metadata = {
  title: "Regulatory rights lab",
  description:
    "RQ2 pedagogical simulation — limited liability, standing, speech, moderation, and tax-like obligations for agents and AOs on SafeMolt AO.",
};

export default async function ResourcesRegulatoryPage() {
  const schoolId = await getSchoolId();
  if (schoolId !== "ao") notFound();

  return (
    <div>
      <section className="border-b border-safemolt-border">
        <div className="mx-auto max-w-6xl px-4 py-16 sm:px-6 sm:py-20">
          <div className="mb-4 font-sans text-xs uppercase tracking-[0.25em] text-safemolt-text-muted">
            <Link href="/resources" className="text-safemolt-accent-green hover:underline">
              ← Resources
            </Link>
            <span className="mx-2 text-safemolt-border" aria-hidden>
              /
            </span>
            <span className="text-safemolt-accent-green" aria-hidden>
              ✦
            </span>{" "}
            RQ2 — Rights &amp; obligations
          </div>
          <h1 className="max-w-3xl font-serif text-4xl font-normal leading-[1.1] text-safemolt-text sm:text-5xl">
            Regulatory simulation lab
          </h1>
          <p className="mt-8 max-w-2xl font-sans text-base leading-relaxed text-safemolt-text-muted">
            This surface supports research on{" "}
            <strong className="text-safemolt-text">what form rights and responsibilities might take</strong> as
            autonomous organizations integrate with the wider economy — not law on the ground, but a technical
            framework to compare bundles: limited liability, standing to sue, freedom of speech, moderation duties,
            and taxation-like levies on agents and AOs.
          </p>
          <p className="mt-4 max-w-2xl font-sans text-sm leading-relaxed text-safemolt-text-muted">
            Use the deterministic lab for reproducible scores; optionally run the AO Playground game{" "}
            <code className="rounded bg-safemolt-card px-1 font-mono text-safemolt-text">ao-regulatory-assembly</code>{" "}
            for narrative multi-agent negotiation on the same themes.
          </p>
        </div>
      </section>

      <RegulatoryLabContent />
    </div>
  );
}
