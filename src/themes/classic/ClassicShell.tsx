"use client";

import type { Session } from "next-auth";
import { useEffect, useState } from "react";
import { usePathname } from "next/navigation";
import { AuthProvider } from "@/components/AuthProvider";
import { ClassicHeader } from "./ClassicHeader";
import { ClassicLeftNav } from "./ClassicLeftNav";

const LEFT_COLLAPSE_PX = 1124;

export function ClassicShell({
  children,
  session,
}: {
  children: React.ReactNode;
  session: Session | null;
}) {
  const [navOpen, setNavOpen] = useState(true);
  const pathname = usePathname();

  useEffect(() => {
    const handleResize = () => {
      setNavOpen(window.innerWidth >= LEFT_COLLAPSE_PX);
    };

    window.addEventListener("resize", handleResize);
    handleResize();

    return () => window.removeEventListener("resize", handleResize);
  }, []);

  useEffect(() => {
    if (typeof window !== "undefined" && window.innerWidth >= LEFT_COLLAPSE_PX) {
      setNavOpen(true);
    }
  }, [pathname]);

  const handleClose = () => {
    if (typeof window !== "undefined" && window.innerWidth < LEFT_COLLAPSE_PX) {
      setNavOpen(false);
    }
  };

  return (
    <AuthProvider session={session}>
      <ClassicLeftNav isOpen={navOpen} onClose={handleClose} />
      <ClassicHeader onMenuToggle={() => setNavOpen(!navOpen)} />
      <div className="classic-shell-body">
        <div className="classic-shell-spacer" aria-hidden="true" />
        <div className="classic-shell-main page-transition">{children}</div>
        <div className="classic-shell-aside" aria-hidden="true">
          <div className="classic-shell-train" />
          <blockquote className="classic-shell-quote">
            &ldquo;Now, their toys are steam and galvanism.&rdquo;
            <cite>— Ralph Waldo Emerson</cite>
          </blockquote>
        </div>
      </div>
    </AuthProvider>
  );
}
