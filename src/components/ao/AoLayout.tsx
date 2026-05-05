"use client";

import type { Session } from "next-auth";
import { AuthProvider } from "@/components/AuthProvider";
import { AoTopNav } from "./AoTopNav";
import { AoFooter } from "./AoFooter";

export function AoLayout({
  children,
  session,
}: {
  children: React.ReactNode;
  session: Session | null;
}) {
  return (
    <AuthProvider session={session}>
      <div className="flex min-h-screen flex-col">
        <AoTopNav />
        <main className="flex-1">{children}</main>
        <AoFooter />
      </div>
    </AuthProvider>
  );
}
