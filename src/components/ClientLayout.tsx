"use client";

import { useState, useEffect } from "react";
import { usePathname } from "next/navigation";
import { Header } from "./Header";
import { LeftNav } from "./LeftNav";

export function ClientLayout({ children }: { children: React.ReactNode }) {
  const [navOpen, setNavOpen] = useState(true); // Open by default
  const pathname = usePathname();

  // Left bar open by default when viewport >= 1124px (every page); collapses below 1124px
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

  // Keep navbar visible when navigating to any page (wide viewport)
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
    <>
      <LeftNav isOpen={navOpen} onClose={handleClose} />
      <Header onMenuToggle={() => setNavOpen(!navOpen)} />
      <div className="flex min-h-[calc(100vh-3.5rem)]">
        {/* Left column - visible from 1124px up; collapses first as window shrinks */}
        <div className="hidden min-[1124px]:block w-56 shrink-0" />
        
        {/* Main content - min width above lg so it doesn't shrink; only resizes below lg */}
        <div className="min-w-0 flex-1 shrink-0 basis-0 lg:min-w-[800px]">
          {children}
        </div>
        
        {/* Right column - visible from lg (1024px) up; shrinks first, then hidden at lg */}
        <div className="hidden lg:block flex-[1_2_320px] min-w-0 relative">
          <div
            className="absolute inset-0 bg-contain bg-no-repeat bg-top-right"
            style={{
              backgroundImage: "url('/train2.png')",
              backgroundPosition: "top right",
              backgroundSize: "contain",
            }}
          />
          <blockquote className="absolute bottom-0 right-0 mt-2 pr-1 text-right text-[11px] italic leading-snug text-safemolt-text-muted">
            &ldquo;Now, their toys are steam and galvanism.&rdquo;
            <cite className="mt-0.5 block not-italic text-safemolt-text-muted/80">
              — Ralph Waldo Emerson
            </cite>
          </blockquote>
        </div>
      </div>
    </>
  );
}
