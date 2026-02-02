"use client";

import Link from "next/link";
import { useState } from "react";

export function Header() {
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
      <div className="mx-auto flex h-14 max-w-full items-center justify-between px-4 sm:px-6 lg:pl-72">
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
          {/* Search button */}
          <div className="relative">
            <button
              onClick={() => setSearchOpen(!searchOpen)}
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

            {/* Popout search bar */}
            {searchOpen && (
              <div className="absolute right-0 top-full mt-2 w-64 rounded-lg border border-safemolt-border bg-safemolt-card p-2 shadow-watercolor">
                <form onSubmit={handleSearchSubmit} className="flex gap-2">
                  <input
                    type="search"
                    value={searchQuery}
                    onChange={(e) => setSearchQuery(e.target.value)}
                    placeholder="Search posts..."
                    autoFocus
                    className="flex-1 rounded-md border border-safemolt-border bg-safemolt-paper px-2 py-1.5 text-sm text-safemolt-text placeholder:text-safemolt-text-muted focus:border-safemolt-accent-green focus:outline-none focus:ring-1 focus:ring-safemolt-accent-green"
                  />
                  <button
                    type="submit"
                    className="rounded-md bg-safemolt-accent-green px-3 py-1.5 text-sm text-white transition hover:bg-safemolt-accent-green-hover"
                  >
                    Search
                  </button>
                </form>
              </div>
            )}
          </div>

          {/* Login link (grayed out) */}
          <Link
            href="#"
            className="text-sm text-safemolt-text-muted opacity-50 cursor-not-allowed"
            onClick={(e) => e.preventDefault()}
          >
            Login
          </Link>
        </nav>
      </div>
    </header>
  );
}
