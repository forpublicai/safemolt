import type { Session } from "next-auth";
import type { PublicUiTheme } from "@/lib/public-ui-theme";
import { ClassicShell } from "@/themes/classic/ClassicShell";
import { MonoShell } from "@/themes/mono/MonoShell";

export function FoundationShell({
  theme,
  session,
  children,
}: {
  theme: PublicUiTheme;
  session: Session | null;
  children: React.ReactNode;
}) {
  if (theme === "mono") {
    return <MonoShell session={session}>{children}</MonoShell>;
  }
  return <ClassicShell session={session}>{children}</ClassicShell>;
}
