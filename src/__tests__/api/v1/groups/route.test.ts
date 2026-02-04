/**
 * Integration tests for Groups API routes
 * Tests polymorphic dispatch, authentication, authorization, and error handling.
 * @jest-environment node
 */

import { GET as GetList, POST as CreateGroup } from "@/app/api/v1/groups/[type]/route";
import { GET as GetDetails } from "@/app/api/v1/groups/[type]/[id]/route";
import { POST as JoinGroup } from "@/app/api/v1/groups/[type]/[id]/join/route";
import { POST as LeaveGroup } from "@/app/api/v1/groups/[type]/[id]/leave/route";
import { GET as GetMe } from "@/app/api/v1/groups/[type]/me/route";
import { NextRequest } from "next/server";
import { GroupType } from "@/lib/groups/types";

// Mock dependencies
jest.mock("@/lib/auth", () => ({
  getAgentFromRequest: jest.fn(),
  checkRateLimitAndRespond: jest.fn(),
  requireVettedAgent: jest.fn(),
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
  getAgentById: jest.fn(),
}));

jest.mock("@/lib/groups/registry", () => {
  const actualRegistry = jest.requireActual("@/lib/groups/registry");
  return {
    ...actualRegistry,
    GroupStoreRegistry: {
      getHandler: jest.fn(),
      register: jest.fn(),
      hasHandler: jest.fn(),
      clear: jest.fn(),
    },
  };
});

const { getAgentFromRequest, checkRateLimitAndRespond, requireVettedAgent } = require("@/lib/auth");
const { getAgentById } = require("@/lib/store");
const { GroupStoreRegistry } = require("@/lib/groups/registry");

// Mock agent data
const mockVettedAgent = {
  id: "agent_test123",
  name: "TestAgent",
  description: "Test agent",
  apiKey: "safemolt_test",
  karma: 100,
  followerCount: 0,
  isClaimed: true,
  createdAt: new Date().toISOString(),
  isVetted: true,
};

const mockUnvettedAgent = {
  ...mockVettedAgent,
  isVetted: false,
};

// Mock house data
const mockHouse = {
  id: "house_abc123",
  type: GroupType.HOUSES,
  name: "Test House",
  description: "A test house",
  founderId: mockVettedAgent.id,
  avatarUrl: null,
  settings: {},
  visibility: "public" as const,
  points: 100,
  createdAt: new Date().toISOString(),
};

const mockHouseMembership = {
  agentId: mockVettedAgent.id,
  houseId: mockHouse.id,
  karmaAtJoin: 50,
  joinedAt: new Date().toISOString(),
};

// Mock store implementation
const mockHouseStore = {
  getHouse: jest.fn(),
  getHouseByName: jest.fn(),
  listHouses: jest.fn(),
  getHouseMembership: jest.fn(),
  getHouseMembers: jest.fn(),
  joinHouse: jest.fn(),
  leaveHouse: jest.fn(),
  updateHousePoints: jest.fn(),
  recalculateHousePoints: jest.fn(),
  createGroup: jest.fn(),
  getGroup: jest.fn(),
  getGroupByName: jest.fn(),
  listGroups: jest.fn(),
  updateGroup: jest.fn(),
  deleteGroup: jest.fn(),
};

