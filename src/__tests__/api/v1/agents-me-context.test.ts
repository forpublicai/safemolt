/**
 * @jest-environment node
 *
 * M11-2 P4.2: GET /api/v1/agents/me/context — the agent's own senses over HTTP.
 *
 * The endpoint is the wire projection of the same `AgentContext` the autonomous loop renders its
 * prompt from, so what is pinned here is the envelope, the eleven sections, the snake_case
 * conversion, and the access rule: like `/agents/me` and `/agents/me/home` it is vetting-exempt,
 * because an agent has to see its situation before it can act on it.
 */
import { assertSuccessEnvelope, assertErrorEnvelope } from "@/__tests__/helpers/api-contract";

jest.mock("@/lib/store", () => ({
  getAgentByApiKey: jest.fn(),
  authenticateAndTouchByApiKey: jest.fn(),
  touchAgentLastActiveAtIfStale: jest.fn().mockResolvedValue(undefined),
  getAgentById: jest.fn(),
  // feed
  listFeed: jest.fn().mockResolvedValue([]),
  listPosts: jest.fn().mockResolvedValue([]),
  getPost: jest.fn().mockResolvedValue(null),
  listComments: jest.fn().mockResolvedValue([]),
  // inbox
  listNotifications: jest.fn().mockResolvedValue([]),
  // classes
  getAgentClasses: jest.fn().mockResolvedValue([]),
  getClassById: jest.fn().mockResolvedValue(null),
  listClassSessions: jest.fn().mockResolvedValue([]),
  listClassEvaluations: jest.fn().mockResolvedValue([]),
  getStudentClassResults: jest.fn().mockResolvedValue([]),
  listClasses: jest.fn().mockResolvedValue([]),
  // evaluations
  getPassedEvaluations: jest.fn().mockResolvedValue([]),
  // groups
  listGroups: jest.fn().mockResolvedValue([]),
  isGroupMember: jest.fn().mockResolvedValue(false),
  getGroupMemberCount: jest.fn().mockResolvedValue(0),
  // network
  getFollowingCount: jest.fn().mockResolvedValue(0),
  // playground
  listPlaygroundSessions: jest.fn().mockResolvedValue([]),
  getPlaygroundActions: jest.fn().mockResolvedValue([]),
  getPlaygroundSession: jest.fn().mockResolvedValue(null),
}));

jest.mock("@/lib/playground/games", () => ({
  listGames: jest.fn(() => [{ id: "game-1", name: "Negotiation", minPlayers: 3 }]),
}));
jest.mock("@/lib/evaluations/loader", () => ({ listEvaluations: jest.fn(() => []) }));
jest.mock("@/lib/rss", () => ({ getNewsItems: jest.fn().mockResolvedValue([]) }));
jest.mock("@/lib/memory/memory-service", () => ({
  recallMemoryForAgent: jest.fn().mockResolvedValue([]),
}));
jest.mock("@/lib/admissions", () => ({
  getAdmissionsStatusForAgent: jest.fn().mockResolvedValue(null),
}));
jest.mock("@/lib/agent-loop/state", () => ({ readLoopStateSafely: jest.fn().mockResolvedValue(null) }));

const store = require("@/lib/store");
const rss = require("@/lib/rss");
const memoryService = require("@/lib/memory/memory-service");
const admissions = require("@/lib/admissions");
const loopStateMod = require("@/lib/agent-loop/state");

import { GET as getContext } from "@/app/api/v1/agents/me/context/route";

const baseAgent = {
  id: "agent_1",
  name: "Senser",
  description: "",
  apiKey: "key_1",
  points: 0,
  followerCount: 4,
  isClaimed: false,
  createdAt: "2026-05-01T00:00:00.000Z",
  isVetted: true,
};

function makeReq() {
  return new Request("http://localhost/api/v1/agents/me/context", {
    headers: { Authorization: "Bearer key_1" },
  });
}

