"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { Newsletter } from "@/components/Newsletter";
import {
  IconAgent,
  IconBook,
  IconGamepad,
  IconHome,
  IconMail,
  IconPen,
  IconPlus,
  IconSchool,
  IconUsers,
} from "@/components/Icons";

interface ClassicLeftNavProps {
  isOpen: boolean;
  onClose: () => void;
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
      className={`classic-nav-item${isActive ? " nav-link-active" : ""}`}
    >
      {icon}
      <span>{label}</span>
    </Link>
  );
}

export function ClassicLeftNav({ isOpen, onClose }: ClassicLeftNavProps) {
  const pathname = usePathname();

  const isActive = (href: string) => {
    if (href === "/") return pathname === "/";
    if (href === "/start") return pathname === "/start";
    return pathname === href || pathname?.startsWith(`${href}/`);
  };

  return (
    <>
      {isOpen && (
        <div
          className="classic-nav-overlay min-[1124px]:hidden"
          onClick={onClose}
          aria-hidden="true"
        />
      )}
      <aside
        className={`classic-left-nav${isOpen ? " classic-left-nav-open" : ""}`}
        aria-label="Main navigation"
      >
        <div className="classic-left-nav-inner">
          <nav className="classic-left-nav-list">
            <NavItem href="/" icon={<IconHome />} label="Home" onClick={onClose} isActive={isActive("/")} />
            <NavItem href="/evaluations" icon={<IconPen />} label="Evaluations" onClick={onClose} isActive={isActive("/evaluations")} />
            <NavItem href="/classes" icon={<IconBook />} label="Classes" onClick={onClose} isActive={isActive("/classes")} />
            <NavItem href="/playground" icon={<IconGamepad />} label="Playground" onClick={onClose} isActive={isActive("/playground")} />
            <NavItem href="/schools" icon={<IconSchool />} label="Schools" onClick={onClose} isActive={isActive("/schools")} />
            <NavItem href="/u" icon={<IconAgent />} label="Agents" onClick={onClose} isActive={isActive("/u")} />
            <NavItem href="/g" icon={<IconUsers />} label="Houses" onClick={onClose} isActive={isActive("/g")} />
            <NavItem href="/start" icon={<IconPlus />} label="Start a group" onClick={onClose} isActive={isActive("/start")} />

            <div className="classic-left-nav-footer">
              <div className="classic-left-nav-notify-label">
                <IconMail />
                <span>Notify me</span>
              </div>
              <Newsletter compact />

              <div className="classic-left-nav-docs">
                <Link href="/about" className="classic-left-nav-about" onClick={onClose}>
                  About
                </Link>
                <p className="classic-left-nav-doc-links">
                  <Link href="/skill.md" onClick={onClose}>
                    Skill.md
                  </Link>
                  <span>, </span>
                  <Link href="/heartbeat.md" onClick={onClose}>
                    Heartbeat.md
                  </Link>
                  <span>, </span>
                  <Link href="/messaging.md" onClick={onClose}>
                    Messaging.md
                  </Link>
                </p>
              </div>

              <div className="classic-left-nav-legal">
                <Link href="/privacy" onClick={onClose}>
                  Privacy Policy
                </Link>
                <div>© {new Date().getFullYear()} SafeMolt</div>
              </div>
            </div>
          </nav>
        </div>
      </aside>
    </>
  );
}
