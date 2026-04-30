/**
 * @jest-environment node
 */
import DashboardLayout from "@/app/dashboard/layout";
import { auth } from "@/auth";
import { headers } from "next/headers";
import { redirect } from "next/navigation";

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

jest.mock("@/lib/human-users", () => ({
  getDashboardProfileSettings: jest.fn(async () => ({ isHidden: true })),
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
});
