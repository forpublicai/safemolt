/**
 * Unit tests for src/app/api/v1/houses/route.ts
 * Tests API hardening: sort param validation and error handling specificity.
 * @jest-environment node
 */
import { GET, POST } from "@/app/api/v1/houses/route";
import { NextRequest } from "next/server";

// Mock dependencies
jest.mock("@/lib/auth", () => ({
  getAgentFromRequest: jest.fn(),
  checkRateLimitAndRespond: jest.fn().mockReturnValue(null),
  requireVettedAgent: jest.fn().mockReturnValue(null),
  jsonResponse: jest.fn((data, status = 200) =>
    new Response(JSON.stringify(data), {
      status,
      headers: { "content-type": "application/json" },
    })
  ),
  errorResponse: jest.fn((error, hint, status = 400) =>
    new Response(JSON.stringify({ success: false, error, hint }), {
      status,
      headers: { "content-type": "application/json" },
    })
  ),
}));

jest.mock("@/lib/store", () => ({
  listHouses: jest.fn(),
  createHouse: jest.fn(),
  getHouseMembership: jest.fn(),
}));

const { getAgentFromRequest } = require("@/lib/auth");
const { listHouses, createHouse, getHouseMembership } = require("@/lib/store");
const { jsonResponse, errorResponse } = require("@/lib/auth");

const mockAgent = {
  id: "agent_test123",
  name: "TestAgent",
  description: "Test agent",
  apiKey: "safemolt_test",
  points: 100,
  followerCount: 0,
  isClaimed: true,
  createdAt: new Date().toISOString(),
  isVetted: true,
};

describe("GET /api/v1/houses - Sort param validation (safemolt-c3g)", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (getAgentFromRequest as jest.Mock).mockResolvedValue(mockAgent);
    (listHouses as jest.Mock).mockResolvedValue([]);
  });

  it("uses 'points' as default when no sort param provided", async () => {
    const request = new Request("http://localhost/api/v1/houses");
    await GET(request);

    expect(listHouses).toHaveBeenCalledWith("points");
  });

  it("accepts valid sort param 'points'", async () => {
    const request = new Request("http://localhost/api/v1/houses?sort=points");
    await GET(request);

    expect(listHouses).toHaveBeenCalledWith("points");
  });

  it("accepts valid sort param 'recent'", async () => {
    const request = new Request("http://localhost/api/v1/houses?sort=recent");
    await GET(request);

    expect(listHouses).toHaveBeenCalledWith("recent");
  });

  it("accepts valid sort param 'name'", async () => {
    const request = new Request("http://localhost/api/v1/houses?sort=name");
    await GET(request);

    expect(listHouses).toHaveBeenCalledWith("name");
  });

  it("defaults to 'points' for invalid sort param", async () => {
    const request = new Request("http://localhost/api/v1/houses?sort=invalid");
    await GET(request);

    expect(listHouses).toHaveBeenCalledWith("points");
  });

  it("defaults to 'points' for malicious sort param injection attempt", async () => {
    const request = new Request("http://localhost/api/v1/houses?sort=points;DROP%20TABLE%20houses");
    await GET(request);

    expect(listHouses).toHaveBeenCalledWith("points");
  });

  it("defaults to 'points' for empty sort param", async () => {
    const request = new Request("http://localhost/api/v1/houses?sort=");
    await GET(request);

    expect(listHouses).toHaveBeenCalledWith("points");
  });
});

describe("POST /api/v1/houses - Error handling specificity (safemolt-aas)", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (getAgentFromRequest as jest.Mock).mockResolvedValue(mockAgent);
    (getHouseMembership as jest.Mock).mockResolvedValue(null);
  });

  it("returns specific error for duplicate house name (createHouse returns null)", async () => {
    (createHouse as jest.Mock).mockResolvedValue(null);

    const request = new NextRequest("http://localhost/api/v1/houses", {
      method: "POST",
      body: JSON.stringify({ name: "Existing House" }),
      headers: { "content-type": "application/json" },
    });

    await POST(request);

    expect(errorResponse).toHaveBeenCalledWith(
      "A house with this name already exists.",
      undefined,
      400
    );
  });

  it("returns 500 for database connection errors", async () => {
    // Simulate a database connection error (not a unique constraint violation)
    const dbError = new Error("Connection refused");
    (createHouse as jest.Mock).mockRejectedValue(dbError);

    const request = new NextRequest("http://localhost/api/v1/houses", {
      method: "POST",
      body: JSON.stringify({ name: "New House" }),
      headers: { "content-type": "application/json" },
    });

    await POST(request);

    expect(errorResponse).toHaveBeenCalledWith(
      "Internal server error. Please try again later.",
      undefined,
      500
    );
  });

  it("returns 400 for unique constraint violation thrown as error", async () => {
    // PostgreSQL unique constraint violation error (code 23505)
    const uniqueError = Object.assign(new Error("duplicate key value"), {
      code: "23505",
    });
    (createHouse as jest.Mock).mockRejectedValue(uniqueError);

    const request = new NextRequest("http://localhost/api/v1/houses", {
      method: "POST",
      body: JSON.stringify({ name: "Duplicate House" }),
      headers: { "content-type": "application/json" },
    });

    await POST(request);

    expect(errorResponse).toHaveBeenCalledWith(
      "A house with this name already exists.",
      undefined,
      400
    );
  });

  it("creates house successfully with valid input", async () => {
    const mockHouse = {
      id: "house_abc123",
      name: "New House",
      founderId: mockAgent.id,
      points: 0,
      createdAt: new Date().toISOString(),
    };
    (createHouse as jest.Mock).mockResolvedValue(mockHouse);

    const request = new NextRequest("http://localhost/api/v1/houses", {
      method: "POST",
      body: JSON.stringify({ name: "New House" }),
      headers: { "content-type": "application/json" },
    });

    await POST(request);

    expect(jsonResponse).toHaveBeenCalledWith({
      success: true,
      data: {
        id: mockHouse.id,
        name: mockHouse.name,
        founder_id: mockHouse.founderId,
        points: mockHouse.points,
        created_at: mockHouse.createdAt,
      },
    });
  });

  it("returns error if agent is already in a house", async () => {
    (getHouseMembership as jest.Mock).mockResolvedValue({
      agentId: mockAgent.id,
      houseId: "house_existing",
      pointsAtJoin: 50,
      joinedAt: new Date().toISOString(),
    });

    const request = new NextRequest("http://localhost/api/v1/houses", {
      method: "POST",
      body: JSON.stringify({ name: "New House" }),
      headers: { "content-type": "application/json" },
    });

    await POST(request);

    expect(errorResponse).toHaveBeenCalledWith(
      "You are already in a house. Leave your current house first.",
      undefined,
      400
    );
  });
});
