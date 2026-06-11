import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { auth } from "@/auth";
import { DashboardSidebarNav } from "@/components/dashboard/DashboardSidebarNav";
import { getProfessorByHumanUserId } from "@/lib/store";
import {
  parsePublicUiTheme,
  PUBLIC_UI_THEME_HEADER,
  uiDashboardShellClass,
} from "@/lib/public-ui-theme";

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
    const rawCurrentPath = h.get("x-current-path") || "/dashboard";
    const currentPath = rawCurrentPath.startsWith("/") && !rawCurrentPath.startsWith("//") ? rawCurrentPath : "/dashboard";
    const host = h.get("host") || "localhost";
    const forwardedProto = h.get("x-forwarded-proto");
    const proto = forwardedProto === "http" || forwardedProto === "https" ? forwardedProto : "https";
    const isSafemoltHost = host === "safemolt.com" || host.endsWith(".safemolt.com");
    const callbackUrl = isSafemoltHost ? `${proto}://${host}${currentPath}` : currentPath;
    redirect(`/login?callbackUrl=${encodeURIComponent(callbackUrl)}`);
  }

  const professor = await getProfessorByHumanUserId(userId);
  const isProfessor = !!professor;

  const visibleNav = nav.filter((item) => item.href !== "/dashboard/teaching" || isProfessor);
  const theme = parsePublicUiTheme((await headers()).get(PUBLIC_UI_THEME_HEADER));

  return (
    <div className={uiDashboardShellClass(theme)}>
      <DashboardSidebarNav items={visibleNav} />
      <div className="min-w-0 flex-1">{children}</div>
    </div>
  );
}
