/**
 * @jest-environment node
 *
 * P6.4 — GET /api/v1/agents and its `?filter=active_now` narrowing: hidden agents excluded,
 * the filter selects only the active_now bucket, and no raw timestamp ever leaves the response.
 */
import { assertSuccessEnvelope } from "@/__tests__/helpers/api-contract";

jest.mock("@/lib/store", () => ({
  authenticateAndTouchByApiKey: jest.fn(),
  listAgents: jest.fn(),
}));

const store = require("@/lib/store");

import { GET } from "@/app/api/v1/agents/route";

const NOW = Date.parse("2026-09-08T12:00:00.000Z");
const MIN = 60 * 1000;

function makeReq(qs = "") {
  return new (require("next/server").NextRequest)(`http://localhost/api/v1/agents${qs}`, {
    headers: { Authorization: "Bearer key_bearer", "x-school-id": "foundation" },
  });
}

const bearer = {
  id: "agent_bearer",
  name: "bearer",
  isVetted: true,
  isClaimed: false,
  isAdmitted: false,
  points: 0,
  followerCount: 0,
  createdAt: "2026-01-01T00:00:00.000Z",
};

function agent(overrides: Record<string, unknown>) {
  return {
    id: "agent_x",
    name: "agentx",
    points: 0,
    followerCount: 0,
    isClaimed: false,
    createdAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  jest.useFakeTimers().setSystemTime(NOW);
  store.authenticateAndTouchByApiKey.mockResolvedValue(bearer);
});

afterEach(() => jest.useRealTimers());

describe("GET /api/v1/agents", () => {
  it("returns public summaries with presence buckets, no raw timestamp", async () => {
    store.listAgents.mockResolvedValue([
      agent({ id: "a1", name: "active_agent", displayName: "Active", lastActiveAt: new Date(NOW - MIN).toISOString() }),
      agent({ id: "a2", name: "dormant_agent", lastActiveAt: new Date(NOW - 30 * 24 * 60 * MIN).toISOString() }),
    ]);

    const res = await GET(makeReq());
    expect(res.status).toBe(200);
    const body = await res.json();
    assertSuccessEnvelope(body);
    const data = (body as { data: { agents: Array<Record<string, unknown>> } }).data;

    expect(data.agents).toEqual([
      { name: "active_agent", display_name: "Active", presence: "active_now" },
      { name: "dormant_agent", display_name: null, presence: "dormant" },
    ]);

    const serialized = JSON.stringify(body);
    expect(serialized).not.toMatch(/last_active/);
    // No ISO-timestamp-shaped value anywhere in the payload.
    expect(serialized).not.toMatch(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
  });

  it("excludes hidden agents from the listing entirely", async () => {
    store.listAgents.mockResolvedValue([
      agent({ id: "a1", name: "visible", lastActiveAt: new Date(NOW - MIN).toISOString() }),
      agent({ id: "a2", name: "test_probe", metadata: { test: true }, lastActiveAt: new Date(NOW - MIN).toISOString() }),
    ]);

    const res = await GET(makeReq());
    const body = await res.json();
    const data = (body as { data: { agents: Array<Record<string, unknown>> } }).data;
    expect(data.agents.map((a) => a.name)).toEqual(["visible"]);
  });

  it("?filter=active_now narrows to the active_now bucket only", async () => {
    store.listAgents.mockResolvedValue([
      agent({ id: "a1", name: "now_agent", lastActiveAt: new Date(NOW - MIN).toISOString() }),
      agent({ id: "a2", name: "today_agent", lastActiveAt: new Date(NOW - 60 * MIN).toISOString() }),
      agent({ id: "a3", name: "dormant_agent", lastActiveAt: undefined }),
    ]);

    const res = await GET(makeReq("?filter=active_now"));
    const body = await res.json();
    const data = (body as { data: { agents: Array<Record<string, unknown>> } }).data;
    expect(data.agents.map((a) => a.name)).toEqual(["now_agent"]);
  });

  it("?filter=active_now still excludes a hidden agent that is otherwise active_now", async () => {
    store.listAgents.mockResolvedValue([
      agent({ id: "a1", name: "hidden_now", metadata: { system: true }, lastActiveAt: new Date(NOW - MIN).toISOString() }),
    ]);

    const res = await GET(makeReq("?filter=active_now"));
    const body = await res.json();
    const data = (body as { data: { agents: Array<Record<string, unknown>> } }).data;
    expect(data.agents).toEqual([]);
  });

  it("401s without a bearer", async () => {
    store.authenticateAndTouchByApiKey.mockResolvedValue(null);
    const res = await GET(makeReq());
    expect(res.status).toBe(401);
  });
});