describe("Groups API - GET /api/v1/groups/[type]", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (getAgentFromRequest as jest.Mock).mockResolvedValue(mockVettedAgent);
    (checkRateLimitAndRespond as jest.Mock).mockReturnValue(null);
    (requireVettedAgent as jest.Mock).mockReturnValue(null);
    (GroupStoreRegistry.getHandler as jest.Mock).mockReturnValue(mockHouseStore);
    (mockHouseStore.listHouses as jest.Mock).mockResolvedValue([mockHouse]);
  });

  it("returns 401 without authentication", async () => {
    (getAgentFromRequest as jest.Mock).mockResolvedValue(null);

    const request = new Request("http://localhost/api/v1/groups/houses");
    const params = Promise.resolve({ type: "houses" });

    const response = await GetList(request, { params });
    const data = await response.json();

    expect(response.status).toBe(401);
    expect(data.success).toBe(false);
    expect(data.error).toBe("Unauthorized");
  });

  it("returns 403 for unvetted agent", async () => {
    (getAgentFromRequest as jest.Mock).mockResolvedValue(mockUnvettedAgent);
    (requireVettedAgent as jest.Mock).mockReturnValue(
      new Response(JSON.stringify({ success: false, error: "Agent not vetted" }), {
        status: 403,
        headers: { "content-type": "application/json" },
      })
    );

    const request = new Request("http://localhost/api/v1/groups/houses");
    const params = Promise.resolve({ type: "houses" });

    const response = await GetList(request, { params });
    const data = await response.json();

    expect(response.status).toBe(403);
    expect(data.success).toBe(false);
  });

  it("returns 404 for unsupported group type", async () => {
    const request = new Request("http://localhost/api/v1/groups/clans");
    const params = Promise.resolve({ type: "clans" });

    const response = await GetList(request, { params });
    const data = await response.json();

    expect(response.status).toBe(404);
    expect(data.error).toBe("Unknown group type");
  });

  it("returns 404 when registry has no handler for type", async () => {
    (GroupStoreRegistry.getHandler as jest.Mock).mockReturnValue(null);

    const request = new Request("http://localhost/api/v1/groups/houses");
    const params = Promise.resolve({ type: "houses" });

    const response = await GetList(request, { params });
    const data = await response.json();

    expect(response.status).toBe(404);
    expect(data.error).toBe("Group type not supported");
  });

  it("returns 429 for rate limit exceeded", async () => {
    (checkRateLimitAndRespond as jest.Mock).mockReturnValue(
      new Response(JSON.stringify({ success: false, error: "Rate limit exceeded" }), {
        status: 429,
        headers: { "content-type": "application/json" },
      })
    );

    const request = new Request("http://localhost/api/v1/groups/houses");
    const params = Promise.resolve({ type: "houses" });

    const response = await GetList(request, { params });
    const data = await response.json();

    expect(response.status).toBe(429);
    expect(data.error).toBe("Rate limit exceeded");
  });

  it("returns list of groups for authenticated agent", async () => {
    const request = new Request("http://localhost/api/v1/groups/houses");
    const params = Promise.resolve({ type: "houses" });

    const response = await GetList(request, { params });
    const data = await response.json();

    expect(response.status).toBe(200);
    expect(data.success).toBe(true);
    expect(data.data).toBeDefined();
    expect(mockHouseStore.listHouses).toHaveBeenCalledWith("points");
  });

  it("uses 'points' as default sort for houses", async () => {
    const request = new Request("http://localhost/api/v1/groups/houses");
    const params = Promise.resolve({ type: "houses" });

    await GetList(request, { params });

    expect(mockHouseStore.listHouses).toHaveBeenCalledWith("points");
  });

  it("accepts valid sort parameter", async () => {
    const request = new Request("http://localhost/api/v1/groups/houses?sort=name");
    const params = Promise.resolve({ type: "houses" });

    await GetList(request, { params });

    expect(mockHouseStore.listHouses).toHaveBeenCalledWith("name");
  });

  it("defaults to 'points' for invalid sort parameter", async () => {
    const request = new Request("http://localhost/api/v1/groups/houses?sort=invalid");
    const params = Promise.resolve({ type: "houses" });

    await GetList(request, { params });

    expect(mockHouseStore.listHouses).toHaveBeenCalledWith("points");
  });
});

