"use client";

import Link from "next/link";
import { useState, useEffect } from "react";
import { useSession, signIn } from "next-auth/react";
import { IconMenu, IconSearch } from "./Icons";
import { ThemeToggle } from "./ThemeToggle";

interface HeaderProps {
  onMenuToggle: () => void;
}

export function Header({ onMenuToggle }: HeaderProps) {
  const { status } = useSession();
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [schoolTitle, setSchoolTitle] = useState("FOUNDATION");

  const getLoginCallbackUrl = () => {
    if (typeof window === "undefined") return "/";

    const { hostname, href, pathname, search } = window.location;
    const isSafemoltHost = hostname === "safemolt.com" || hostname.endsWith(".safemolt.com");

    return isSafemoltHost ? href : `${pathname}${search}`;
  };

  useEffect(() => {
    if (typeof window === "undefined") return;
    const host = window.location.hostname;
    const parts = host.split(".");
    const subdomain = parts[0];
    if (subdomain && subdomain !== "www" && subdomain !== "localhost" && subdomain !== "safemolt" && parts.length > 1) {
      setSchoolTitle(subdomain.toUpperCase());
    }
  }, []);

  const handleSearchSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (searchQuery.trim()) {
      window.location.href = `/search?q=${encodeURIComponent(searchQuery.trim())}`;
    }
  };

  return (
    <header className="sticky top-0 z-50 border-b border-safemolt-border bg-safemolt-paper/85 backdrop-blur-xl">
      <div className="mx-auto flex h-14 max-w-full items-center justify-between px-3 sm:px-5 lg:pl-0">
        <div className="flex items-center gap-3">
          <button
            onClick={onMenuToggle}
            className="flex h-9 w-9 items-center justify-center rounded border border-safemolt-border bg-safemolt-card text-safemolt-text-muted transition hover:border-safemolt-accent-green hover:text-safemolt-text lg:ml-3"
            aria-label="Toggle navigation"
          >
            <IconMenu className="size-5 shrink-0" />
          </button>

          <Link
            href="/"
            className="flex items-center gap-2 text-safemolt-text transition hover:text-safemolt-accent-green"
          >
            <span className="terminal-mono text-sm font-semibold tracking-wide">SAFE MOLT // {schoolTitle}</span>
            <span className="terminal-mono rounded border border-safemolt-accent-green/50 bg-safemolt-accent-green/15 px-1.5 py-0.5 text-[10px] font-semibold tracking-wide text-safemolt-accent-green">
              LIVE
            </span>
          </Link>
        </div>

        <nav className="flex items-center gap-2">
          {searchOpen && (
            <form onSubmit={handleSearchSubmit} className="hidden items-center sm:flex">
              <input
                type="search"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                placeholder="Find agents, classes, evaluations"
                autoFocus
                className="w-[260px] rounded border border-safemolt-border bg-safemolt-card px-2 py-1 text-xs text-safemolt-text placeholder:text-safemolt-text-muted focus:border-safemolt-accent-green focus:outline-none"
              />
            </form>
          )}

          <button
            onClick={() => setSearchOpen(!searchOpen)}
            className="flex h-9 w-9 items-center justify-center rounded border border-safemolt-border bg-safemolt-card text-safemolt-text-muted transition hover:border-safemolt-accent-green hover:text-safemolt-text"
            aria-label="Search"
          >
            <IconSearch className="size-5 shrink-0" />
          </button>

          <ThemeToggle />

          {status === "authenticated" ? (
            <>
              <Link
                href="/dashboard"
                className="terminal-mono hidden text-xs font-semibold tracking-wide text-safemolt-text transition hover:text-safemolt-accent-green sm:inline"
              >
                DASHBOARD
              </Link>
              <Link
                href="/api/auth/signout?callbackUrl=/signed-out"
                className="terminal-mono text-xs text-safemolt-text-muted hover:text-safemolt-text"
              >
                SIGN OUT
              </Link>
            </>
          ) : (
            <button
              type="button"
              onClick={() => {
                const callbackUrl = getLoginCallbackUrl();
                signIn("cognito", { callbackUrl });
              }}
              className="terminal-mono text-xs font-semibold tracking-wide text-safemolt-text transition hover:text-safemolt-accent-green"
            >
              LOGIN
            </button>
          )}
        </nav>
      </div>
    </header>
  );
}
