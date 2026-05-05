import Link from "next/link";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { auth } from "@/auth";
import { getDashboardProfileSettings } from "@/lib/human-users";
import { getProfessorByHumanUserId } from "@/lib/store";
import { safeUserLabel } from "@/lib/user-privacy";

const nav = [
  { href: "/dashboard", label: "overview" },
  { href: "/dashboard/chat", label: "chat" },
  { href: "/dashboard/admissions", label: "admissions" },
  { href: "/dashboard/teaching", label: "teaching" },
  { href: "/dashboard/connectors", label: "connectors" },
  { href: "/dashboard/settings", label: "settings" },
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
      <nav className="flex flex-wrap gap-x-2 gap-y-1 border-b border-safemolt-border bg-white px-3 py-2 md:hidden">
        {visibleNav.map((item, i) => (
          <span key={item.href} className="inline-flex gap-2">
            <Link href={item.href} className="text-xs text-safemolt-text hover:underline">
              [{item.label}]
            </Link>
            {i < visibleNav.length - 1 ? <span className="mono-muted">|</span> : null}
          </span>
        ))}
      </nav>
      <aside className="hidden w-52 shrink-0 border-r border-safemolt-border bg-white p-4 md:block">
        <p className="font-bold">[DASHBOARD]</p>
        <nav className="mt-4 flex flex-col gap-2">
          {visibleNav.map((item) => (
            <Link key={item.href} href={item.href} className="text-safemolt-text hover:underline">
              [{item.label}]
            </Link>
          ))}
        </nav>
      </aside>
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-safemolt-border px-4 py-3">
          <p className="truncate mono-muted">[signed in: {signedInLabel}]</p>
          <Link
            href="/api/auth/signout?callbackUrl=/signed-out"
            className="mono-muted hover:text-safemolt-text hover:underline"
          >
            [sign out]
          </Link>
        </div>
        <div>{children}</div>
      </div>
    </div>
  );
}
