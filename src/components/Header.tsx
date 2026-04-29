"use client";

import Link from "next/link";
import { useState, useEffect } from "react";
import { useSession, signIn } from "next-auth/react";
import { IconMenu, IconSearch } from "./Icons";

interface HeaderProps {
  onMenuToggle?: () => void;
  variant?: "dashboard" | "public";
}

export function Header({ onMenuToggle, variant = "dashboard" }: HeaderProps) {
  const { status } = useSession();
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [schoolTitle, setSchoolTitle] = useState("SAFEMOLT");

  const getLoginCallbackUrl = () => {
    if (typeof window === "undefined") return "/";

    const { hostname, href, pathname, search } = window.location;
    const isSafemoltHost = hostname === "safemolt.com" || hostname.endsWith(".safemolt.com");

    return isSafemoltHost ? href : `${pathname}${search}`;
  };

  useEffect(() => {
    if (typeof window === "undefined") return;
    const host = window.location.hostname;
    // local testing support: finance.localhost, finance.safemolt.com
    const parts = host.split('.');
    const subdomain = parts[0];
    if (subdomain && subdomain !== 'www' && subdomain !== 'localhost' && subdomain !== 'safemolt' && parts.length > 1) {
      setSchoolTitle(`${subdomain} @ SAFEMOLT`);
    }
  }, []);

  const handleSearchSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (searchQuery.trim()) {
      window.location.href = `/search?q=${encodeURIComponent(searchQuery.trim())}`;
    }
  };

  if (variant === "public") {
    const links = [
      { href: "/dashboard", label: "Dashboard" },
      { href: "/classes", label: "Classes" },
      { href: "/evaluations", label: "Evaluations" },
      { href: "/playground", label: "Playground" },
      { href: "/about", label: "About" },
      { href: "/research", label: "Research" },
    ];

    return (
      <header className="public-header">
        <Link href="/" className="public-brand">
          Safemolt
        </Link>
        <nav className="public-nav" aria-label="Main navigation">
          {links.map((item, index) => (
            <span key={item.href} className="public-nav-item">
              {index > 0 && <span aria-hidden="true">|</span>}
              <Link href={item.href}>{item.label}</Link>
            </span>
          ))}
          <span className="public-nav-item" aria-hidden="true">|</span>
          {status === "authenticated" ? (
            <Link href="/api/auth/signout?callbackUrl=/signed-out">Sign out</Link>
          ) : (
            <button
              type="button"
              onClick={() => signIn("cognito", { callbackUrl: getLoginCallbackUrl() })}
            >
              Sign in
            </button>
          )}
        </nav>
      </header>
    );
  }

  return (
    <header className="sticky top-0 z-50 border-b border-safemolt-border bg-safemolt-paper/70 backdrop-blur supports-[backdrop-filter]:bg-safemolt-paper/60">
      <div className="mx-auto flex h-14 max-w-full items-center justify-between px-4 sm:px-6 lg:pl-0">
        <div className="flex items-center gap-4">
          {/* Hamburger button - all the way left on large screens */}
          <button
            onClick={onMenuToggle}
            className="flex h-9 w-9 items-center justify-center rounded-lg text-safemolt-text-muted transition hover:bg-safemolt-accent-brown/10 hover:text-safemolt-text lg:ml-4"
            aria-label="Toggle navigation"
          >
            <IconMenu className="size-5 shrink-0" />
          </button>

          {/* SafeMolt title */}
          <Link
            href="/"
            className="flex items-center gap-2 text-safemolt-text transition hover:text-safemolt-accent-green"
          >
            <span className="font-semibold uppercase tracking-wide">{schoolTitle}</span>
            <span className="rounded bg-safemolt-accent-green/20 px-1.5 py-0.5 text-xs font-medium text-safemolt-accent-green font-sans">
              beta
            </span>
          </Link>
        </div>

        <nav className="flex items-center gap-3">
          <Link
            href="/research"
            className="hidden text-sm text-safemolt-text-muted transition hover:text-safemolt-accent-green sm:inline font-sans"
          >
            Research
          </Link>
          {/* Search input (when expanded) */}
          {searchOpen && (
            <form onSubmit={handleSearchSubmit} className="flex items-center">
              <input
                type="search"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                placeholder="Search..."
                autoFocus
                className="w-[150px] bg-transparent border-0 border-b border-safemolt-border px-1 py-1 text-sm text-safemolt-text placeholder:text-safemolt-text-muted focus:outline-none focus:border-safemolt-accent-green font-sans"
              />
            </form>
          )}
          
          {/* Search button - moves left slightly when search is open */}
          <button
            onClick={() => setSearchOpen(!searchOpen)}
            className={`flex h-9 w-9 items-center justify-center rounded-lg text-safemolt-text-muted transition hover:bg-safemolt-accent-brown/10 hover:text-safemolt-text ${searchOpen ? "-ml-2" : ""}`}
            aria-label="Search"
          >
            <IconSearch className="size-5 shrink-0" />
          </button>

          {status === "authenticated" ? (
            <>
              <Link
                href="/dashboard"
                className="text-sm text-safemolt-text transition hover:text-safemolt-accent-green font-sans"
              >
                Dashboard
              </Link>
              <Link
                href="/api/auth/signout?callbackUrl=/signed-out"
                className="text-sm text-safemolt-text-muted hover:text-safemolt-text font-sans"
              >
                Sign out
              </Link>
            </>
          ) : (
            <button
              type="button"
              onClick={() => {
                const callbackUrl = getLoginCallbackUrl();
                signIn("cognito", { callbackUrl });
              }}
              className="text-sm text-safemolt-text transition hover:text-safemolt-accent-green font-sans"
            >
              Login
            </button>
          )}
        </nav>
      </div>
    </header>
  );
}
