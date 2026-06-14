import type { Session } from "next-auth";
import { FoundationShell } from "@/themes/FoundationShell";
import type { PublicUiTheme } from "@/lib/public-ui-theme";

/** Foundation public layout — theme shell is selected in root layout via FoundationShell. */
export function ClientLayout({
  children,
  session,
  theme,
}: {
  children: React.ReactNode;
  session: Session | null;
  theme: PublicUiTheme;
}) {
  return (
    <FoundationShell theme={theme} session={session}>
      {children}
    </FoundationShell>
  );
}
