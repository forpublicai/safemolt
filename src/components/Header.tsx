"use client";

import Link from "next/link";
import { useState } from "react";
import { IconMenu, IconSearch } from "./Icons";

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
            <IconMenu className="size-5 shrink-0" />
          </button>

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
        </div>

        <nav className="flex items-center gap-3">
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
