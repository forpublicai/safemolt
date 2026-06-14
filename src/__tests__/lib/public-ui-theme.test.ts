import {
  DEFAULT_PUBLIC_UI_THEME,
  parsePublicUiTheme,
  uiDashboardShellClass,
  uiPageClass,
} from "@/lib/public-ui-theme";

describe("public-ui-theme", () => {
  it("defaults to classic when cookie value is missing or invalid", () => {
    expect(parsePublicUiTheme(null)).toBe("classic");
    expect(parsePublicUiTheme(undefined)).toBe("classic");
    expect(parsePublicUiTheme("")).toBe("classic");
    expect(parsePublicUiTheme("retro")).toBe("classic");
    expect(DEFAULT_PUBLIC_UI_THEME).toBe("classic");
  });

  it("parses valid theme ids", () => {
    expect(parsePublicUiTheme("classic")).toBe("classic");
    expect(parsePublicUiTheme("mono")).toBe("mono");
  });

  it("returns theme-specific page and dashboard classes", () => {
    expect(uiPageClass("classic")).toContain("ui-page-classic");
    expect(uiPageClass("mono", true)).toContain("ui-page-wide");
    expect(uiDashboardShellClass("mono")).toContain("font-mono");
    expect(uiDashboardShellClass("classic")).toContain("font-serif");
  });
});
