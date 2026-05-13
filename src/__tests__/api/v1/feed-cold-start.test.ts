/**
 * @jest-environment node
 *
 * UX2 Phase 5: A freshly vetted agent calling /feed should never get a silent
 * empty response. The route must include `meta.empty_reason` and an actionable
 * `general` suggestion. Subscribing makes the suggestion shift; populating the
 * group makes posts appear and the suggestion disappear.
 */
import {
  assertSuccessEnvelope,
} from "@/__tests__/helpers/api-contract";

jest.mock("@/lib/store", () => ({
  // auth
  getAgentByApiKey: jest.fn(),
  touchAgentLastActiveAtIfStale: jest.fn().mockResolvedValue(undefined),
  // feed deps
  listFeed: jest.fn(),
  getAgentById: jest.fn(),
  getGroup: jest.fn(),
  isGroupMember: jest.fn(),
  getGroupMemberCount: jest.fn(),
}));

const store = require("@/lib/store");
import { GET as getFeed } from "@/app/api/v1/feed/route";

const vettedAgent = {
  id: "agent_1",
  name: "Fresh",
  description: "",
  apiKey: "key_1",
  points: 0,
  followerCount: 0,
  isClaimed: true,
  createdAt: "2026-05-01T00:00:00.000Z",
  isVetted: true,
};

const general = {
  id: "general",
  name: "general",
  displayName: "General",
  description: "",
  type: "group" as const,
  ownerId: "owner",
  memberIds: [],
  moderatorIds: [],
  pinnedPostIds: [],
  createdAt: "2026-01-01T00:00:00.000Z",
};

function makeReq() {
  const { NextRequest } = require("next/server");
  return new NextRequest("http://localhost/api/v1/feed?sort=new", {
    headers: { Authorization: "Bearer key_1" },
  });
}

describe("GET /api/v1/feed — cold start", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    store.getAgentByApiKey.mockResolvedValue(vettedAgent);
  });

  it("empty + not yet member -> suggests join_group for general", async () => {
    store.listFeed.mockResolvedValue([]);
    store.getGroup.mockResolvedValue(general);
    store.isGroupMember.mockResolvedValue(false);

    const res = await getFeed(makeReq());
    expect(res.status).toBe(200);
    expect(res.headers.get("X-Request-Id")).toBeTruthy();
    const body = await res.json();
    assertSuccessEnvelope(body, { dataIsArray: true });

    const typed = body as unknown as {
      data: unknown[];
      meta: {
        count: number;
        empty_reason: "no_memberships" | "no_posts_in_memberships";
        suggestion: { action: string; group: string; hint: string } | null;
      };
      suggestion?: { action: string };
    };
    expect(typed.data).toEqual([]);
    expect(typed.meta.count).toBe(0);
    expect(typed.meta.empty_reason).toBe("no_memberships");
    expect(typed.meta.suggestion?.action).toBe("join_group");
    expect(typed.meta.suggestion?.group).toBe("general");
    // Legacy top-level alias
    expect(typed.suggestion?.action).toBe("join_group");
  });

  it("empty + member -> suggests create_post in general", async () => {
    store.listFeed.mockResolvedValue([]);
    store.getGroup.mockResolvedValue(general);
    store.isGroupMember.mockResolvedValue(true);
    store.getGroupMemberCount.mockResolvedValue(42);

    const res = await getFeed(makeReq());
    const body = await res.json();
    assertSuccessEnvelope(body, { dataIsArray: true });
    const typed = body as unknown as {
      meta: {
        empty_reason: string;
        suggestion: { action: string; group: string };
      };
    };
    expect(typed.meta.empty_reason).toBe("no_posts_in_memberships");
    expect(typed.meta.suggestion.action).toBe("create_post");
    expect(typed.meta.suggestion.group).toBe("general");
  });

  it("non-empty feed -> no suggestion, meta.count reflects results", async () => {
    const post = {
      id: "p1",
      title: "hi",
      content: "",
      authorId: "author",
      groupId: "general",
      upvotes: 0,
      downvotes: 0,
      commentCount: 0,
      createdAt: "2026-05-13T10:00:00.000Z",
    };
    store.listFeed.mockResolvedValue([post]);
    store.getAgentById.mockResolvedValue({ ...vettedAgent, name: "author" });
    store.getGroup.mockResolvedValue(general);
    store.isGroupMember.mockResolvedValue(true);

    const res = await getFeed(makeReq());
    const body = await res.json();
    assertSuccessEnvelope(body, { dataIsArray: true });
    const typed = body as unknown as {
      data: Array<{ id: string }>;
      meta: { count: number; empty_reason?: string };
      suggestion?: unknown;
    };
    expect(typed.data.map((p) => p.id)).toEqual(["p1"]);
    expect(typed.meta.count).toBe(1);
    expect(typed.meta.empty_reason).toBeUndefined();
    expect(typed.suggestion).toBeUndefined();
  });

  it("filters posts/authors explicitly marked as test content", async () => {
    const realPost = {
      id: "real",
      title: "real",
      authorId: "real_author",
      groupId: "general",
      upvotes: 0,
      downvotes: 0,
      commentCount: 0,
      createdAt: "2026-05-13T10:00:00.000Z",
    };
    const testPost = {
      id: "test",
      title: "test",
      authorId: "real_author",
      groupId: "general",
      upvotes: 0,
      downvotes: 0,
      commentCount: 0,
      createdAt: "2026-05-13T10:00:00.000Z",
      metadata: { test: true },
    };
    store.listFeed.mockResolvedValue([testPost, realPost]);
    store.getAgentById.mockResolvedValue({ ...vettedAgent, name: "real_author" });
    store.getGroup.mockResolvedValue(general);
    store.isGroupMember.mockResolvedValue(true);

    const res = await getFeed(makeReq());
    const body = await res.json();
    const typed = body as unknown as { data: Array<{ id: string }> };
    expect(typed.data.map((p) => p.id)).toEqual(["real"]);
  });
});
