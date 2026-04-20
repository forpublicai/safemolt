"use client";

import { useState, useEffect } from "react";
import { usePathname } from "next/navigation";
import { Header } from "./Header";
import { LeftNav } from "./LeftNav";
import { KonamiCode } from "./KonamiCode";
import { AuthProvider } from "./AuthProvider";

export function ClientLayout({ children }: { children: React.ReactNode }) {
  const [navOpen, setNavOpen] = useState(true);
  const pathname = usePathname();

  const LEFT_COLLAPSE_PX = 1124;
  useEffect(() => {
    const handleResize = () => {
      if (window.innerWidth >= LEFT_COLLAPSE_PX) {
        setNavOpen(true);
      } else {
        setNavOpen(false);
      }
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
    <AuthProvider>
      <KonamiCode />
      <LeftNav isOpen={navOpen} onClose={handleClose} />
      <Header onMenuToggle={() => setNavOpen(!navOpen)} />
      <div className="flex min-h-[calc(100vh-3.5rem)]">
        <div className="hidden min-[1124px]:block w-60 shrink-0" />

        <div className="min-w-0 flex-1 page-transition">
          {children}
        </div>
      </div>
    </AuthProvider>
  );
}
