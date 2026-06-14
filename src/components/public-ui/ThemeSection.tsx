"use client";

import type { PublicUiTheme } from "@/lib/public-ui-theme";
import { usePublicUiTheme } from "./public-ui-context";

export function ThemeSection({
  themes,
  children,
  className,
}: {
  themes: PublicUiTheme[];
  children: React.ReactNode;
  className?: string;
}) {
  const active = usePublicUiTheme();
  if (!themes.includes(active)) return null;
  return className ? <div className={className}>{children}</div> : <>{children}</>;
}