describe("Groups API - POST /api/v1/groups/[type]", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (getAgentFromRequest as jest.Mock).mockResolvedValue(mockVettedAgent);
    (checkRateLimitAndRespond as jest.Mock).mockReturnValue(null);
    (requireVettedAgent as jest.Mock).mockReturnValue(null);
    (GroupStoreRegistry.getHandler as jest.Mock).mockReturnValue(mockHouseStore);
    (mockHouseStore.getHouseMembership as jest.Mock).mockResolvedValue(null);
    (mockHouseStore.createGroup as jest.Mock).mockResolvedValue({ id: mockHouse.id });
    (mockHouseStore.getHouse as jest.Mock).mockResolvedValue(mockHouse);
  });

  it("returns 401 without authentication", async () => {
    (getAgentFromRequest as jest.Mock).mockResolvedValue(null);

    const request = new NextRequest("http://localhost/api/v1/groups/houses", {
      method: "POST",
      body: JSON.stringify({ name: "New House" }),
      headers: { "content-type": "application/json" },
    });
    const params = Promise.resolve({ type: "houses" });

    const response = await CreateGroup(request, { params });
    const data = await response.json();

    expect(response.status).toBe(401);
    expect(data.success).toBe(false);
  });

  it("returns 403 for unvetted agent", async () => {
    (getAgentFromRequest as jest.Mock).mockResolvedValue(mockUnvettedAgent);
    (requireVettedAgent as jest.Mock).mockReturnValue(
      new Response(JSON.stringify({ success: false, error: "Agent not vetted" }), {
        status: 403,
        headers: { "content-type": "application/json" },
      })
    );

    const request = new NextRequest("http://localhost/api/v1/groups/houses", {
      method: "POST",
      body: JSON.stringify({ name: "New House" }),
      headers: { "content-type": "application/json" },
    });
    const params = Promise.resolve({ type: "houses" });

    const response = await CreateGroup(request, { params });
    const data = await response.json();

    expect(response.status).toBe(403);
    expect(data.success).toBe(false);
  });

  it("returns 404 for unsupported group type", async () => {
    const request = new NextRequest("http://localhost/api/v1/groups/clans", {
      method: "POST",
      body: JSON.stringify({ name: "New Clan" }),
      headers: { "content-type": "application/json" },
    });
    const params = Promise.resolve({ type: "clans" });

    const response = await CreateGroup(request, { params });
    const data = await response.json();

    expect(response.status).toBe(404);
    expect(data.error).toBe("Unknown group type");
  });

  it("returns 400 for invalid input", async () => {
    const request = new NextRequest("http://localhost/api/v1/groups/houses", {
      method: "POST",
      body: JSON.stringify({ invalid: "data" }),
      headers: { "content-type": "application/json" },
    });
    const params = Promise.resolve({ type: "houses" });

    const response = await CreateGroup(request, { params });
    const data = await response.json();

    expect(response.status).toBe(400);
    expect(data.error).toBe("Invalid input");
  });

  it("returns 400 if agent is already in a house", async () => {
    (mockHouseStore.getHouseMembership as jest.Mock).mockResolvedValue(mockHouseMembership);

    const request = new NextRequest("http://localhost/api/v1/groups/houses", {
      method: "POST",
      body: JSON.stringify({ name: "New House" }),
      headers: { "content-type": "application/json" },
    });
    const params = Promise.resolve({ type: "houses" });

    const response = await CreateGroup(request, { params });
    const data = await response.json();

    expect(response.status).toBe(400);
    expect(data.error).toBe("You are already in a house. Leave your current house first.");
  });

  it("returns 400 for duplicate house name", async () => {
    (mockHouseStore.createGroup as jest.Mock).mockResolvedValue(null);

    const request = new NextRequest("http://localhost/api/v1/groups/houses", {
      method: "POST",
      body: JSON.stringify({ name: "Existing House" }),
      headers: { "content-type": "application/json" },
    });
    const params = Promise.resolve({ type: "houses" });

    const response = await CreateGroup(request, { params });
    const data = await response.json();

    expect(response.status).toBe(400);
    expect(data.error).toBe("A house with this name already exists.");
  });

  it("creates group successfully with valid input", async () => {
    const request = new NextRequest("http://localhost/api/v1/groups/houses", {
      method: "POST",
      body: JSON.stringify({ name: "New House" }),
      headers: { "content-type": "application/json" },
    });
    const params = Promise.resolve({ type: "houses" });

    const response = await CreateGroup(request, { params });
    const data = await response.json();

    expect(response.status).toBe(200);
    expect(data.success).toBe(true);
    expect(data.data).toBeDefined();
    expect(mockHouseStore.createGroup).toHaveBeenCalledWith(
      GroupType.HOUSES,
      mockVettedAgent.id,
      { name: "New House" }
    );
  });

  it("returns 500 if created group cannot be retrieved", async () => {
    (mockHouseStore.getHouse as jest.Mock).mockResolvedValue(null);

    const request = new NextRequest("http://localhost/api/v1/groups/houses", {
      method: "POST",
      body: JSON.stringify({ name: "New House" }),
      headers: { "content-type": "application/json" },
    });
    const params = Promise.resolve({ type: "houses" });

    const response = await CreateGroup(request, { params });
    const data = await response.json();

    expect(response.status).toBe(500);
    expect(data.error).toBe("Internal server error. Please try again later.");
  });

  it("handles database unique constraint violation", async () => {
    const uniqueError = Object.assign(new Error("duplicate key value"), {
      code: "23505",
    });
    (mockHouseStore.createGroup as jest.Mock).mockRejectedValue(uniqueError);

    const request = new NextRequest("http://localhost/api/v1/groups/houses", {
      method: "POST",
      body: JSON.stringify({ name: "Duplicate House" }),
      headers: { "content-type": "application/json" },
    });
    const params = Promise.resolve({ type: "houses" });

    const response = await CreateGroup(request, { params });
    const data = await response.json();

    expect(response.status).toBe(400);
    expect(data.error).toBe("A house with this name already exists.");
  });
});

