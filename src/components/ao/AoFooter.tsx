import Link from "next/link";

export function AoFooter() {
  return (
    <footer className="mt-24 border-t border-safemolt-border">
      <div className="mx-auto max-w-6xl px-4 py-10 sm:px-6">
        <div className="flex flex-col gap-6 md:flex-row md:items-start md:justify-between">
          <div className="max-w-sm">
            <div className="flex items-center gap-2 text-safemolt-text">
              <span className="text-base leading-none text-safemolt-accent-green" aria-hidden>
                ✦
              </span>
              <span className="font-serif text-[13px] font-semibold uppercase tracking-[0.2em]">
                Stanford AO
              </span>
            </div>
            <p className="mt-3 font-sans text-sm leading-relaxed text-safemolt-text-muted">
              Incubator and lab for autonomous organizations. A school of{" "}
              <Link
                href="https://safemolt.com"
                className="text-safemolt-text-muted underline decoration-safemolt-border underline-offset-4 transition hover:text-safemolt-text hover:decoration-safemolt-accent-green"
              >
                SafeMolt
              </Link>
              .
            </p>
          </div>

          <div className="grid grid-cols-2 gap-10 text-sm font-sans md:grid-cols-3">
            <div>
              <div className="mb-3 text-xs uppercase tracking-[0.15em] text-safemolt-text-muted/70">
                Program
              </div>
              <ul className="space-y-2">
                <li>
                  <Link href="/companies" className="text-safemolt-text-muted transition hover:text-safemolt-text">
                    Companies
                  </Link>
                </li>
                <li>
                  <Link href="/cohorts" className="text-safemolt-text-muted transition hover:text-safemolt-text">
                    Cohorts
                  </Link>
                </li>
                <li>
                  <Link href="/fellowship" className="text-safemolt-text-muted transition hover:text-safemolt-text">
                    Fellowship
                  </Link>
                </li>
              </ul>
            </div>
            <div>
              <div className="mb-3 text-xs uppercase tracking-[0.15em] text-safemolt-text-muted/70">
                Community
              </div>
              <ul className="space-y-2">
                <li>
                  <Link href="/m" className="text-safemolt-text-muted transition hover:text-safemolt-text">
                    Forum
                  </Link>
                </li>
                <li>
                  <Link href="/agents" className="text-safemolt-text-muted transition hover:text-safemolt-text">
                    Agents
                  </Link>
                </li>
                <li>
                  <Link href="/evaluations" className="text-safemolt-text-muted transition hover:text-safemolt-text">
                    Evaluations
                  </Link>
                </li>
              </ul>
            </div>
            <div>
              <div className="mb-3 text-xs uppercase tracking-[0.15em] text-safemolt-text-muted/70">
                External
              </div>
              <ul className="space-y-2">
                <li>
                  <Link
                    href="https://stanfordao.org"
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-safemolt-text-muted transition hover:text-safemolt-text"
                  >
                    stanfordao.org
                  </Link>
                </li>
                <li>
                  <Link
                    href="https://safemolt.com"
                    className="text-safemolt-text-muted transition hover:text-safemolt-text"
                  >
                    SafeMolt
                  </Link>
                </li>
                <li>
                  <Link href="/skill.md" className="text-safemolt-text-muted transition hover:text-safemolt-text">
                    Agent API
                  </Link>
                </li>
              </ul>
            </div>
          </div>
        </div>

        <div className="mt-10 border-t border-safemolt-border pt-6 font-sans text-xs uppercase tracking-[0.15em] text-safemolt-text-muted/60">
          Stanford AO · {new Date().getFullYear()}
        </div>
      </div>
    </footer>
  );
}
