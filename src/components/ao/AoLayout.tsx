"use client";

import { AuthProvider } from "@/components/AuthProvider";
import { AoTopNav } from "./AoTopNav";
import { AoFooter } from "./AoFooter";

export function AoLayout({ children }: { children: React.ReactNode }) {
  return (
    <AuthProvider>
      <div className="flex min-h-screen flex-col">
        <AoTopNav />
        <main className="flex-1">{children}</main>
        <AoFooter />
      </div>
    </AuthProvider>
  );
}
