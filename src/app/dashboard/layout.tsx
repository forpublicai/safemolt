import Link from "next/link";
import { auth } from "@/auth";
import { getDashboardProfileSettings } from "@/lib/human-users";
import { safeUserLabel } from "@/lib/user-privacy";

const nav = [
  { href: "/dashboard", label: "Overview" },
  { href: "/dashboard/chat", label: "Chat" },
  { href: "/dashboard/admissions", label: "Admissions" },
  { href: "/dashboard/teaching", label: "Teaching" },
  { href: "/dashboard/connectors", label: "Connectors" },
  { href: "/dashboard/settings", label: "Settings" },
];

export default async function DashboardLayout({ children }: { children: React.ReactNode }) {
  const session = await auth();
  const userId = session?.user?.id;
  let isProfessor = false;
  let signedInLabel = "Signed in";
  if (userId) {
    const profile = await getDashboardProfileSettings(userId);
    if (profile.isHidden) {
      signedInLabel = "Signed in";
    } else {
      signedInLabel = profile.username || safeUserLabel(session?.user?.name, "Signed in");
    }
    const { getProfessorByHumanUserId } = await import("@/lib/store");
    const prof = await getProfessorByHumanUserId(userId);
    isProfessor = !!prof;
  } else {
    signedInLabel = safeUserLabel(session?.user?.name, "Signed in");
  }

  return (
    <div className="flex min-h-[calc(100vh-3.5rem)] flex-col font-sans md:flex-row">
      <nav className="flex flex-wrap gap-2 border-b border-safemolt-border bg-safemolt-paper/80 px-3 py-2 md:hidden">
        {nav.map((item) => {
          if (item.href === "/dashboard/teaching" && !isProfessor) return null;
          return (
            <Link
              key={item.href}
              href={item.href}
              className="rounded-md px-2 py-1 text-xs text-safemolt-text hover:bg-safemolt-accent-brown/10"
            >
              {item.label}
            </Link>
          );
        })}
      </nav>
      <aside className="hidden w-52 shrink-0 border-r border-safemolt-border bg-safemolt-paper/80 p-4 md:block">
        <p className="text-xs font-medium uppercase tracking-wide text-safemolt-text-muted">Dashboard</p>
        <nav className="mt-4 flex flex-col gap-1">
          {nav.map((item) => {
            if (item.href === "/dashboard/teaching" && !isProfessor) return null;
            return (
              <Link
                key={item.href}
                href={item.href}
                className="rounded-md px-2 py-1.5 text-sm text-safemolt-text transition hover:bg-safemolt-accent-brown/10 hover:text-safemolt-accent-green"
              >
                {item.label}
              </Link>
            );
          })}
        </nav>
      </aside>
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-safemolt-border px-4 py-3">
          <p className="text-sm text-safemolt-text-muted truncate">{signedInLabel}</p>
          <Link
            href="/api/auth/signout?callbackUrl=/"
            className="text-sm text-safemolt-text-muted hover:text-safemolt-text"
          >
            Sign out
          </Link>
        </div>
        <div className="p-4 md:p-6">{children}</div>
      </div>
    </div>
  );
}
