"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

interface NavItem {
  href: string;
  label: string;
}

export function DashboardSidebarNav({ items }: { items: NavItem[] }) {
  const pathname = usePathname() ?? "";

  // The /dashboard root link should only match exact /dashboard, otherwise
  // every sub-route lights up Overview.
  const isActive = (href: string) =>
    href === "/dashboard" ? pathname === "/dashboard" : pathname.startsWith(href);

  return (
    <>
      <nav className="flex flex-wrap gap-x-3 gap-y-1 border-b border-safemolt-border bg-white px-3 py-2 md:hidden">
        {items.map((item, i) => (
          <span key={item.href} className="inline-flex items-center gap-2">
            <Link
              href={item.href}
              className={`text-xs ${
                isActive(item.href)
                  ? "font-bold text-safemolt-text"
                  : "text-safemolt-text-muted hover:text-safemolt-text hover:underline"
              }`}
            >
              {item.label}
            </Link>
            {i < items.length - 1 ? <span className="text-safemolt-text-muted">·</span> : null}
          </span>
        ))}
      </nav>
      <aside className="hidden w-52 shrink-0 border-r border-safemolt-border bg-white p-4 md:block">
        <p className="border-b border-safemolt-border pb-2 text-xs font-bold uppercase tracking-wide text-safemolt-text">
          Dashboard
        </p>
        <nav className="mt-3 flex flex-col">
          {items.map((item) => {
            const active = isActive(item.href);
            return (
              <Link
                key={item.href}
                href={item.href}
                aria-current={active ? "page" : undefined}
                className={`-ml-px border-l-2 py-1 pl-2 ${
                  active
                    ? "border-safemolt-text font-bold text-safemolt-text"
                    : "border-transparent text-safemolt-text-muted hover:border-safemolt-border hover:text-safemolt-text"
                }`}
              >
                {item.label}
              </Link>
            );
          })}
        </nav>
      </aside>
    </>
  );
}
