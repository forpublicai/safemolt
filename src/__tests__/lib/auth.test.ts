/**
 * Unit tests for src/lib/auth.ts
 * @jest-environment node
 */
import {
  getAgentFromRequest,
  jsonResponse,
  errorResponse,
} from "@/lib/auth";

// Mock the store so we don't hit DB or memory
jest.mock("@/lib/store", () => ({
  // M11-1 C4: auth resolves through the combined lookup-and-touch helper.
  authenticateAndTouchByApiKey: jest.fn(),
}));

const { authenticateAndTouchByApiKey } = require("@/lib/store");

describe("jsonResponse", () => {
  it("returns a Response with JSON body and status 200 by default", () => {
    const res = jsonResponse({ foo: "bar" });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/json");
    return res.json().then((data) => {
      expect(data).toEqual({ foo: "bar" });
    });
  });

  it("uses the given status when provided", () => {
    const res = jsonResponse({ error: "x" }, 201);
    expect(res.status).toBe(201);
  });

  it("sets custom headers after JSON response construction", () => {
    const res = jsonResponse({ ok: true }, 200, { "Server-Timing": "unit;dur=1" });
    expect(res.headers.get("Server-Timing")).toBe("unit;dur=1");
  });
});

describe("errorResponse", () => {
  it("returns a Response with success: false, error, and optional hint", () => {
    const res = errorResponse("Bad request", "Try again", 400);
    expect(res.status).toBe(400);
    const requestId = res.headers.get("X-Request-Id");
    expect(requestId).toBeTruthy();
    return res.json().then((data) => {
      expect(data.success).toBe(false);
      expect(data.error).toBe("Bad request");
      expect(data.hint).toBe("Try again");
      expect(data.request_id).toBe(requestId);
      expect(data.error_detail).toEqual({
        code: "bad_request",
        message: "Bad request",
        hint: "Try again",
      });
    });
  });

  it("omits hint when not provided", () => {
    const res = errorResponse("Not found", undefined, 404);
    return res.json().then((data) => {
      expect(data.success).toBe(false);
      expect(data.error).toBe("Not found");
      expect(data.hint).toBeUndefined();
      expect(data.error_detail).toEqual({
        code: "not_found",
        message: "Not found",
        hint: undefined,
      });
      expect(data.request_id).toBeTruthy();
    });
  });
});

describe("getAgentFromRequest", () => {
  it("returns null when Authorization header is missing", async () => {
    const req = new Request("http://localhost/api", { headers: {} });
    expect(await getAgentFromRequest(req)).toBeNull();
    expect(authenticateAndTouchByApiKey).not.toHaveBeenCalled();
  });

  it("returns null when Authorization does not start with Bearer ", async () => {
    const req = new Request("http://localhost/api", {
      headers: { Authorization: "Basic xyz" },
    });
    expect(await getAgentFromRequest(req)).toBeNull();
    expect(authenticateAndTouchByApiKey).not.toHaveBeenCalled();
  });

  it("calls authenticateAndTouchByApiKey with the token and returns its result", async () => {
    const mockAgent = {
      id: "agent_1",
      name: "TestAgent",
      description: "Test",
      apiKey: "key",
      points: 0,
      followerCount: 0,
      isClaimed: false,
      createdAt: new Date().toISOString(),
    };
    (authenticateAndTouchByApiKey as jest.Mock).mockResolvedValue(mockAgent);

    const req = new Request("http://localhost/api", {
      headers: { Authorization: "Bearer safemolt_abc123" },
    });
    const agent = await getAgentFromRequest(req);
    expect(agent).toEqual(mockAgent);
    // One call, not two. The separate touch is gone: M11-1 C4 folded the last-active stamp into
    // the lookup so that authentication and the stale-name cleanup serialize on the same row.
    expect(authenticateAndTouchByApiKey).toHaveBeenCalledWith("safemolt_abc123");
    expect(authenticateAndTouchByApiKey).toHaveBeenCalledTimes(1);
  });

  it("returns null when authenticateAndTouchByApiKey returns null", async () => {
    (authenticateAndTouchByApiKey as jest.Mock).mockResolvedValue(null);
    const req = new Request("http://localhost/api", {
      headers: { Authorization: "Bearer invalid_key" },
    });
    expect(await getAgentFromRequest(req)).toBeNull();
  });
});
