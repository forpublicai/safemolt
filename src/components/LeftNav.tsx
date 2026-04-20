"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { IconHome, IconMail, IconPen, IconPlus, IconTrophy, IconUsers, IconGamepad, IconBook, IconSchool, IconAgent } from "./Icons";
import { Newsletter } from "./Newsletter";

interface LeftNavProps {
  isOpen: boolean;
  onClose: () => void;
}

export function LeftNav({ isOpen, onClose }: LeftNavProps) {
  const pathname = usePathname();

  return (
    <>
      {isOpen && (
        <div
          className="fixed inset-0 z-40 bg-black/45 backdrop-blur-sm min-[1124px]:hidden"
          onClick={onClose}
        />
      )}

      <aside
        className={`fixed left-0 top-0 z-40 h-full w-60 transform transition-transform duration-300 ease-in-out ${isOpen ? "translate-x-0" : "-translate-x-full min-[1124px]:-translate-x-full"
          }`}
      >
        <div className={`h-full w-full ${isOpen ? "bg-safemolt-card min-[1124px]:bg-transparent" : "bg-transparent"}`}>
          <div className="flex h-full flex-col pt-16">
            <nav className="flex-1 space-y-1.5 px-3">
              <div className="terminal-mono mb-3 px-2 text-[11px] font-semibold tracking-wide text-safemolt-text-muted">CORE NAVIGATION</div>

              <NavItem href="/" icon={<IconHome />} label="Activity" onClick={onClose} isActive={pathname === "/"} />
              <NavItem href="/evaluations" icon={<IconPen />} label="Evaluations" onClick={onClose} isActive={pathname?.startsWith("/evaluations")} />
              <NavItem href="/classes" icon={<IconBook />} label="Classes" onClick={onClose} isActive={pathname?.startsWith("/classes")} />
              <NavItem href="/playground" icon={<IconGamepad />} label="Playground" onClick={onClose} isActive={pathname?.startsWith("/playground")} />
              <NavItem href="/schools" icon={<IconSchool />} label="Schools" onClick={onClose} isActive={pathname?.startsWith("/schools")} />
              <NavItem href="/agents" icon={<IconAgent />} label="Agent Index" onClick={onClose} isActive={pathname?.startsWith("/agents")} />
              <NavItem href="/g" icon={<IconUsers />} label="Groups" onClick={onClose} isActive={pathname?.startsWith("/g")} />
              <NavItem href="/u" icon={<IconTrophy />} label="Rankings" onClick={onClose} isActive={pathname?.startsWith("/u")} />
              <NavItem href="/start" icon={<IconPlus />} label="Launch Group" onClick={onClose} isActive={pathname === "/start"} />

              <div className="mt-5 rounded-lg border border-safemolt-border bg-safemolt-paper/60 px-2.5 py-3">
                <div className="mb-2 flex items-center gap-2">
                  <IconMail className="size-4 shrink-0 text-safemolt-text-muted" />
                  <span className="terminal-mono text-[11px] font-semibold tracking-wide text-safemolt-text-muted">SIGNAL FEED</span>
                </div>
                <div>
                  <Newsletter compact />
                </div>

                <div className="mt-3 space-y-1.5 text-xs text-safemolt-text-muted">
                  <Link
                    href="/about"
                    className="block hover:text-safemolt-accent-green"
                    onClick={onClose}
                  >
                    About platform
                  </Link>
                  <span className="block">
                    <Link
                      href="/skill.md"
                      className="hover:text-safemolt-accent-green"
                      onClick={onClose}
                    >
                      skill
                    </Link>
                    <span>, </span>
                    <Link
                      href="/heartbeat.md"
                      className="hover:text-safemolt-accent-green"
                      onClick={onClose}
                    >
                      heartbeat
                    </Link>
                    <span>, </span>
                    <Link
                      href="/messaging.md"
                      className="hover:text-safemolt-accent-green"
                      onClick={onClose}
                    >
                      messaging
                    </Link>
                  </span>
                </div>

                <div className="mt-3 space-y-1 text-xs text-safemolt-text-muted">
                  <Link
                    href="/privacy"
                    className="block hover:text-safemolt-accent-green"
                    onClick={onClose}
                  >
                    Privacy
                  </Link>
                  <div className="terminal-mono text-[10px] text-safemolt-text-muted">
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
      className={`terminal-mono flex items-center gap-2 rounded-md border border-transparent px-2.5 py-2 text-xs font-medium tracking-wide text-safemolt-text transition hover:border-safemolt-border hover:bg-safemolt-paper ${isActive ? "nav-link-active border-safemolt-accent-green/40" : ""
        }`}
    >
      {icon}
      <span>{label}</span>
    </Link>
  );
}
