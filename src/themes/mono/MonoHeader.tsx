"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { useSession, signIn } from "next-auth/react";
import { PUBLIC_NAV_ITEMS } from "@/lib/public-nav-items";
import { ThemeSelector } from "@/components/public-ui/ThemeSelector";

export function MonoHeader() {
  const { status } = useSession();
  const [openMenu, setOpenMenu] = useState<string | null>(null);
  const navRef = useRef<HTMLElement | null>(null);

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

    return isSafemoltHost ? href : `${pathname}${search}`;
  };

  const isAuthed = status === "authenticated";

  return (
    <header className="public-header">
      <Link href="/" className="public-brand">
        SafeMolt
      </Link>
      <nav ref={navRef} className="public-nav" aria-label="Main navigation">
        {PUBLIC_NAV_ITEMS.map((item, index) => {
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
        <span className="public-nav-item public-nav-theme">
          <ThemeSelector />
        </span>
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