describe("Groups API - GET /api/v1/groups/[type]/[id]", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (getAgentFromRequest as jest.Mock).mockResolvedValue(mockVettedAgent);
    (checkRateLimitAndRespond as jest.Mock).mockReturnValue(null);
    (requireVettedAgent as jest.Mock).mockReturnValue(null);
    (GroupStoreRegistry.getHandler as jest.Mock).mockReturnValue(mockHouseStore);
    (mockHouseStore.getHouse as jest.Mock).mockResolvedValue(mockHouse);
    (mockHouseStore.getHouseMembers as jest.Mock).mockResolvedValue([mockHouseMembership]);
    (getAgentById as jest.Mock).mockResolvedValue(mockVettedAgent);
  });

  it("returns 401 without authentication", async () => {
    (getAgentFromRequest as jest.Mock).mockResolvedValue(null);

    const request = new Request("http://localhost/api/v1/groups/houses/house_abc123");
    const params = Promise.resolve({ type: "houses", id: "house_abc123" });

    const response = await GetDetails(request, { params });
    const data = await response.json();

    expect(response.status).toBe(401);
    expect(data.success).toBe(false);
  });

  it("returns 403 for unvetted agent", async () => {
    (getAgentFromRequest as jest.Mock).mockResolvedValue(mockUnvettedAgent);
    (requireVettedAgent as jest.Mock).mockReturnValue(
      new Response(JSON.stringify({ success: false, error: "Agent not vetted" }), {
        status: 403,
        headers: { "content-type": "application/json" },
      })
    );

    const request = new Request("http://localhost/api/v1/groups/houses/house_abc123");
    const params = Promise.resolve({ type: "houses", id: "house_abc123" });

    const response = await GetDetails(request, { params });
    const data = await response.json();

    expect(response.status).toBe(403);
    expect(data.success).toBe(false);
  });

  it("returns 404 for unsupported group type", async () => {
    const request = new Request("http://localhost/api/v1/groups/clans/clan_123");
    const params = Promise.resolve({ type: "clans", id: "clan_123" });

    const response = await GetDetails(request, { params });
    const data = await response.json();

    expect(response.status).toBe(404);
    expect(data.error).toBe("Unknown group type");
  });

  it("returns 404 for non-existent group", async () => {
    (mockHouseStore.getHouse as jest.Mock).mockResolvedValue(null);

    const request = new Request("http://localhost/api/v1/groups/houses/house_nonexistent");
    const params = Promise.resolve({ type: "houses", id: "house_nonexistent" });

    const response = await GetDetails(request, { params });
    const data = await response.json();

    expect(response.status).toBe(404);
    expect(data.error).toBe("House not found");
  });

  it("returns group details with members for authenticated agent", async () => {
    const request = new Request("http://localhost/api/v1/groups/houses/house_abc123");
    const params = Promise.resolve({ type: "houses", id: "house_abc123" });

    const response = await GetDetails(request, { params });
    const data = await response.json();

    expect(response.status).toBe(200);
    expect(data.success).toBe(true);
    expect(data.data).toBeDefined();
    expect(mockHouseStore.getHouse).toHaveBeenCalledWith("house_abc123");
    expect(mockHouseStore.getHouseMembers).toHaveBeenCalledWith(mockHouse.id);
  });
});

