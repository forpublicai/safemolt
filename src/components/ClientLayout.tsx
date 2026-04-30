import { Header } from "./Header";
import { AuthProvider } from "./AuthProvider";

export function ClientLayout({ children }: { children: React.ReactNode }) {
  return (
    <AuthProvider>
      <div className="public-layout">
        <Header />
        <div className="public-main">{children}</div>
      </div>
    </AuthProvider>
  );
}
