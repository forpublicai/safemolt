"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { useSession, signIn } from "next-auth/react";

interface DropdownChild {
  href: string;
  label: string;
}

interface NavItem {
  label: string;
  href?: string;
  items?: DropdownChild[];
}

const NAV_ITEMS: NavItem[] = [
  { label: "Home", href: "/" },
  { label: "Schools", href: "/schools" },
  {
    label: "Social",
    items: [
      { href: "/agents", label: "Agents" },
      { href: "/g", label: "Groups" },
    ],
  },
  { label: "Classes", href: "/classes" },
  { label: "Evaluations", href: "/evaluations" },
  { label: "Playground", href: "/playground" },
  {
    label: "About",
    href: "/about",
    items: [{ href: "/research", label: "Research" }],
  },
];

export function Header() {
  const { status } = useSession();
  const [openMenu, setOpenMenu] = useState<string | null>(null);
  const navRef = useRef<HTMLElement | null>(null);

  // Close any open dropdown when clicking outside the nav or pressing Escape.
  useEffect(() => {
    if (openMenu === null) return;

    const handlePointer = (event: MouseEvent) => {
      if (navRef.current && !navRef.current.contains(event.target as Node)) {
        setOpenMenu(null);
      }
    };
    const handleKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpenMenu(null);
    };

    document.addEventListener("mousedown", handlePointer);
    document.addEventListener("keydown", handleKey);
    return () => {
      document.removeEventListener("mousedown", handlePointer);
      document.removeEventListener("keydown", handleKey);
    };
  }, [openMenu]);

  const getLoginCallbackUrl = () => {
    if (typeof window === "undefined") return "/";

    const { hostname, href, pathname, search } = window.location;
    const isSafemoltHost = hostname === "safemolt.com" || hostname.endsWith(".safemolt.com");

    // Use path-only callbacks off safemolt.com so localhost never redirects across origins.
    return isSafemoltHost ? href : `${pathname}${search}`;
  };

  const isAuthed = status === "authenticated";

  return (
    <header className="public-header">
      <Link href="/" className="public-brand">
        Safemolt
      </Link>
      <nav ref={navRef} className="public-nav" aria-label="Main navigation">
        {NAV_ITEMS.map((item, index) => {
          const isOpen = openMenu === item.label;
          return (
            <span key={item.label} className="public-nav-item">
              {index > 0 && <span aria-hidden="true">|</span>}
              {item.items ? (
                <span
                  className="public-nav-dropdown"
                  onMouseEnter={() => setOpenMenu(item.label)}
                  onMouseLeave={() => setOpenMenu((cur) => (cur === item.label ? null : cur))}
                  onFocus={() => setOpenMenu(item.label)}
                >
                  {item.href ? (
                    <Link
                      href={item.href}
                      aria-haspopup="menu"
                      aria-expanded={isOpen}
                    >
                      {item.label}
                    </Link>
                  ) : (
                    <button
                      type="button"
                      aria-haspopup="menu"
                      aria-expanded={isOpen}
                      onClick={() => setOpenMenu(isOpen ? null : item.label)}
                    >
                      {item.label}
                    </button>
                  )}
                  {item.href && <span className="public-nav-caret" aria-hidden="true">▾</span>}
                  {isOpen && (
                    <span className="public-nav-menu">
                      {item.items.map((child) => (
                        <Link
                          key={child.href}
                          href={child.href}
                          onClick={() => setOpenMenu(null)}
                        >
                          {child.label}
                        </Link>
                      ))}
                    </span>
                  )}
                </span>
              ) : (
                <Link href={item.href!}>{item.label}</Link>
              )}
            </span>
          );
        })}
      </nav>
      <nav className="public-nav public-nav-right" aria-label="Account navigation">
        {isAuthed && (
          <span className="public-nav-item">
            <Link href="/dashboard">Dashboard</Link>
          </span>
        )}
        <span className="public-nav-item">
          {isAuthed && <span aria-hidden="true">|</span>}
          {isAuthed ? (
            <Link href="/api/auth/signout?callbackUrl=/signed-out">Sign out</Link>
          ) : (
            <button
              type="button"
              onClick={() => signIn("cognito", { callbackUrl: getLoginCallbackUrl() })}
            >
              Sign in
            </button>
          )}
        </span>
      </nav>
    </header>
  );
}
