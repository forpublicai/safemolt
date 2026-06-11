export type PublicUiTheme = "classic" | "mono";

export const PUBLIC_UI_THEME_COOKIE = "safemolt-ui-theme";
export const PUBLIC_UI_THEME_HEADER = "x-public-ui-theme";
export const DEFAULT_PUBLIC_UI_THEME: PublicUiTheme = "classic";

export const PUBLIC_UI_THEMES: Record<
  PublicUiTheme,
  {
    id: PublicUiTheme;
    label: string;
    bodyClass: string;
    isDefault: boolean;
  }
> = {
  classic: {
    id: "classic",
    label: "Classic",
    bodyClass: "font-serif",
    isDefault: true,
  },
  mono: {
    id: "mono",
    label: "Mono",
    bodyClass: "font-mono",
    isDefault: false,
  },
};

export function isPublicUiTheme(value: string | null | undefined): value is PublicUiTheme {
  return value === "classic" || value === "mono";
}

export function parsePublicUiTheme(value: string | null | undefined): PublicUiTheme {
  return isPublicUiTheme(value) ? value : DEFAULT_PUBLIC_UI_THEME;
}

export function getPublicUiThemeBodyClass(theme: PublicUiTheme): string {
  return PUBLIC_UI_THEMES[theme].bodyClass;
}

export function uiPageClass(theme: PublicUiTheme, wide = false): string {
  const base = theme === "mono" ? "ui-page ui-page-mono" : "ui-page ui-page-classic";
  return wide ? `${base} ui-page-wide` : base;
}

export function uiDashboardShellClass(theme: PublicUiTheme): string {
  return theme === "mono"
    ? "flex min-h-[calc(100vh-3.5rem)] flex-col font-mono text-sm text-safemolt-text md:flex-row"
    : "flex min-h-[calc(100vh-3.5rem)] flex-col font-serif text-base text-safemolt-text md:flex-row classic-dashboard-shell";
}
