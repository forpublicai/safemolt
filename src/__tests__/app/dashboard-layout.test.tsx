/**
 * @jest-environment node
 */
import DashboardLayout from "@/app/dashboard/layout";
import { auth } from "@/auth";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { isValidElement, type ReactNode } from "react";

jest.mock("@/auth", () => ({
  auth: jest.fn(),
}));

jest.mock("next/headers", () => ({
  headers: jest.fn(),
}));

jest.mock("next/navigation", () => ({
  redirect: jest.fn((url: string) => {
    throw new Error(`redirect:${url}`);
  }),
}));

jest.mock("@/lib/store", () => ({
  getProfessorByHumanUserId: jest.fn(async () => null),
}));

describe("DashboardLayout auth gate", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (headers as jest.Mock).mockResolvedValue({
      get: (name: string) =>
        ({
          "x-current-path": "/dashboard/settings?tab=profile",
          host: "localhost:3000",
        })[name] ?? null,
    });
  });

  it("redirects unauthenticated users to login with a path-only local callback", async () => {
    (auth as jest.Mock).mockResolvedValue(null);

    await expect(DashboardLayout({ children: null })).rejects.toThrow(
      "redirect:/login?callbackUrl=%2Fdashboard%2Fsettings%3Ftab%3Dprofile"
    );
    expect(redirect).toHaveBeenCalledWith("/login?callbackUrl=%2Fdashboard%2Fsettings%3Ftab%3Dprofile");
  });

  it("uses full callback URLs for safemolt subdomains", async () => {
    (auth as jest.Mock).mockResolvedValue(null);
    (headers as jest.Mock).mockResolvedValue({
      get: (name: string) =>
        ({
          "x-current-path": "/dashboard",
          host: "finance.safemolt.com",
          "x-forwarded-proto": "https",
        })[name] ?? null,
    });

    await expect(DashboardLayout({ children: null })).rejects.toThrow(
      "redirect:/login?callbackUrl=https%3A%2F%2Ffinance.safemolt.com%2Fdashboard"
    );
  });

  it("falls back to https for invalid forwarded protocols", async () => {
    (auth as jest.Mock).mockResolvedValue(null);
    (headers as jest.Mock).mockResolvedValue({
      get: (name: string) =>
        ({
          "x-current-path": "/dashboard",
          host: "finance.safemolt.com",
          "x-forwarded-proto": "javascript",
        })[name] ?? null,
    });

    await expect(DashboardLayout({ children: null })).rejects.toThrow(
      "redirect:/login?callbackUrl=https%3A%2F%2Ffinance.safemolt.com%2Fdashboard"
    );
  });

  it("rejects protocol-relative local callback paths", async () => {
    (auth as jest.Mock).mockResolvedValue(null);
    (headers as jest.Mock).mockResolvedValue({
      get: (name: string) =>
        ({
          "x-current-path": "//evil.example/steal",
          host: "localhost:3000",
        })[name] ?? null,
    });

    await expect(DashboardLayout({ children: null })).rejects.toThrow(
      "redirect:/login?callbackUrl=%2Fdashboard"
    );
  });

  it("keeps dashboard chrome free of duplicate sign-out and status text", async () => {
    (auth as jest.Mock).mockResolvedValue({ user: { id: "human-1", name: "Signed in" } });

    const layout = await DashboardLayout({ children: <main>Dashboard body</main> });
    const text = collectText(layout);

    expect(text).toContain("Dashboard body");
    expect(text).not.toContain("Signed in as");
    expect(text).not.toContain("Sign out");
  });
});

function collectText(node: ReactNode): string {
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(collectText).join("");
  if (isValidElement(node)) return collectText((node.props as { children?: ReactNode }).children);
  return "";
}
