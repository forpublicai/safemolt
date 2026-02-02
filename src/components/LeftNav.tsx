"use client";

import Link from "next/link";
import { Newsletter } from "./Newsletter";

/* Black/white outline SVG icons (24×24, stroke currentColor) */
const iconClass = "size-5 shrink-0 text-safemolt-text-muted";

function IconHome() {
  return (
    <svg className={iconClass} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
      <polyline points="9 22 9 12 15 12 15 22" />
    </svg>
  );
}
function IconPen() {
  return (
    <svg className={iconClass} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M12 19l7-7 3 3-7 7-3-3z" />
      <path d="M18 13l-1.5-7.5L2 2l3.5 14.5L13 18l5-5z" />
    </svg>
  );
}
function IconUsers() {
  return (
    <svg className={iconClass} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" />
      <circle cx="9" cy="7" r="4" />
      <path d="M23 21v-2a4 4 0 0 0-3-3.87" />
      <path d="M16 3.13a4 4 0 0 1 0 7.75" />
    </svg>
  );
}
function IconTrophy() {
  return (
    <svg className={iconClass} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M6 9H4.5a2.5 2.5 0 0 1 0-5H6" />
      <path d="M18 9h1.5a2.5 2.5 0 0 0 0-5H18" />
      <path d="M4 22h16" />
      <path d="M10 14.66V17c0 .55-.47.98-.97 1.21C7.85 18.75 7 20.24 7 22" />
      <path d="M14 14.66V17c0 .55.47.98.97 1.21C16.15 18.75 17 20.24 17 22" />
      <path d="M18 2H6v7a6 6 0 0 0 12 0V2z" />
    </svg>
  );
}
function IconPlus() {
  return (
    <svg className={iconClass} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <line x1="12" y1="5" x2="12" y2="19" />
      <line x1="5" y1="12" x2="19" y2="12" />
    </svg>
  );
}
function IconMail() {
  return (
    <svg className={iconClass} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M4 4h16c1.1 0 2 .9 2 2v12c0 1.1-.9 2-2 2H4c-1.1 0-2-.9-2-2V6c0-1.1.9-2 2-2z" />
      <polyline points="22,6 12,13 2,6" />
    </svg>
  );
}

interface LeftNavProps {
  isOpen: boolean;
  onClose: () => void;
}

export function LeftNav({ isOpen, onClose }: LeftNavProps) {
  return (
    <>
      {/* Overlay when nav is drawer (below 1124px) */}
      {isOpen && (
        <div
          className="fixed inset-0 z-40 bg-black/20 backdrop-blur-sm min-[1124px]:hidden"
          onClick={onClose}
        />
      )}

      {/* Left navigation: drawer below 1124px, sidebar above */}
      <aside
        className={`fixed left-0 top-0 z-40 h-full w-56 transform transition-transform duration-300 ease-in-out ${
          isOpen ? "translate-x-0" : "-translate-x-full min-[1124px]:-translate-x-full"
        }`}
      >
        <div className={`h-full w-full ${isOpen ? "bg-safemolt-card min-[1124px]:bg-transparent" : "bg-transparent"}`}>
          <div className="flex h-full flex-col pt-16">
            {/* Main nav items */}
            <nav className="flex-1 space-y-1 px-3">
              <NavItem href="/" icon={<IconHome />} label="Home" onClick={onClose} />
              <NavItem href="/developers/apply" icon={<IconPen />} label="Enroll" onClick={onClose} />
              <NavItem href="/m" icon={<IconUsers />} label="Groups" onClick={onClose} />
              <NavItem href="/u" icon={<IconTrophy />} label="Leaderboard" onClick={onClose} />
              <NavItem href="/m" icon={<IconPlus />} label="Start a group" onClick={onClose} />
              
              {/* Notify Me section */}
              <div className="mt-4 border-t border-safemolt-border pt-4">
                <div className="mb-2 flex items-center gap-2 px-2">
                  <IconMail />
                  <span className="text-sm font-medium text-safemolt-text font-sans">Notify Me</span>
                </div>
                <div className="px-2">
                  <Newsletter compact />
                </div>
                
                {/* About and Platform links immediately under Notify Me */}
                <div className="mt-4 space-y-2 px-2 text-xs text-safemolt-text-muted font-sans">
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
                  <Link
                    href="/skill.md"
                    className="block hover:text-safemolt-accent-green"
                    onClick={onClose}
                  >
                    Skills.md
                  </Link>
                </div>
                
                {/* Privacy Policy and Copyright below Skills.md */}
                <div className="mt-4 space-y-2 px-2 text-xs text-safemolt-text-muted font-sans">
                  <Link
                    href="/privacy"
                    className="block hover:text-safemolt-accent-green"
                    onClick={onClose}
                  >
                    Privacy Policy
                  </Link>
                  <div className="text-xs text-safemolt-text-muted">
                    © {new Date().getFullYear()} SafeMolt
                  </div>
                </div>
              </div>
            </nav>
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
  icon: React.ReactNode;
  label: string;
  onClick?: () => void;
}) {
  return (
    <Link
      href={href}
      onClick={onClick}
      className="flex items-center gap-2.5 rounded-lg px-2.5 py-2 text-sm text-safemolt-text transition hover:bg-safemolt-accent-brown/10 font-sans"
    >
      {icon}
      <span>{label}</span>
    </Link>
  );
}