describe("Groups API - POST /api/v1/groups/[type]/[id]/join", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (getAgentFromRequest as jest.Mock).mockResolvedValue(mockVettedAgent);
    (checkRateLimitAndRespond as jest.Mock).mockReturnValue(null);
    (requireVettedAgent as jest.Mock).mockReturnValue(null);
    (GroupStoreRegistry.getHandler as jest.Mock).mockReturnValue(mockHouseStore);
    (mockHouseStore.getHouse as jest.Mock).mockResolvedValue(mockHouse);
    (mockHouseStore.getHouseMembership as jest.Mock).mockResolvedValue(null);
    (mockHouseStore.joinHouse as jest.Mock).mockResolvedValue(true);
  });

  it("returns 401 without authentication", async () => {
    (getAgentFromRequest as jest.Mock).mockResolvedValue(null);

    const request = new Request("http://localhost/api/v1/groups/houses/house_abc123/join", {
      method: "POST",
    });
    const params = Promise.resolve({ type: "houses", id: "house_abc123" });

    const response = await JoinGroup(request, { params });
    const data = await response.json();

    expect(response.status).toBe(401);
    expect(data.success).toBe(false);
  });

  it("returns 403 for unvetted agent", async () => {
    (getAgentFromRequest as jest.Mock).mockResolvedValue(mockUnvettedAgent);
    (requireVettedAgent as jest.Mock).mockReturnValue(
      new Response(JSON.stringify({ success: false, error: "Agent not vetted" }), {
        status: 403,
        headers: { "content-type": "application/json" },
      })
    );

    const request = new Request("http://localhost/api/v1/groups/houses/house_abc123/join", {
      method: "POST",
    });
    const params = Promise.resolve({ type: "houses", id: "house_abc123" });

    const response = await JoinGroup(request, { params });
    const data = await response.json();

    expect(response.status).toBe(403);
    expect(data.success).toBe(false);
  });

  it("returns 404 for unsupported group type", async () => {
    const request = new Request("http://localhost/api/v1/groups/clans/clan_123/join", {
      method: "POST",
    });
    const params = Promise.resolve({ type: "clans", id: "clan_123" });

    const response = await JoinGroup(request, { params });
    const data = await response.json();

    expect(response.status).toBe(404);
    expect(data.error).toBe("Unknown group type");
  });

  it("returns 404 for non-existent group", async () => {
    (mockHouseStore.getHouse as jest.Mock).mockResolvedValue(null);

    const request = new Request("http://localhost/api/v1/groups/houses/house_nonexistent/join", {
      method: "POST",
    });
    const params = Promise.resolve({ type: "houses", id: "house_nonexistent" });

    const response = await JoinGroup(request, { params });
    const data = await response.json();

    expect(response.status).toBe(404);
    expect(data.error).toBe("House not found");
  });

  it("returns success if already a member", async () => {
    (mockHouseStore.getHouseMembership as jest.Mock).mockResolvedValue(mockHouseMembership);

    const request = new Request("http://localhost/api/v1/groups/houses/house_abc123/join", {
      method: "POST",
    });
    const params = Promise.resolve({ type: "houses", id: "house_abc123" });

    const response = await JoinGroup(request, { params });
    const data = await response.json();

    expect(response.status).toBe(200);
    expect(data.success).toBe(true);
    expect(data.message).toBe("Already a member of this house");
  });

  it("joins house successfully", async () => {
    const request = new Request("http://localhost/api/v1/groups/houses/house_abc123/join", {
      method: "POST",
    });
    const params = Promise.resolve({ type: "houses", id: "house_abc123" });

    const response = await JoinGroup(request, { params });
    const data = await response.json();

    expect(response.status).toBe(200);
    expect(data.success).toBe(true);
    expect(data.message).toBe("Successfully joined house");
    expect(mockHouseStore.joinHouse).toHaveBeenCalledWith(mockVettedAgent.id, mockHouse.id);
  });

  it("returns 400 if join fails", async () => {
    (mockHouseStore.joinHouse as jest.Mock).mockResolvedValue(false);

    const request = new Request("http://localhost/api/v1/groups/houses/house_abc123/join", {
      method: "POST",
    });
    const params = Promise.resolve({ type: "houses", id: "house_abc123" });

    const response = await JoinGroup(request, { params });
    const data = await response.json();

    expect(response.status).toBe(400);
    expect(data.error).toBe("Failed to join house");
  });

  it("handles leaving previous house when joining new one", async () => {
    const otherHouseMembership = {
      agentId: mockVettedAgent.id,
      houseId: "house_other",
      karmaAtJoin: 50,
      joinedAt: new Date().toISOString(),
    };
    (mockHouseStore.getHouseMembership as jest.Mock).mockResolvedValue(otherHouseMembership);

    const request = new Request("http://localhost/api/v1/groups/houses/house_abc123/join", {
      method: "POST",
    });
    const params = Promise.resolve({ type: "houses", id: "house_abc123" });

    const response = await JoinGroup(request, { params });
    const data = await response.json();

    expect(response.status).toBe(200);
    expect(data.success).toBe(true);
    expect(data.message).toBe("Left previous house and joined new house");
  });
});

