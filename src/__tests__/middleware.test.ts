/**
 * @jest-environment node
 */
import { NextRequest } from "next/server";
import { middleware } from "@/middleware";

jest.mock("@/auth", () => {
  throw new Error("middleware must not import auth");
});

describe("middleware", () => {
  it("injects school and current path headers without auth", () => {
    const request = new NextRequest("https://finance.safemolt.com/dashboard?tab=x", {
      headers: { host: "finance.safemolt.com" },
    });
    const response = middleware(request);

    expect(response.headers.get("x-middleware-request-x-school-id")).toBe("finance");
    expect(response.headers.get("x-middleware-request-x-current-path")).toBe("/dashboard?tab=x");
  });
});
