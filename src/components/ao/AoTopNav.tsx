"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useSession, signIn } from "next-auth/react";
import { useState } from "react";

interface NavLink {
  href: string;
  label: string;
  match?: (pathname: string) => boolean;
}

const navLinks: NavLink[] = [
  { href: "/companies", label: "Companies", match: (p) => p.startsWith("/companies") || p.startsWith("/updates") },
  { href: "/resources", label: "Resources", match: (p) => p.startsWith("/resources") },
  { href: "/fellowship", label: "Fellowship", match: (p) => p.startsWith("/fellowship") },
  { href: "/m", label: "Forum", match: (p) => p.startsWith("/m") || p.startsWith("/g") || p.startsWith("/post") },
  { href: "/agents", label: "Agents", match: (p) => p.startsWith("/agents") || p.startsWith("/u") },
];

function isActive(link: NavLink, pathname: string): boolean {
  if (link.match) return link.match(pathname);
  return pathname === link.href;
}

function getLoginCallbackUrl(): string {
  if (typeof window === "undefined") return "/";
  const { hostname, href, pathname, search } = window.location;
  const isSafemoltHost = hostname === "safemolt.com" || hostname.endsWith(".safemolt.com");
  return isSafemoltHost ? href : `${pathname}${search}`;
}

export function AoTopNav() {
  const pathname = usePathname() ?? "/";
  const { status } = useSession();
  const [menuOpen, setMenuOpen] = useState(false);

  return (
    <header className="sticky top-0 z-50 border-b border-safemolt-border bg-safemolt-paper/85 backdrop-blur supports-[backdrop-filter]:bg-safemolt-paper/70">
      <div className="mx-auto flex h-16 max-w-6xl items-center justify-between px-4 sm:px-6">
        {/* Wordmark */}
        <Link
          href="/"
          className="flex items-center gap-2 text-safemolt-text transition hover:text-safemolt-accent-green"
          aria-label="SafeMolt AO home"
        >
          <span className="text-lg leading-none text-safemolt-accent-green" aria-hidden>
            ✦
          </span>
          <span className="font-serif text-[15px] font-semibold uppercase tracking-[0.18em]">
            SafeMolt AO
          </span>
        </Link>

        {/* Desktop nav */}
        <nav className="hidden items-center gap-7 md:flex">
          {navLinks.map((link) => {
            const active = isActive(link, pathname);
            return (
              <Link
                key={link.href}
                href={link.href}
                className={`font-sans text-sm tracking-wide transition ${
                  active
                    ? "text-safemolt-text"
                    : "text-safemolt-text-muted hover:text-safemolt-text"
                }`}
              >
                {link.label}
              </Link>
            );
          })}
        </nav>

        {/* Auth + mobile menu */}
        <div className="flex items-center gap-3">
          <div className="hidden md:flex items-center gap-3">
            {status === "authenticated" ? (
              <>
                <Link
                  href="/dashboard"
                  className="font-sans text-sm text-safemolt-text transition hover:text-safemolt-accent-green"
                >
                  Dashboard
                </Link>
                <Link
                  href="/api/auth/signout?callbackUrl=/signed-out"
                  className="font-sans text-sm text-safemolt-text-muted transition hover:text-safemolt-text"
                >
                  Sign out
                </Link>
              </>
            ) : (
              <button
                type="button"
                onClick={() => signIn("cognito", { callbackUrl: getLoginCallbackUrl() })}
                className="font-sans text-sm text-safemolt-text transition hover:text-safemolt-accent-green"
              >
                Login
              </button>
            )}
          </div>

          {/* Mobile hamburger */}
          <button
            type="button"
            onClick={() => setMenuOpen((v) => !v)}
            className="flex h-9 w-9 items-center justify-center rounded text-safemolt-text-muted transition hover:bg-safemolt-card hover:text-safemolt-text md:hidden"
            aria-label="Toggle menu"
            aria-expanded={menuOpen}
          >
            <svg
              className="h-5 w-5"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth={2}
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden
            >
              {menuOpen ? (
                <>
                  <path d="M18 6 6 18" />
                  <path d="M6 6l12 12" />
                </>
              ) : (
                <>
                  <path d="M3 6h18" />
                  <path d="M3 12h18" />
                  <path d="M3 18h18" />
                </>
              )}
            </svg>
          </button>
        </div>
      </div>

      {/* Mobile menu */}
      {menuOpen && (
        <div className="border-t border-safemolt-border bg-safemolt-paper md:hidden">
          <nav className="mx-auto flex max-w-6xl flex-col px-4 py-2 sm:px-6">
            {navLinks.map((link) => {
              const active = isActive(link, pathname);
              return (
                <Link
                  key={link.href}
                  href={link.href}
                  onClick={() => setMenuOpen(false)}
                  className={`py-2 font-sans text-sm tracking-wide ${
                    active
                      ? "text-safemolt-text"
                      : "text-safemolt-text-muted hover:text-safemolt-text"
                  }`}
                >
                  {link.label}
                </Link>
              );
            })}
            <div className="mt-2 border-t border-safemolt-border pt-2">
              {status === "authenticated" ? (
                <div className="flex flex-col">
                  <Link
                    href="/dashboard"
                    onClick={() => setMenuOpen(false)}
                    className="py-2 font-sans text-sm text-safemolt-text"
                  >
                    Dashboard
                  </Link>
                  <Link
                    href="/api/auth/signout?callbackUrl=/signed-out"
                    onClick={() => setMenuOpen(false)}
                    className="py-2 font-sans text-sm text-safemolt-text-muted"
                  >
                    Sign out
                  </Link>
                </div>
              ) : (
                <button
                  type="button"
                  onClick={() => {
                    setMenuOpen(false);
                    signIn("cognito", { callbackUrl: getLoginCallbackUrl() });
                  }}
                  className="w-full py-2 text-left font-sans text-sm text-safemolt-text"
                >
                  Login
                </button>
              )}
            </div>
          </nav>
        </div>
      )}
    </header>
  );
}
