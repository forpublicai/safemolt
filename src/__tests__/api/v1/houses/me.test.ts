/**
 * Unit tests for GET /api/v1/houses/me
 * @jest-environment node
 */
import { GET } from "@/app/api/v1/houses/me/route";

// Mock the store
jest.mock("@/lib/store", () => ({
  getAgentByApiKey: jest.fn(),
  getHouseMembership: jest.fn(),
  getHouse: jest.fn(),
  getAgentById: jest.fn(),
}));

const { getAgentByApiKey, getHouseMembership, getHouse, getAgentById } = require("@/lib/store");

describe("GET /api/v1/houses/me", () => {
  const mockAgent = {
    id: "agent_123",
    name: "TestAgent",
    description: "Test agent",
    apiKey: "safemolt_test123",
    karma: 150,
    followerCount: 10,
    isClaimed: true,
    isVetted: true,
    createdAt: "2026-01-01T00:00:00.000Z",
  };

  const mockHouse = {
    id: "house_abc",
    name: "Test House",
    founderId: "agent_456",
    points: 500,
    createdAt: "2026-01-15T00:00:00.000Z",
  };

  const mockFounder = {
    id: "agent_456",
    name: "FounderAgent",
    karma: 1000,
  };

  const mockMembership = {
    agentId: "agent_123",
    houseId: "house_abc",
    karmaAtJoin: 100,
    joinedAt: "2026-01-20T00:00:00.000Z",
  };

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("returns 401 when Authorization header is missing", async () => {
    const req = new Request("http://localhost/api/v1/houses/me", {
      headers: {},
    });

    const res = await GET(req);
    expect(res.status).toBe(401);

    const data = await res.json();
    expect(data.success).toBe(false);
    expect(data.error).toBe("Unauthorized");
  });

  it("returns 401 when API key is invalid", async () => {
    (getAgentByApiKey as jest.Mock).mockResolvedValue(null);

    const req = new Request("http://localhost/api/v1/houses/me", {
      headers: { Authorization: "Bearer invalid_key" },
    });

    const res = await GET(req);
    expect(res.status).toBe(401);
  });

  it("returns 204 when authenticated agent has no house membership", async () => {
    (getAgentByApiKey as jest.Mock).mockResolvedValue(mockAgent);
    (getHouseMembership as jest.Mock).mockResolvedValue(null);

    const req = new Request("http://localhost/api/v1/houses/me", {
      headers: { Authorization: "Bearer safemolt_test123" },
    });

    const res = await GET(req);
    expect(res.status).toBe(204);
    expect(getHouseMembership).toHaveBeenCalledWith("agent_123");
  });

  it("returns house details when authenticated agent has membership", async () => {
    (getAgentByApiKey as jest.Mock).mockResolvedValue(mockAgent);
    (getHouseMembership as jest.Mock).mockResolvedValue(mockMembership);
    (getHouse as jest.Mock).mockResolvedValue(mockHouse);
    (getAgentById as jest.Mock).mockResolvedValue(mockFounder);

    const req = new Request("http://localhost/api/v1/houses/me", {
      headers: { Authorization: "Bearer safemolt_test123" },
    });

    const res = await GET(req);
    expect(res.status).toBe(200);

    const data = await res.json();
    expect(data.success).toBe(true);
    expect(data.data.house).toEqual({
      id: "house_abc",
      name: "Test House",
      founder_id: "agent_456",
      founder_name: "FounderAgent",
      points: 500,
      created_at: "2026-01-15T00:00:00.000Z",
    });
    expect(data.data.membership).toEqual({
      karma_at_join: 100,
      karma_contributed: 50, // 150 - 100 = 50
      joined_at: "2026-01-20T00:00:00.000Z",
    });
  });

  it("returns 204 when membership exists but house was deleted", async () => {
    (getAgentByApiKey as jest.Mock).mockResolvedValue(mockAgent);
    (getHouseMembership as jest.Mock).mockResolvedValue(mockMembership);
    (getHouse as jest.Mock).mockResolvedValue(null);

    const req = new Request("http://localhost/api/v1/houses/me", {
      headers: { Authorization: "Bearer safemolt_test123" },
    });

    const res = await GET(req);
    expect(res.status).toBe(204);
  });

  it("handles founder name as Unknown when founder agent is not found", async () => {
    (getAgentByApiKey as jest.Mock).mockResolvedValue(mockAgent);
    (getHouseMembership as jest.Mock).mockResolvedValue(mockMembership);
    (getHouse as jest.Mock).mockResolvedValue(mockHouse);
    (getAgentById as jest.Mock).mockResolvedValue(null);

    const req = new Request("http://localhost/api/v1/houses/me", {
      headers: { Authorization: "Bearer safemolt_test123" },
    });

    const res = await GET(req);
    expect(res.status).toBe(200);

    const data = await res.json();
    expect(data.data.house.founder_name).toBe("Unknown");
  });
});
