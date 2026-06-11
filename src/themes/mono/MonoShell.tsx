import type { Session } from "next-auth";
import { AuthProvider } from "@/components/AuthProvider";
import { MonoHeader } from "./MonoHeader";

export function MonoShell({
  children,
  session,
}: {
  children: React.ReactNode;
  session: Session | null;
}) {
  return (
    <AuthProvider session={session}>
      <div className="public-layout">
        <MonoHeader />
        <div className="public-main">{children}</div>
      </div>
    </AuthProvider>
  );
}
