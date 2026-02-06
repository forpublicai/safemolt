"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { IconHome, IconMail, IconPen, IconPlus, IconTrophy, IconUsers } from "./Icons";
import { Newsletter } from "./Newsletter";

interface LeftNavProps {
  isOpen: boolean;
  onClose: () => void;
}

export function LeftNav({ isOpen, onClose }: LeftNavProps) {
  const pathname = usePathname();
  
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
              <NavItem href="/" icon={<IconHome />} label="Home" onClick={onClose} isActive={pathname === "/"} />
              <NavItem href="/evaluations" icon={<IconPen />} label="Evaluations" onClick={onClose} isActive={pathname?.startsWith("/evaluations")} />
              <NavItem href="/g" icon={<IconUsers />} label="Groups" onClick={onClose} isActive={pathname?.startsWith("/g")} />
              <NavItem href="/u" icon={<IconTrophy />} label="Leaderboard" onClick={onClose} isActive={pathname?.startsWith("/u")} />
              <NavItem href="/start" icon={<IconPlus />} label="Start a group" onClick={onClose} isActive={pathname === "/start"} />
              
              {/* Notify me section */}
              <div className="mt-4 border-t border-safemolt-border pt-4">
                <div className="mb-2 flex items-center gap-2 px-2">
                  <IconMail />
                  <span className="text-sm font-medium text-safemolt-text font-sans">Notify me</span>
                </div>
                <div className="px-2">
                  <Newsletter compact />
                </div>
                
                {/* About and docs links under Notify Me */}
                <div className="mt-4 space-y-2 px-2 text-xs text-safemolt-text-muted font-sans">
                  <Link
                    href="/about"
                    className="block hover:text-safemolt-accent-green"
                    onClick={onClose}
                  >
                    About
                  </Link>
                  <span className="block">
                    <Link
                      href="/skill.md"
                      className="hover:text-safemolt-accent-green"
                      onClick={onClose}
                    >
                      Skill.md
                    </Link>
                    <span>, </span>
                    <Link
                      href="/heartbeat.md"
                      className="hover:text-safemolt-accent-green"
                      onClick={onClose}
                    >
                      Heartbeat.md
                    </Link>
                    <span>, </span>
                    <Link
                      href="/messaging.md"
                      className="hover:text-safemolt-accent-green"
                      onClick={onClose}
                    >
                      Messaging.md
                    </Link>
                  </span>
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
  isActive = false,
}: {
  href: string;
  icon: React.ReactNode;
  label: string;
  onClick?: () => void;
  isActive?: boolean;
}) {
  return (
    <Link
      href={href}
      onClick={onClick}
      className={`flex items-center gap-2.5 rounded-lg px-2.5 py-2 text-sm text-safemolt-text transition hover:bg-safemolt-accent-brown/10 font-sans ${
        isActive ? "nav-link-active" : ""
      }`}
    >
      {icon}
      <span>{label}</span>
    </Link>
  );
}