describe("Groups API - POST /api/v1/groups/[type]/[id]/leave", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (getAgentFromRequest as jest.Mock).mockResolvedValue(mockVettedAgent);
    (checkRateLimitAndRespond as jest.Mock).mockReturnValue(null);
    (requireVettedAgent as jest.Mock).mockReturnValue(null);
    (GroupStoreRegistry.getHandler as jest.Mock).mockReturnValue(mockHouseStore);
    (mockHouseStore.getHouse as jest.Mock).mockResolvedValue(mockHouse);
    (mockHouseStore.getHouseMembership as jest.Mock).mockResolvedValue(mockHouseMembership);
    (mockHouseStore.leaveHouse as jest.Mock).mockResolvedValue(true);
  });

  it("returns 401 without authentication", async () => {
    (getAgentFromRequest as jest.Mock).mockResolvedValue(null);

    const request = new Request("http://localhost/api/v1/groups/houses/house_abc123/leave", {
      method: "POST",
    });
    const params = Promise.resolve({ type: "houses", id: "house_abc123" });

    const response = await LeaveGroup(request, { params });
    const data = await response.json();

    expect(response.status).toBe(401);
    expect(data.success).toBe(false);
  });

  it("returns 403 for unvetted agent", async () => {
    (getAgentFromRequest as jest.Mock).mockResolvedValue(mockUnvettedAgent);
    (requireVettedAgent as jest.Mock).mockReturnValue(
      new Response(JSON.stringify({ success: false, error: "Agent not vetted" }), {
        status: 403,
        headers: { "content-type": "application/json" },
      })
    );

    const request = new Request("http://localhost/api/v1/groups/houses/house_abc123/leave", {
      method: "POST",
    });
    const params = Promise.resolve({ type: "houses", id: "house_abc123" });

    const response = await LeaveGroup(request, { params });
    const data = await response.json();

    expect(response.status).toBe(403);
    expect(data.success).toBe(false);
  });

  it("returns 404 for unsupported group type", async () => {
    const request = new Request("http://localhost/api/v1/groups/clans/clan_123/leave", {
      method: "POST",
    });
    const params = Promise.resolve({ type: "clans", id: "clan_123" });

    const response = await LeaveGroup(request, { params });
    const data = await response.json();

    expect(response.status).toBe(404);
    expect(data.error).toBe("Unknown group type");
  });

  it("returns 404 for non-existent group", async () => {
    (mockHouseStore.getHouse as jest.Mock).mockResolvedValue(null);

    const request = new Request("http://localhost/api/v1/groups/houses/house_nonexistent/leave", {
      method: "POST",
    });
    const params = Promise.resolve({ type: "houses", id: "house_nonexistent" });

    const response = await LeaveGroup(request, { params });
    const data = await response.json();

    expect(response.status).toBe(404);
    expect(data.error).toBe("House not found");
  });

  it("returns 400 if not a member", async () => {
    (mockHouseStore.getHouseMembership as jest.Mock).mockResolvedValue(null);

    const request = new Request("http://localhost/api/v1/groups/houses/house_abc123/leave", {
      method: "POST",
    });
    const params = Promise.resolve({ type: "houses", id: "house_abc123" });

    const response = await LeaveGroup(request, { params });
    const data = await response.json();

    expect(response.status).toBe(400);
    expect(data.error).toBe("You are not a member of this house");
  });

  it("returns 400 if member of different house", async () => {
    const otherHouseMembership = {
      agentId: mockVettedAgent.id,
      houseId: "house_other",
      karmaAtJoin: 50,
      joinedAt: new Date().toISOString(),
    };
    (mockHouseStore.getHouseMembership as jest.Mock).mockResolvedValue(otherHouseMembership);

    const request = new Request("http://localhost/api/v1/groups/houses/house_abc123/leave", {
      method: "POST",
    });
    const params = Promise.resolve({ type: "houses", id: "house_abc123" });

    const response = await LeaveGroup(request, { params });
    const data = await response.json();

    expect(response.status).toBe(400);
    expect(data.error).toBe("You are not a member of this house");
  });

  it("leaves house successfully", async () => {
    const nonFounderHouse = { ...mockHouse, founderId: "agent_other" };
    (mockHouseStore.getHouse as jest.Mock)
      .mockResolvedValueOnce(nonFounderHouse)
      .mockResolvedValueOnce(nonFounderHouse);

    const request = new Request("http://localhost/api/v1/groups/houses/house_abc123/leave", {
      method: "POST",
    });
    const params = Promise.resolve({ type: "houses", id: "house_abc123" });

    const response = await LeaveGroup(request, { params });
    const data = await response.json();

    expect(response.status).toBe(200);
    expect(data.success).toBe(true);
    expect(data.message).toBe("Successfully left house");
    expect(mockHouseStore.leaveHouse).toHaveBeenCalledWith(mockVettedAgent.id);
  });

  it("returns 400 if leave fails", async () => {
    (mockHouseStore.leaveHouse as jest.Mock).mockResolvedValue(false);

    const request = new Request("http://localhost/api/v1/groups/houses/house_abc123/leave", {
      method: "POST",
    });
    const params = Promise.resolve({ type: "houses", id: "house_abc123" });

    const response = await LeaveGroup(request, { params });
    const data = await response.json();

    expect(response.status).toBe(400);
    expect(data.error).toBe("Failed to leave house");
  });

  it("handles founder leaving with new founder elected", async () => {
    const founderHouse = { ...mockHouse, founderId: mockVettedAgent.id };
    (mockHouseStore.getHouse as jest.Mock)
      .mockResolvedValueOnce(founderHouse)
      .mockResolvedValueOnce(founderHouse);

    const request = new Request("http://localhost/api/v1/groups/houses/house_abc123/leave", {
      method: "POST",
    });
    const params = Promise.resolve({ type: "houses", id: "house_abc123" });

    const response = await LeaveGroup(request, { params });
    const data = await response.json();

    expect(response.status).toBe(200);
    expect(data.success).toBe(true);
    expect(data.message).toBe("Left house. A new founder has been elected.");
  });

  it("handles house dissolution when last member leaves", async () => {
    const founderHouse = { ...mockHouse, founderId: mockVettedAgent.id };
    (mockHouseStore.getHouse as jest.Mock)
      .mockResolvedValueOnce(founderHouse)
      .mockResolvedValueOnce(null);

    const request = new Request("http://localhost/api/v1/groups/houses/house_abc123/leave", {
      method: "POST",
    });
    const params = Promise.resolve({ type: "houses", id: "house_abc123" });

    const response = await LeaveGroup(request, { params });
    const data = await response.json();

    expect(response.status).toBe(200);
    expect(data.success).toBe(true);
    expect(data.message).toBe("Left house. House has been dissolved (you were the last member).");
  });
});

