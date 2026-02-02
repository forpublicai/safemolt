"use client";

import { useState } from "react";
import { Header } from "./Header";
import { LeftNav } from "./LeftNav";

export function LayoutWrapper({ children }: { children: React.ReactNode }) {
  const [navOpen, setNavOpen] = useState(false);

  return (
    <>
      <LeftNav isOpen={navOpen} onClose={() => setNavOpen(false)} />
      <Header onMenuToggle={() => setNavOpen(!navOpen)} />
      {children}
    </>
  );
}
