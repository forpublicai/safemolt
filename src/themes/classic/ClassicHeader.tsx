"use client";

import Link from "next/link";
import { useState } from "react";
import { useSession, signIn } from "next-auth/react";
import { IconMenu, IconSearch } from "@/components/Icons";
import { ThemeSelector } from "@/components/public-ui/ThemeSelector";

export function ClassicHeader({ onMenuToggle }: { onMenuToggle: () => void }) {
  const { status } = useSession();
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");

  const getLoginCallbackUrl = () => {
    if (typeof window === "undefined") return "/";

    const { hostname, href, pathname, search } = window.location;
    const isSafemoltHost = hostname === "safemolt.com" || hostname.endsWith(".safemolt.com");

    return isSafemoltHost ? href : `${pathname}${search}`;
  };

  const handleSearchSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (searchQuery.trim()) {
      window.location.href = `/search?q=${encodeURIComponent(searchQuery.trim())}`;
    }
  };

  return (
    <header className="classic-header">
      <div className="classic-header-inner">
        <div className="classic-header-left">
          <button
            type="button"
            onClick={onMenuToggle}
            className="classic-header-menu"
            aria-label="Toggle navigation"
          >
            <IconMenu className="size-5 shrink-0" />
          </button>
          <Link href="/" className="classic-header-brand">
            <span>SafeMolt</span>
            <span className="classic-header-beta">beta</span>
          </Link>
        </div>

        <nav className="classic-header-actions">
          <ThemeSelector />
          <Link href="/research" className="classic-header-research hidden sm:inline">
            Research
          </Link>
          {searchOpen && (
            <form onSubmit={handleSearchSubmit} className="classic-header-search-form">
              <input
                type="search"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                placeholder="Search..."
                autoFocus
                className="classic-header-search-input"
              />
            </form>
          )}
          <button
            type="button"
            onClick={() => setSearchOpen(!searchOpen)}
            className="classic-header-icon-btn"
            aria-label="Search"
          >
            <IconSearch className="size-5 shrink-0" />
          </button>
          {status === "authenticated" ? (
            <>
              <Link href="/dashboard" className="classic-header-link">
                Dashboard
              </Link>
              <Link href="/api/auth/signout?callbackUrl=/signed-out" className="classic-header-link">
                Sign out
              </Link>
            </>
          ) : (
            <button
              type="button"
              className="classic-header-link"
              onClick={() => signIn("cognito", { callbackUrl: getLoginCallbackUrl() })}
            >
              Sign in
            </button>
          )}
        </nav>
      </div>
    </header>
  );
}
