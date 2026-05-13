/**
 * @jest-environment node
 *
 * UX2 Phase 3: representative endpoints expose the canonical envelope
 * { success: true, data: ..., meta?: ..., request_id?: ... } while preserving
 * legacy top-level field aliases (backwards compatibility).
 */
import {
  assertSuccessEnvelope,
  assertErrorEnvelope,
} from "@/__tests__/helpers/api-contract";

// Mock the store layer — do NOT mock @/lib/auth so the real jsonResponse path
// (with X-Request-Id auto-injection) is exercised.
jest.mock("@/lib/store", () => ({
  // agents
  getAgentByApiKey: jest.fn(),
  touchAgentLastActiveAtIfStale: jest.fn().mockResolvedValue(undefined),
  getAnnouncement: jest.fn(),
  getAgentByName: jest.fn(),
  listPosts: jest.fn().mockResolvedValue([]),
  listPostsByAuthor: jest.fn().mockResolvedValue([]),
  getCommentsByAgentId: jest.fn().mockResolvedValue([]),
  getAllEvaluationResultsForAgent: jest.fn().mockResolvedValue([]),
  // schools
  listSchools: jest.fn(),
}));

jest.mock("@/lib/rss", () => ({
  getNewsItems: jest.fn().mockResolvedValue([]),
}));

const store = require("@/lib/store");

import { GET as getAgentsStatus } from "@/app/api/v1/agents/status/route";
import { GET as getAgentsProfile } from "@/app/api/v1/agents/profile/route";
import { GET as getSchools } from "@/app/api/v1/schools/route";

const agent = {
  id: "agent_1",
  name: "TestAgent",
  description: "",
  apiKey: "key_1",
  points: 0,
  followerCount: 0,
  isClaimed: true,
  createdAt: "2026-05-01T00:00:00.000Z",
  lastActiveAt: "2026-05-13T00:00:00.000Z",
};

describe("GET /api/v1/agents/status", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    store.getAgentByApiKey.mockResolvedValue(agent);
    store.getAnnouncement.mockResolvedValue(null);
  });

  it("returns canonical success envelope with data + legacy aliases", async () => {
    const req = new Request("http://localhost/api/v1/agents/status", {
      headers: { Authorization: "Bearer key_1" },
    });
    const res = await getAgentsStatus(req);
    expect(res.headers.get("X-Request-Id")).toBeTruthy();
    expect(res.status).toBe(200);
    const body = await res.json();

    assertSuccessEnvelope(body);
    const data = (body as { data: Record<string, unknown> }).data;
    expect(data.status).toBe("claimed");
    expect("latest_announcement" in data).toBe(true);
    expect("news_headlines" in data).toBe(true);
    // Legacy aliases must remain so existing callers keep working.
    expect((body as Record<string, unknown>).status).toBe("claimed");
    expect("latest_announcement" in (body as Record<string, unknown>)).toBe(true);
  });

  it("returns canonical error envelope on missing auth", async () => {
    const req = new Request("http://localhost/api/v1/agents/status");
    const res = await getAgentsStatus(req);
    expect(res.status).toBe(401);
    const body = await res.json();
    assertErrorEnvelope(body);
    expect(body.error_detail.code).toBe("unauthorized");
  });
});

describe("GET /api/v1/agents/profile?name=", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    store.getAgentByApiKey.mockResolvedValue(agent);
  });

  it("returns canonical envelope with data.agent and legacy `agent` alias", async () => {
    const target = { ...agent, id: "agent_2", name: "Target", isClaimed: false };
    store.getAgentByName.mockResolvedValue(target);
    store.listPostsByAuthor.mockResolvedValue([]);
    store.getCommentsByAgentId.mockResolvedValue([]);
    store.getAllEvaluationResultsForAgent.mockResolvedValue([]);

    const req = new (require("next/server").NextRequest)(
      "http://localhost/api/v1/agents/profile?name=Target",
      { headers: { Authorization: "Bearer key_1" } }
    );
    const res = await getAgentsProfile(req);
    expect(res.status).toBe(200);
    expect(res.headers.get("X-Request-Id")).toBeTruthy();

    const body = await res.json();
    assertSuccessEnvelope(body);
    const data = (body as unknown as {
      data: { agent: { name: string }; recent_posts: unknown[] };
    }).data;
    expect(data.agent.name).toBe("Target");
    expect(Array.isArray(data.recent_posts)).toBe(true);
    expect((body as unknown as { agent: { name: string } }).agent.name).toBe("Target");
  });
});

describe("GET /api/v1/schools", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    store.listSchools.mockResolvedValue([
      {
        id: "foundation",
        name: "Foundation",
        description: "",
        subdomain: null,
        status: "active",
        access: "public",
        themeColor: null,
        emoji: null,
        createdAt: "2026-01-01T00:00:00.000Z",
      },
    ]);
  });

  it("returns data array + meta.count and legacy `schools` alias", async () => {
    const res = await getSchools();
    expect(res.status).toBe(200);
    expect(res.headers.get("X-Request-Id")).toBeTruthy();
    const body = await res.json();
    assertSuccessEnvelope(body, { dataIsArray: true });
    expect((body as unknown as { meta: { count: number } }).meta.count).toBe(1);
    // Legacy alias retained
    expect(Array.isArray((body as unknown as { schools: unknown[] }).schools)).toBe(true);
  });

  it("returns canonical error envelope when listing schools fails", async () => {
    store.listSchools.mockRejectedValueOnce(new Error("db unavailable"));

    const res = await getSchools();
    expect(res.status).toBe(500);
    expect(res.headers.get("X-Request-Id")).toBeTruthy();
    const body = await res.json();
    assertErrorEnvelope(body);
    expect(body.error_detail.code).toBe("internal");
  });
});
