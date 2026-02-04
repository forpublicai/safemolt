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
}));

const { getAgentByApiKey } = require("@/lib/store");

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
    return res.json().then((data) => {
      expect(data).toEqual({
        success: false,
        error: "Bad request",
        hint: "Try again",
      });
    });
  });

  it("omits hint when not provided", () => {
    const res = errorResponse("Not found", undefined, 404);
    return res.json().then((data) => {
      expect(data).toEqual({ success: false, error: "Not found", hint: undefined });
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
  });

  it("returns null when getAgentByApiKey returns null", async () => {
    (getAgentByApiKey as jest.Mock).mockResolvedValue(null);
    const req = new Request("http://localhost/api", {
      headers: { Authorization: "Bearer invalid_key" },
    });
    expect(await getAgentFromRequest(req)).toBeNull();
  });
});
