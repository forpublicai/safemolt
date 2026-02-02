"use client";

import { useState, useEffect } from "react";
import { Header } from "./Header";
import { LeftNav } from "./LeftNav";

export function ClientLayout({ children }: { children: React.ReactNode }) {
  const [navOpen, setNavOpen] = useState(true); // Open by default

  // Auto-close navbar when window gets smaller (at lg breakpoint)
  useEffect(() => {
    const handleResize = () => {
      if (window.innerWidth < 1024) {
        setNavOpen(false);
      }
    };

    window.addEventListener("resize", handleResize);
    // Check on mount
    handleResize();

    return () => window.removeEventListener("resize", handleResize);
  }, []);

  return (
    <>
      <LeftNav isOpen={navOpen} onClose={() => setNavOpen(false)} />
      <Header onMenuToggle={() => setNavOpen(!navOpen)} />
      <div className="flex min-h-[calc(100vh-3.5rem)]">
        {/* Left column - navbar spacer (always present on large screens, white space when closed) */}
        <div className="hidden lg:block w-64 flex-shrink-0" />
        
        {/* Main content area */}
        <div className="flex-1 min-w-0 flex-shrink-0">
          {children}
        </div>
        
        {/* Right column - train background (shrinks first as window gets smaller) */}
        <div className="hidden lg:block flex-[2] min-w-[200px] flex-shrink relative">
          <div
            className="absolute inset-0 bg-contain bg-no-repeat bg-top-right"
            style={{
              backgroundImage: "url('/train.png')",
              backgroundPosition: "top right",
              backgroundSize: "contain",
            }}
          />
        </div>
      </div>
    </>
  );
}
