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
  getAgentByApiKey: jest.fn(),
  touchAgentLastActiveAtIfStale: jest.fn().mockResolvedValue(undefined),
}));

const { getAgentByApiKey, touchAgentLastActiveAtIfStale } = require("@/lib/store");

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
    expect(getAgentByApiKey).not.toHaveBeenCalled();
  });

  it("returns null when Authorization does not start with Bearer ", async () => {
    const req = new Request("http://localhost/api", {
      headers: { Authorization: "Basic xyz" },
    });
    expect(await getAgentFromRequest(req)).toBeNull();
    expect(getAgentByApiKey).not.toHaveBeenCalled();
  });

  it("calls getAgentByApiKey with the token and returns its result", async () => {
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
    (getAgentByApiKey as jest.Mock).mockResolvedValue(mockAgent);

    const req = new Request("http://localhost/api", {
      headers: { Authorization: "Bearer safemolt_abc123" },
    });
    const agent = await getAgentFromRequest(req);
    expect(agent).toEqual(mockAgent);
    expect(getAgentByApiKey).toHaveBeenCalledWith("safemolt_abc123");
    expect(touchAgentLastActiveAtIfStale).toHaveBeenCalledWith("agent_1");
  });

  it("returns null when getAgentByApiKey returns null", async () => {
    (getAgentByApiKey as jest.Mock).mockResolvedValue(null);
    const req = new Request("http://localhost/api", {
      headers: { Authorization: "Bearer invalid_key" },
    });
    expect(await getAgentFromRequest(req)).toBeNull();
  });
});
