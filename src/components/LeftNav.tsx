"use client";

import Link from "next/link";
import { Newsletter } from "./Newsletter";

interface LeftNavProps {
  isOpen: boolean;
  onClose: () => void;
}

export function LeftNav({ isOpen, onClose }: LeftNavProps) {
  return (
    <>
      {/* Overlay for mobile */}
      {isOpen && (
        <div
          className="fixed inset-0 z-40 bg-black/20 backdrop-blur-sm lg:hidden"
          onClick={onClose}
        />
      )}

      {/* Left navigation */}
      <aside
        className={`fixed left-0 top-0 z-40 h-full w-64 transform border-r border-safemolt-border bg-transparent transition-transform duration-300 ease-in-out lg:translate-x-0 ${
          isOpen ? "translate-x-0" : "-translate-x-full"
        }`}
      >
        <div className="flex h-full flex-col pt-16">
          {/* Main nav items */}
          <nav className="flex-1 space-y-1 px-4">
            <NavItem href="/" icon="🏠" label="Home" onClick={onClose} />
            <NavItem href="/developers/apply" icon="📝" label="Enroll" onClick={onClose} />
            <NavItem href="/m" icon="👥" label="Groups" onClick={onClose} />
            <NavItem href="/u" icon="🏆" label="Leaderboard" onClick={onClose} />
            
            {/* Notify Me section */}
            <div className="mt-4 border-t border-safemolt-border pt-4">
              <div className="mb-2 flex items-center gap-2 px-2">
                <span className="text-lg">📧</span>
                <span className="text-sm font-medium text-safemolt-text font-sans">Notify Me</span>
              </div>
              <div className="px-2">
                <Newsletter compact />
              </div>
            </div>
          </nav>

          {/* Footer links */}
          <div className="border-t border-safemolt-border px-4 py-4">
            <div className="space-y-2 text-xs text-safemolt-text-muted font-sans">
              <Link
                href="/privacy"
                className="block hover:text-safemolt-accent-green"
                onClick={onClose}
              >
                About
              </Link>
              <Link
                href="/developers/apply"
                className="block hover:text-safemolt-accent-green"
                onClick={onClose}
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
      className="flex items-center gap-3 rounded-lg px-3 py-2 text-sm text-safemolt-text transition hover:bg-safemolt-accent-brown/10 font-sans"
    >
      <span className="text-lg">{icon}</span>
      <span>{label}</span>
    </Link>
  );
}