describe("Groups API - GET /api/v1/groups/[type]/me", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (getAgentFromRequest as jest.Mock).mockResolvedValue(mockVettedAgent);
    (checkRateLimitAndRespond as jest.Mock).mockReturnValue(null);
    (requireVettedAgent as jest.Mock).mockReturnValue(null);
    (GroupStoreRegistry.getHandler as jest.Mock).mockReturnValue(mockHouseStore);
    (mockHouseStore.getHouseMembership as jest.Mock).mockResolvedValue(mockHouseMembership);
    (mockHouseStore.getHouse as jest.Mock).mockResolvedValue(mockHouse);
    (getAgentById as jest.Mock).mockResolvedValue(mockVettedAgent);
  });

  it("returns 401 without authentication", async () => {
    (getAgentFromRequest as jest.Mock).mockResolvedValue(null);

    const request = new Request("http://localhost/api/v1/groups/houses/me");
    const params = Promise.resolve({ type: "houses" });

    const response = await GetMe(request, { params });
    const data = await response.json();

    expect(response.status).toBe(401);
    expect(data.success).toBe(false);
  });

  it("returns 403 for unvetted agent", async () => {
    (getAgentFromRequest as jest.Mock).mockResolvedValue(mockUnvettedAgent);
    (requireVettedAgent as jest.Mock).mockReturnValue(
      new Response(JSON.stringify({ success: false, error: "Agent not vetted" }), {
        status: 403,
        headers: { "content-type": "application/json" },
      })
    );

    const request = new Request("http://localhost/api/v1/groups/houses/me");
    const params = Promise.resolve({ type: "houses" });

    const response = await GetMe(request, { params });
    const data = await response.json();

    expect(response.status).toBe(403);
    expect(data.success).toBe(false);
  });

  it("returns 404 for unsupported group type", async () => {
    const request = new Request("http://localhost/api/v1/groups/clans/me");
    const params = Promise.resolve({ type: "clans" });

    const response = await GetMe(request, { params });
    const data = await response.json();

    expect(response.status).toBe(404);
    expect(data.error).toBe("Unknown group type");
  });

  it("returns 204 when agent is not in a group", async () => {
    (mockHouseStore.getHouseMembership as jest.Mock).mockResolvedValue(null);

    const request = new Request("http://localhost/api/v1/groups/houses/me");
    const params = Promise.resolve({ type: "houses" });

    const response = await GetMe(request, { params });

    expect(response.status).toBe(204);
  });

  it("returns 204 when membership exists but house was deleted", async () => {
    (mockHouseStore.getHouse as jest.Mock).mockResolvedValue(null);

    const request = new Request("http://localhost/api/v1/groups/houses/me");
    const params = Promise.resolve({ type: "houses" });

    const response = await GetMe(request, { params });

    expect(response.status).toBe(204);
  });

  it("returns membership details for authenticated agent", async () => {
    const request = new Request("http://localhost/api/v1/groups/houses/me");
    const params = Promise.resolve({ type: "houses" });

    const response = await GetMe(request, { params });
    const data = await response.json();

    expect(response.status).toBe(200);
    expect(data.success).toBe(true);
    expect(data.data).toBeDefined();
    expect(data.data.house).toBeDefined();
    expect(data.data.membership).toBeDefined();
    expect(data.data.membership.karma_at_join).toBe(mockHouseMembership.karmaAtJoin);
  });

  it("calculates karma contributed correctly", async () => {
    const request = new Request("http://localhost/api/v1/groups/houses/me");
    const params = Promise.resolve({ type: "houses" });

    const response = await GetMe(request, { params });
    const data = await response.json();

    const expectedKarmaContributed = mockVettedAgent.karma - mockHouseMembership.karmaAtJoin;
    expect(data.data.membership.karma_contributed).toBe(expectedKarmaContributed);
  });
});

describe("Groups API - Registry Pattern", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (getAgentFromRequest as jest.Mock).mockResolvedValue(mockVettedAgent);
    (checkRateLimitAndRespond as jest.Mock).mockReturnValue(null);
    (requireVettedAgent as jest.Mock).mockReturnValue(null);
  });

  it("verifies registry dispatch is called for each route", async () => {
    (GroupStoreRegistry.getHandler as jest.Mock).mockReturnValue(mockHouseStore);
    (mockHouseStore.listHouses as jest.Mock).mockResolvedValue([]);

    const request = new Request("http://localhost/api/v1/groups/houses");
    const params = Promise.resolve({ type: "houses" });

    await GetList(request, { params });

    expect(GroupStoreRegistry.getHandler).toHaveBeenCalledWith(GroupType.HOUSES);
  });

  it("handles missing registry handler gracefully", async () => {
    (GroupStoreRegistry.getHandler as jest.Mock).mockReturnValue(null);

    const request = new Request("http://localhost/api/v1/groups/houses");
    const params = Promise.resolve({ type: "houses" });

    const response = await GetList(request, { params });
    const data = await response.json();

    expect(response.status).toBe(404);
    expect(data.error).toBe("Group type not supported");
  });
});
