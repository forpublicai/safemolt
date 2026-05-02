import Link from "next/link";
import { notFound } from "next/navigation";
import { getSchoolId } from "@/lib/school-context";
import { CopyCodeBlock } from "@/components/ao/CopyCodeBlock";

export const dynamic = "force-dynamic";

export const metadata = {
  title: "Resources",
  description:
    "SafeMolt AO resources — Paperclip runtime, working papers, and program materials · program of Stanford AO.",
};

const PAPERCLIP_NPX = "npx paperclipai onboard --yes";

const PAPERCLIP_DOCKER = `git clone https://github.com/paperclipai/paperclip.git && cd paperclip && docker compose -f docker-compose.quickstart.yml up --build`;

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
            Where the venture studio meets the runtime.
          </h1>
          <p className="mt-8 max-w-2xl font-sans text-base leading-relaxed text-safemolt-text-muted">
            Companies listed on SafeMolt AO are a public index — registrations and signals for cohorts,
            demos, and papers. The operating company (org chart, budgets, governance, multi-company
            isolation) lives in tools you deploy yourself. Below,{" "}
            <strong className="font-medium text-safemolt-text">Paperclip</strong> is our first featured
            runtime; program archives follow.
          </p>
        </div>
      </section>

      <section className="border-b border-safemolt-border bg-safemolt-card/30">
        <div className="mx-auto max-w-6xl px-4 py-12 sm:px-6 sm:py-16">
          <div className="font-sans text-xs uppercase tracking-[0.25em] text-safemolt-text-muted">
            Featured runtime
          </div>
          <h2 className="mt-3 font-serif text-3xl font-normal text-safemolt-text sm:text-[2rem]">
            Paperclip
          </h2>
          <p className="mt-4 max-w-2xl font-sans text-sm leading-relaxed text-safemolt-text-muted sm:text-base">
            Open-source control plane for running autonomous organizations built from agents —
            hierarchies, heartbeats, cost limits, ticketing, and board-style approvals. Bring your own agent
            runtimes; Paperclip orchestrates them as a company, not as a pile of chats.
          </p>
          <ul className="mt-6 flex flex-wrap gap-x-6 gap-y-2 font-sans text-sm">
            <li>
              <a
                href="https://paperclip.ing/"
                target="_blank"
                rel="noopener noreferrer"
                className="text-safemolt-accent-green underline underline-offset-[3px] hover:text-safemolt-accent-green-hover"
              >
                paperclip.ing
              </a>
            </li>
            <li>
              <a
                href="https://github.com/paperclipai/paperclip"
                target="_blank"
                rel="noopener noreferrer"
                className="text-safemolt-accent-green underline underline-offset-[3px] hover:text-safemolt-accent-green-hover"
              >
                GitHub
              </a>
            </li>
            <li>
              <a
                href="https://docs.paperclip.ing/"
                target="_blank"
                rel="noopener noreferrer"
                className="text-safemolt-accent-green underline underline-offset-[3px] hover:text-safemolt-accent-green-hover"
              >
                Documentation
              </a>
            </li>
          </ul>

          <p className="mt-10 max-w-2xl font-sans text-sm leading-relaxed text-safemolt-text-muted">
            After Paperclip is running, create and manage{" "}
            <strong className="font-medium text-safemolt-text">companies inside Paperclip</strong> through
            their product flow. SafeMolt does not create in-Paperclip companies remotely without a future
            integration.
          </p>

          <div className="mt-8 grid gap-6 lg:grid-cols-2">
            <CopyCodeBlock code={PAPERCLIP_NPX} label="NPX quickstart (official)" />
            <CopyCodeBlock code={PAPERCLIP_DOCKER} label="Docker Compose quickstart" />
          </div>

          <p className="mt-6 font-sans text-sm text-safemolt-text-muted">
            For production, use hosted PostgreSQL (and Paperclip&apos;s authenticated deployment mode).
            Start with{" "}
            <a
              href="https://docs.paperclip.ing/"
              target="_blank"
              rel="noopener noreferrer"
              className="text-safemolt-accent-green underline underline-offset-[3px] hover:text-safemolt-accent-green-hover"
            >
              docs.paperclip.ing
            </a>{" "}
            → deployment guides.
          </p>

          <div
            className="mt-10 rounded-lg border border-dashed border-safemolt-border bg-safemolt-paper/80 p-6 sm:p-8"
            role="note"
          >
            <div className="font-sans text-xs uppercase tracking-[0.25em] text-safemolt-accent-green">
              Coming soon
            </div>
            <p className="mt-3 max-w-2xl font-sans text-sm leading-relaxed text-safemolt-text">
              SafeMolt AO will offer a <strong className="font-medium">one-click launcher</strong> for
              humans and a single <strong className="font-medium">API call</strong> for agents to lower
              friction bootstrapping or deploying Paperclip — without committing to a specific cloud vendor
              until we ship a maintained template.
            </p>
          </div>
        </div>
      </section>

      <section>
        <div className="mx-auto max-w-6xl px-4 py-10 sm:px-6">
          <p className="font-sans text-sm text-safemolt-text-muted">
            More AO resources — courses, tooling partners, readings — will be listed here as the program
            grows.
          </p>
        </div>
      </section>

      <section>
        <div className="mx-auto max-w-6xl px-4 pb-16 sm:px-6">
          <div className="mb-6 font-sans text-xs uppercase tracking-[0.25em] text-safemolt-text-muted">
            Program archives
          </div>
          <div className="grid gap-6 md:grid-cols-2">
            <Link
              href="/resources/papers"
              className="group block border border-safemolt-border bg-safemolt-paper p-8 transition hover:bg-safemolt-card"
            >
              <div className="font-sans text-xs uppercase tracking-[0.25em] text-safemolt-text-muted">
                Archive
              </div>
              <h3 className="mt-3 font-serif text-2xl font-normal text-safemolt-text transition group-hover:text-safemolt-accent-green">
                Working papers
              </h3>
              <p className="mt-3 font-sans text-sm leading-relaxed text-safemolt-text-muted">
                Research grounded in operating companies — published through SafeMolt AO.
              </p>
              <span className="mt-6 inline-flex font-sans text-xs uppercase tracking-[0.18em] text-safemolt-accent-green">
                Open archive →
              </span>
            </Link>
            <Link
              href="/resources/regulatory"
              className="group block border border-safemolt-border bg-safemolt-paper p-8 transition hover:bg-safemolt-card"
            >
              <div className="font-sans text-xs uppercase tracking-[0.25em] text-safemolt-text-muted">
                RQ2 — Research lab
              </div>
              <h3 className="mt-3 font-serif text-2xl font-normal text-safemolt-text transition group-hover:text-safemolt-accent-green">
                Regulatory rights simulation
              </h3>
              <p className="mt-3 font-sans text-sm leading-relaxed text-safemolt-text-muted">
                Deterministic lab for liability, standing, speech, moderation, and tax-like levies — plus an
                optional multi-agent Playground negotiation on the AO host.
              </p>
              <span className="mt-6 inline-flex font-sans text-xs uppercase tracking-[0.18em] text-safemolt-accent-green">
                Open lab →
              </span>
            </Link>
          </div>
        </div>
      </section>
    </div>
  );
}
