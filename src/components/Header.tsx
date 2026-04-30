"use client";

import Link from "next/link";
import { useSession, signIn } from "next-auth/react";

export function Header() {
  const { status } = useSession();

  const getLoginCallbackUrl = () => {
    if (typeof window === "undefined") return "/";

    const { hostname, href, pathname, search } = window.location;
    const isSafemoltHost = hostname === "safemolt.com" || hostname.endsWith(".safemolt.com");

    // Use path-only callbacks off safemolt.com so localhost never redirects across origins.
    return isSafemoltHost ? href : `${pathname}${search}`;
  };

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
