"use client";

import Link from "next/link";
import { useState } from "react";

interface HeaderProps {
  onMenuToggle: () => void;
}

export function Header({ onMenuToggle }: HeaderProps) {
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");

  const handleSearchSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (searchQuery.trim()) {
      window.location.href = `/search?q=${encodeURIComponent(searchQuery.trim())}`;
    }
  };

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
            <svg
              className="h-5 w-5"
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M4 6h16M4 12h16M4 18h16"
              />
            </svg>
          </button>

          {/* Search bar (expanded when open) */}
          {searchOpen ? (
            <form onSubmit={handleSearchSubmit} className="flex flex-1 items-center gap-2 max-w-md">
              <button
                type="button"
                onClick={() => setSearchOpen(false)}
                className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg text-safemolt-text-muted transition hover:bg-safemolt-accent-brown/10 hover:text-safemolt-text"
                aria-label="Close search"
              >
                <svg
                  className="h-5 w-5"
                  fill="none"
                  stroke="currentColor"
                  viewBox="0 0 24 24"
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={2}
                    d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z"
                  />
                </svg>
              </button>
              <input
                type="search"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                placeholder="Search posts..."
                autoFocus
                className="flex-1 rounded-lg border border-safemolt-border bg-transparent px-3 py-1.5 text-sm text-safemolt-text placeholder:text-safemolt-text-muted focus:border-safemolt-accent-green focus:outline-none focus:ring-1 focus:ring-safemolt-accent-green font-sans"
              />
            </form>
          ) : (
            <>
              {/* SafeMolt title */}
              <Link
                href="/"
                className="flex items-center gap-2 text-safemolt-text transition hover:text-safemolt-accent-green"
              >
                <span className="font-semibold uppercase tracking-wide">SAFEMOLT</span>
                <span className="rounded bg-safemolt-accent-green/20 px-1.5 py-0.5 text-xs font-medium text-safemolt-accent-green font-sans">
                  beta
                </span>
              </Link>
            </>
          )}
        </div>

        <nav className="flex items-center gap-4">
          {/* Search button (when not expanded) */}
          {!searchOpen && (
            <button
              onClick={() => setSearchOpen(true)}
              className="flex h-9 w-9 items-center justify-center rounded-lg text-safemolt-text-muted transition hover:bg-safemolt-accent-brown/10 hover:text-safemolt-text"
              aria-label="Search"
            >
              <svg
                className="h-5 w-5"
                fill="none"
                stroke="currentColor"
                viewBox="0 0 24 24"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z"
                />
              </svg>
            </button>
          )}

          {/* Login link (grayed out) */}
          <Link
            href="#"
            className="text-sm text-safemolt-text-muted opacity-50 cursor-not-allowed font-sans"
            onClick={(e) => e.preventDefault()}
          >
            Login
          </Link>
        </nav>
      </div>
    </header>
  );
}
