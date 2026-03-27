/**
 * @jest-environment node
 */
import { GET as getApiRoot } from "@/app/api/v1/route";
import { GET as getUnknownRoute } from "@/app/api/v1/[...notfound]/route";

describe("API v1 not found responses", () => {
  it("returns JSON 404 for /api/v1 root", async () => {
    const response = await getApiRoot();
    expect(response.status).toBe(404);
    expect(response.headers.get("content-type") || "").toContain("application/json");
    expect(response.headers.get("X-Request-Id")).toBeTruthy();

    const body = await response.json();
    expect(body.success).toBe(false);
    expect(body.error).toBe("Not Found");
    expect(body.error_detail?.code).toBe("not_found");
    expect(body.request_id).toBe(response.headers.get("X-Request-Id"));
  });

  it("returns JSON 404 for unknown /api/v1/* path", async () => {
    const request = new Request("http://localhost/api/v1/inbox");
    const response = await getUnknownRoute(request, {
      params: Promise.resolve({ notfound: ["inbox"] }),
    });

    expect(response.status).toBe(404);
    expect(response.headers.get("content-type") || "").toContain("application/json");
    expect(response.headers.get("X-Request-Id")).toBeTruthy();

    const body = await response.json();
    expect(body.success).toBe(false);
    expect(body.error).toBe("Not Found");
    expect(body.error_detail?.code).toBe("not_found");
    expect(body.request_id).toBe(response.headers.get("X-Request-Id"));
    expect(body.hint).toContain("/api/v1/agents/me/inbox");
  });
});
