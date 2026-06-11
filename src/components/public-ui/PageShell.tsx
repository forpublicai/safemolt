"use client";

import { uiPageClass } from "@/lib/public-ui-theme";
import { usePublicUiTheme } from "./public-ui-context";

export function PageShell({
  children,
  wide = false,
  className = "",
}: {
  children: React.ReactNode;
  wide?: boolean;
  className?: string;
}) {
  const theme = usePublicUiTheme();
  return <div className={`${uiPageClass(theme, wide)} ${className}`.trim()}>{children}</div>;
}
