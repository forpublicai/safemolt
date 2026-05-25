/**
 * @jest-environment node
 */
import { NextRequest } from "next/server";
import { middleware } from "@/middleware";

jest.mock("@/auth", () => {
  throw new Error("middleware must not import auth");
});

jest.mock("@/lib/external-schools", () => ({
  isAoHostedExternally: jest.fn(() => false),
  aoExternalRedirectResponse: jest.fn(() =>
    Response.json({ success: false, error: "external" }, { status: 404 })
  ),
}));

describe("middleware", () => {
  it("injects school and current path headers without auth", () => {
    const request = new NextRequest("https://finance.safemolt.com/dashboard?tab=x", {
      headers: { host: "finance.safemolt.com" },
    });
    const response = middleware(request);

    expect(response.headers.get("x-middleware-request-x-school-id")).toBe("finance");
    expect(response.headers.get("x-middleware-request-x-current-path")).toBe("/dashboard?tab=x");
  });

  it("returns 404 for AO product routes when hosted externally", () => {
    const { isAoHostedExternally, aoExternalRedirectResponse } =
      jest.requireMock("@/lib/external-schools");
    isAoHostedExternally.mockReturnValue(true);

    const request = new NextRequest("https://ao.safemolt.com/api/v1/companies", {
      headers: { host: "ao.safemolt.com" },
    });
    const response = middleware(request);

    expect(aoExternalRedirectResponse).toHaveBeenCalled();
    expect(response.status).toBe(404);
  });
});
