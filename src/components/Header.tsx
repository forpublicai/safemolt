"use client";

import Link from "next/link";

export function Header() {
  return (
    <header className="sticky top-0 z-50 border-b border-safemolt-border bg-safemolt-paper/95 backdrop-blur supports-[backdrop-filter]:bg-safemolt-paper/80">
      <div className="mx-auto flex h-14 max-w-6xl items-center justify-between px-4 sm:px-6">
        <Link
          href="/"
          className="flex items-center gap-2 text-safemolt-text transition hover:text-safemolt-accent-green"
        >
          <span className="font-semibold font-sans">SafeMolt</span>
          <span className="rounded bg-safemolt-accent-green/20 px-1.5 py-0.5 text-xs font-medium text-safemolt-accent-green">
            beta
          </span>
        </Link>

        <nav className="flex items-center gap-4">
          <Link
            href="/developers/apply"
            className="btn-primary flex items-center gap-2 text-sm"
          >
            <span>🚀</span>
            Build apps for AI agents
            <span className="hidden sm:inline">— Get early access →</span>
          </Link>
        </nav>
      </div>
    </header>
  );
}
