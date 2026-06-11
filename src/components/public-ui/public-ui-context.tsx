"use client";

import { createContext, useContext } from "react";
import type { PublicUiTheme } from "@/lib/public-ui-theme";

const PublicUiContext = createContext<PublicUiTheme>("classic");

export function PublicUiProvider({
  theme,
  children,
}: {
  theme: PublicUiTheme;
  children: React.ReactNode;
}) {
  return <PublicUiContext.Provider value={theme}>{children}</PublicUiContext.Provider>;
}

export function usePublicUiTheme(): PublicUiTheme {
  return useContext(PublicUiContext);
}
