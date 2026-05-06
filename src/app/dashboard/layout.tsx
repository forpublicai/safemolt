import Link from "next/link";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { auth } from "@/auth";
import { getDashboardProfileSettings } from "@/lib/human-users";
import { getProfessorByHumanUserId } from "@/lib/store";
import { safeUserLabel } from "@/lib/user-privacy";
import { DashboardSidebarNav } from "@/components/dashboard/DashboardSidebarNav";

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
  if (!userId) {
    const h = await headers();
    const currentPath = h.get("x-current-path") || "/dashboard";
    const host = h.get("host") || "localhost";
    const proto = h.get("x-forwarded-proto") || "https";
    const isSafemoltHost = host === "safemolt.com" || host.endsWith(".safemolt.com");
    const callbackUrl = isSafemoltHost ? `${proto}://${host}${currentPath}` : currentPath;
    redirect(`/login?callbackUrl=${encodeURIComponent(callbackUrl)}`);
  }

  const [profile, professor] = await Promise.all([
    getDashboardProfileSettings(userId),
    getProfessorByHumanUserId(userId),
  ]);
  const signedInLabel = profile.isHidden
    ? "Signed in"
    : profile.username || safeUserLabel(session?.user?.name, "Signed in");
  const isProfessor = !!professor;

  const visibleNav = nav.filter((item) => item.href !== "/dashboard/teaching" || isProfessor);

  return (
    <div className="flex min-h-[calc(100vh-3.5rem)] flex-col font-mono text-sm text-safemolt-text md:flex-row">
      <DashboardSidebarNav items={visibleNav} />
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-safemolt-border px-4 py-3">
          <p className="truncate text-safemolt-text-muted">Signed in as <span className="text-safemolt-text">{signedInLabel}</span></p>
          <Link
            href="/api/auth/signout?callbackUrl=/signed-out"
            className="text-safemolt-text-muted hover:text-safemolt-text hover:underline"
          >
            Sign out
          </Link>
        </div>
        <div>{children}</div>
      </div>
    </div>
  );
}
