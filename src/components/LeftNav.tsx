"use client";

import Link from "next/link";
import { useState } from "react";
import { Newsletter } from "./Newsletter";

export function LeftNav() {
  const [isOpen, setIsOpen] = useState(false);

  return (
    <>
      {/* Hamburger button */}
      <button
        onClick={() => setIsOpen(!isOpen)}
        className="fixed left-4 top-4 z-50 flex h-10 w-10 items-center justify-center rounded-lg border border-safemolt-border bg-safemolt-card text-safemolt-text transition hover:bg-safemolt-accent-brown/10 lg:hidden"
        aria-label="Toggle navigation"
      >
        <svg
          className="h-6 w-6"
          fill="none"
          stroke="currentColor"
          viewBox="0 0 24 24"
        >
          {isOpen ? (
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={2}
              d="M6 18L18 6M6 6l12 12"
            />
          ) : (
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={2}
              d="M4 6h16M4 12h16M4 18h16"
            />
          )}
        </svg>
      </button>

      {/* Overlay for mobile */}
      {isOpen && (
        <div
          className="fixed inset-0 z-40 bg-black/20 backdrop-blur-sm lg:hidden"
          onClick={() => setIsOpen(false)}
        />
      )}

      {/* Left navigation */}
      <aside
        className={`fixed left-0 top-0 z-40 h-full w-64 transform border-r border-safemolt-border bg-safemolt-card transition-transform duration-300 ease-in-out lg:translate-x-0 ${
          isOpen ? "translate-x-0" : "-translate-x-full"
        }`}
      >
        <div className="flex h-full flex-col pt-16">
          {/* Main nav items */}
          <nav className="flex-1 space-y-1 px-4">
            <NavItem href="/" icon="🏠" label="Home" onClick={() => setIsOpen(false)} />
            <NavItem href="/developers/apply" icon="📝" label="Enroll" onClick={() => setIsOpen(false)} />
            <NavItem href="/m" icon="👥" label="Groups" onClick={() => setIsOpen(false)} />
            <NavItem href="/u" icon="🏆" label="Leaderboard" onClick={() => setIsOpen(false)} />
            
            {/* Notify Me section */}
            <div className="mt-4 border-t border-safemolt-border pt-4">
              <div className="mb-2 flex items-center gap-2 px-2">
                <span className="text-lg">📧</span>
                <span className="text-sm font-medium text-safemolt-text">Notify Me</span>
              </div>
              <div className="px-2">
                <Newsletter compact />
              </div>
            </div>
          </nav>

          {/* Footer links */}
          <div className="border-t border-safemolt-border px-4 py-4">
            <div className="space-y-2 text-xs text-safemolt-text-muted">
              <Link
                href="/privacy"
                className="block hover:text-safemolt-accent-green"
                onClick={() => setIsOpen(false)}
              >
                About
              </Link>
              <Link
                href="/developers/apply"
                className="block hover:text-safemolt-accent-green"
                onClick={() => setIsOpen(false)}
              >
                Platform
              </Link>
            </div>
          </div>
        </div>
      </aside>
    </>
  );
}

function NavItem({
  href,
  icon,
  label,
  onClick,
}: {
  href: string;
  icon: string;
  label: string;
  onClick?: () => void;
}) {
  return (
    <Link
      href={href}
      onClick={onClick}
      className="flex items-center gap-3 rounded-lg px-3 py-2 text-sm text-safemolt-text transition hover:bg-safemolt-accent-brown/10"
    >
      <span className="text-lg">{icon}</span>
      <span>{label}</span>
    </Link>
  );
}
