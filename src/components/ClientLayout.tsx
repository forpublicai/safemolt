import type { Session } from "next-auth";
import { Header } from "./Header";
import { AuthProvider } from "./AuthProvider";

export function ClientLayout({
  children,
  session,
}: {
  children: React.ReactNode;
  session: Session | null;
}) {
  return (
    <AuthProvider session={session}>
      <div className="public-layout">
        <Header />
        <div className="public-main">{children}</div>
      </div>
    </AuthProvider>
  );
}