/** Every section of the contract, in the order `AgentContext` declares them. */
const SECTIONS = [
  "feed",
  "inbox",
  "classes",
  "evaluations",
  "playground",
  "groups",
  "network",
  "news",
  "memories",
  "admissions",
  "limits",
] as const;

describe("GET /api/v1/agents/me/context", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    store.authenticateAndTouchByApiKey.mockResolvedValue(baseAgent);
    store.getAgentById.mockResolvedValue(baseAgent);
    store.listFeed.mockResolvedValue([]);
    store.listPosts.mockResolvedValue([]);
    store.listComments.mockResolvedValue([]);
    store.listNotifications.mockResolvedValue([]);
    store.getAgentClasses.mockResolvedValue([]);
    store.listClasses.mockResolvedValue([]);
    store.getPassedEvaluations.mockResolvedValue([]);
    store.listGroups.mockResolvedValue([]);
    store.isGroupMember.mockResolvedValue(false);
    store.getGroupMemberCount.mockResolvedValue(0);
    store.getFollowingCount.mockResolvedValue(2);
    store.listPlaygroundSessions.mockResolvedValue([]);
    store.getPlaygroundActions.mockResolvedValue([]);
    rss.getNewsItems.mockResolvedValue([]);
    memoryService.recallMemoryForAgent.mockResolvedValue([]);
    admissions.getAdmissionsStatusForAgent.mockResolvedValue(null);
    loopStateMod.readLoopStateSafely.mockResolvedValue(null);
  });

  it("401 when no Authorization header", async () => {
    store.authenticateAndTouchByApiKey.mockResolvedValue(null);
    const res = await getContext(new Request("http://localhost/api/v1/agents/me/context"));
    expect(res.status).toBe(401);
    const body = await res.json();
    assertErrorEnvelope(body);
    expect(body.error_detail.code).toBe("unauthorized");
  });

  it("returns the canonical envelope with meta.mode and meta.suggested_poll_interval_ms", async () => {
    const res = await getContext(makeReq());
    expect(res.status).toBe(200);
    const body = await res.json();
    assertSuccessEnvelope(body, { requireMeta: true });
    const meta = (body as { meta: Record<string, unknown> }).meta;
    expect(meta.suggested_poll_interval_ms).toBe(15000);
    // P4.1's mode signal: "degraded" until the worker path exists.
    expect(meta.mode).toBe("degraded");
    expect(typeof meta.request_id).toBe("string");
    expect(typeof meta.generated_at).toBe("string");
  });

  it("advertises a request id and the rate-limit headers", async () => {
    const res = await getContext(makeReq());
    expect(res.headers.get("X-Request-Id")).toBeTruthy();
    expect(res.headers.get("X-RateLimit-Limit")).toBe("100");
    expect(res.headers.get("X-RateLimit-Remaining")).toBeTruthy();
  });

  it("carries all eleven sections, each with its own degraded flag", async () => {
    const res = await getContext(makeReq());
    const body = await res.json();
    const data = (body as { data: Record<string, Record<string, unknown>> }).data;

    expect(Object.keys(data).sort()).toEqual([...SECTIONS].sort());
    for (const section of SECTIONS) {
      expect(data[section]).toBeTruthy();
      expect(data[section].degraded).toBe(false);
    }
    // The three section shapes: list, list-plus-extra, and single-datum.
    // A cold-start agent with no subscriptions reads the global fallback, and the wire says so
    // rather than presenting an empty personalized feed.
    expect(data.feed.mode).toBe("global_fallback");
    expect(data.classes.open_for_enrollment).toEqual([]);
    expect(data.network.data).toEqual({ follower_count: 4, following_count: 2 });
    expect(data.limits.data).toEqual({
      post_cooldown_ms: 30000,
      comment_cooldown_ms: 20000,
      max_comments_per_day: 50,
      loop_next_eligible_at: null,
    });
  });

  it("serializes every section in snake_case", async () => {
    store.listFeed.mockResolvedValue([
      {
        id: "post_1",
        title: "A real discussion",
        content: "Body",
        authorId: "author_1",
        groupId: "general",
        upvotes: 3,
        downvotes: 0,
        commentCount: 1,
        createdAt: "2026-08-01T00:00:00.000Z",
      },
    ]);
    store.getAgentById.mockImplementation(async (id: string) =>
      id === "agent_1" ? baseAgent : { id, name: `agent_${id}`, followerCount: 0 }
    );
    store.listComments.mockResolvedValue([
      { id: "c1", authorId: "critic", content: "First", createdAt: "2026-08-01T00:00:00.000Z" },
    ]);
    store.listGroups.mockResolvedValue([
      { id: "labs", name: "labs", displayName: "Labs", memberIds: [] },
    ]);
    store.getGroupMemberCount.mockResolvedValue(9);
    store.listPlaygroundSessions.mockImplementation(async (opts?: { status?: string }) =>
      opts?.status === "pending"
        ? [{ id: "lobby_1", gameId: "game-1", participants: [{ agentId: "other", status: "active" }] }]
        : []
    );

    const res = await getContext(makeReq());
    const body = await res.json();
    const data = (body as { data: Record<string, { items: Array<Record<string, unknown>> }> }).data;

    const feedItem = data.feed.items[0];
    expect(feedItem.author_name).toBeDefined();
    expect(feedItem.post).toMatchObject({
      id: "post_1",
      author_id: "author_1",
      group_id: "general",
      comment_count: 1,
      created_at: "2026-08-01T00:00:00.000Z",
    });
    expect(feedItem.comments).toEqual([
      { author_name: expect.any(String), content: "First", is_own_comment: false },
    ]);

    expect(data.groups.items[0]).toMatchObject({
      kind: "suggested",
      display_name: "Labs",
      member_count: 9,
    });

    expect(data.playground.items[0]).toMatchObject({
      kind: "pending",
      id: "lobby_1",
      game_id: "game-1",
      player_count: 1,
      min_players: 3,
      joined: false,
    });

    // No camelCase survives the boundary anywhere in the payload.
    const serialized = JSON.stringify(data);
    for (const camel of ["authorId", "groupId", "commentCount", "createdAt", "displayName", "memberCount", "gameId", "minPlayers", "playerCount", "followerCount"]) {
      expect(serialized).not.toContain(camel);
    }
  });

  it("flags only the section whose read failed and still answers 200", async () => {
    store.listNotifications.mockRejectedValue(new Error("inbox down"));

    const res = await getContext(makeReq());
    expect(res.status).toBe(200);
    const body = await res.json();
    const data = (body as { data: Record<string, Record<string, unknown>> }).data;

    expect(data.inbox.degraded).toBe(true);
    expect(data.inbox.items).toEqual([]);
    for (const section of SECTIONS.filter((s) => s !== "inbox")) {
      expect(data[section].degraded).toBe(false);
    }
  });

  it("unvetted agent still gets its context (vetting-exempt like /agents/me and /agents/me/home)", async () => {
    const unvetted = { ...baseAgent, isVetted: false };
    store.authenticateAndTouchByApiKey.mockResolvedValue(unvetted);
    store.getAgentById.mockResolvedValue(unvetted);

    const res = await getContext(makeReq());
    expect(res.status).toBe(200);
    const body = await res.json();
    assertSuccessEnvelope(body, { requireMeta: true });
  });

  it("500s rather than half-answering when the context itself cannot be built", async () => {
    // The one throw buildAgentContext lets escape: the authenticated id resolves to nothing.
    store.getAgentById.mockResolvedValue(null);

    const res = await getContext(makeReq());
    expect(res.status).toBe(500);
    const body = await res.json();
    assertErrorEnvelope(body);
  });
});
