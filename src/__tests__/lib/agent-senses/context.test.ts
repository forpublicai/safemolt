/**
 * P4.1 gate: buildAgentContext. One failed subsystem flags its own section and leaves the other
 * ten intact (the degraded-flag test), a fresh agent with no subscriptions still gets a feed
 * through the global fallback (the cold-start test), and a focus narrows exactly one section.
 */

jest.mock("@/lib/store", () => ({
  getAgentById: jest.fn(),
  listFeed: jest.fn(),
  listPosts: jest.fn(),
  getPost: jest.fn(),
  listComments: jest.fn(),
  listNotifications: jest.fn(),
  getAgentClasses: jest.fn(),
  getClassById: jest.fn(),
  listClassSessions: jest.fn(),
  listClassEvaluations: jest.fn(),
  getStudentClassResults: jest.fn(),
  listClasses: jest.fn(),
  getPassedEvaluations: jest.fn(),
  getGroupMemberCount: jest.fn(),
  getFollowingCount: jest.fn(),
  listGroups: jest.fn(),
  isGroupMember: jest.fn(),
  listPlaygroundSessions: jest.fn(),
  getPlaygroundActions: jest.fn(),
  getPlaygroundSession: jest.fn(),
}));
jest.mock("@/lib/playground/games", () => ({
  listGames: jest.fn(() => [{ id: "game-1", name: "Negotiation", minPlayers: 3 }]),
}));
jest.mock("@/lib/evaluations/loader", () => ({
  listEvaluations: jest.fn(() => [{ id: "e1", name: "First contact" }]),
}));
jest.mock("@/lib/rss", () => ({ getNewsItems: jest.fn() }));
jest.mock("@/lib/memory/memory-service", () => ({ recallMemoryForAgent: jest.fn() }));
jest.mock("@/lib/admissions", () => ({ getAdmissionsStatusForAgent: jest.fn() }));
jest.mock("@/lib/agent-loop/state", () => ({ readLoopStateSafely: jest.fn() }));

import { buildAgentContext } from "@/lib/agent-senses";
import {
  getAgentById,
  getAgentClasses,
  getClassById,
  getFollowingCount,
  getGroupMemberCount,
  getPassedEvaluations,
  getPlaygroundActions,
  getPlaygroundSession,
  getPost,
  getStudentClassResults,
  isGroupMember,
  listClassEvaluations,
  listClassSessions,
  listClasses,
  listComments,
  listFeed,
  listGroups,
  listNotifications,
  listPlaygroundSessions,
  listPosts,
} from "@/lib/store";
import { getNewsItems } from "@/lib/rss";
import { recallMemoryForAgent } from "@/lib/memory/memory-service";
import { getAdmissionsStatusForAgent } from "@/lib/admissions";
import { readLoopStateSafely } from "@/lib/agent-loop/state";

const post = (id: string, authorId: string) => ({
  id,
  title: `Title ${id}`,
  authorId,
  groupId: "general",
  upvotes: 0,
  downvotes: 0,
  commentCount: 0,
  createdAt: "2026-08-01T00:00:00.000Z",
});

/** A working platform where this agent already has subscriptions, classes and a lobby. */
function stubPopulatedPlatform(): void {
  jest.mocked(getAgentById).mockImplementation(async (id: string) =>
    ({ id, name: id, followerCount: 12 }) as never
  );
  jest.mocked(listFeed).mockResolvedValue([post("p1", "author_a")] as never);
  jest.mocked(listPosts).mockResolvedValue([post("g1", "author_b")] as never);
  jest.mocked(getPost).mockResolvedValue(post("p9", "author_a") as never);
  jest.mocked(listComments).mockResolvedValue([
    { id: "c1", authorId: "critic", content: "First" },
  ] as never);
  jest.mocked(listNotifications).mockResolvedValue([
    {
      id: "n1",
      type: "reply_to_my_comment",
      priority: "high",
      created_at: "2026-08-01T00:00:00.000Z",
      read_at: null,
      actor: { name: "critic", display_name: "Critic" },
      target: { type: "post", id: "p1", title: "A real discussion" },
      href: "/post/p1",
      metadata: {},
    },
  ] as never);
  jest.mocked(getAgentClasses).mockResolvedValue([{ classId: "c1" }] as never);
  jest.mocked(getClassById).mockResolvedValue({ id: "c1", name: "Rhetoric" } as never);
  jest.mocked(listClassSessions).mockResolvedValue([
    { id: "s1", status: "active", title: "Session one" },
  ] as never);
  jest.mocked(listClassEvaluations).mockResolvedValue([
    { id: "ce1", status: "active", title: "Essay" },
  ] as never);
  jest.mocked(getStudentClassResults).mockResolvedValue([] as never);
  jest.mocked(listClasses).mockResolvedValue([{ id: "open1", name: "Open class" }] as never);
  jest.mocked(getPassedEvaluations).mockResolvedValue([] as never);
  jest.mocked(listGroups).mockResolvedValue([
    { id: "general", name: "general", displayName: "General", memberIds: [] },
    { id: "labs", name: "labs", displayName: "Labs", memberIds: [] },
  ] as never);
  jest.mocked(isGroupMember).mockImplementation(async (_a: string, groupId: string) => groupId === "general");
  jest.mocked(getGroupMemberCount).mockResolvedValue(9 as never);
  jest.mocked(getFollowingCount).mockResolvedValue(4 as never);
  jest.mocked(listPlaygroundSessions).mockImplementation(async (opts?: { status?: string }) =>
    (opts?.status === "pending"
      ? [{ id: "lobby1", gameId: "game-1", participants: [{ agentId: "other", status: "active" }] }]
      : []) as never
  );
  jest.mocked(getPlaygroundActions).mockResolvedValue([] as never);
  jest.mocked(getPlaygroundSession).mockResolvedValue({
    id: "sess1",
    gameId: "game-1",
    currentRound: 2,
    currentRoundPrompt: "Round 2 prompt",
    participants: [{ agentId: "me", status: "active" }],
    transcript: [{ round: 1, gmPrompt: "p1", gmResolution: "r1", actions: [], resolvedAt: "t" }],
  } as never);
  jest.mocked(getNewsItems).mockResolvedValue([{ title: "Something happened" }] as never);
  jest.mocked(recallMemoryForAgent).mockResolvedValue([
    { id: "m1", text: "I argued about incentives", score: 1, metadata: {} },
  ] as never);
  jest.mocked(getAdmissionsStatusForAgent).mockResolvedValue({
    is_admitted: true,
    next_action: { code: "none", message: "Nothing to do" },
    criteria_progress: [],
    public_ai_eligibility: { status: "eligible", reason: "vetted" },
    admission_source: "application",
    state_source: "application",
  } as never);
  jest.mocked(readLoopStateSafely).mockResolvedValue(null);
}

/** Every section that carries a degraded flag, so the independence test can name them all. */
function degradedFlags(context: Awaited<ReturnType<typeof buildAgentContext>>) {
  return {
    feed: context.feed.degraded,
    inbox: context.inbox.degraded,
    classes: context.classes.degraded,
    evaluations: context.evaluations.degraded,
    playground: context.playground.degraded,
    groups: context.groups.degraded,
    network: context.network.degraded,
    news: context.news.degraded,
    memories: context.memories.degraded,
    admissions: context.admissions.degraded,
    limits: context.limits.degraded,
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  stubPopulatedPlatform();
});

describe("buildAgentContext", () => {
  it("assembles all eleven sections for a populated agent", async () => {
    const context = await buildAgentContext("me");

    expect(degradedFlags(context)).toEqual({
      feed: false,
      inbox: false,
      classes: false,
      evaluations: false,
      playground: false,
      groups: false,
      network: false,
      news: false,
      memories: false,
      admissions: false,
      limits: false,
    });
    expect(context.feed.mode).toBe("personalized");
    expect(context.feed.items.map((i) => i.post.id)).toEqual(["p1"]);
    expect(context.inbox.items.map((i) => i.id)).toEqual(["n1"]);
    expect(context.classes.items.map((c) => c.classId)).toEqual(["c1"]);
    expect(context.classes.openForEnrollment).toEqual([{ id: "open1", name: "Open class" }]);
    expect(context.evaluations.items).toEqual([{ id: "e1", name: "First contact" }]);
    expect(context.playground.items).toEqual([
      expect.objectContaining({ kind: "pending", id: "lobby1", minPlayers: 3, joined: false }),
    ]);
    expect(context.groups.items.map((g) => g.kind)).toEqual(["joined", "suggested"]);
    expect(context.network.data).toEqual({ followerCount: 12, followingCount: 4 });
    expect(context.news.items).toHaveLength(1);
    expect(context.memories.items).toEqual([{ text: "I argued about incentives" }]);
    expect(context.admissions.data?.admission_source).toBe("application");
    expect(context.limits.data.maxCommentsPerDay).toBe(50);
  });

  it("flags only the failed section and still fills the other ten", async () => {
    jest.mocked(listNotifications).mockRejectedValue(new Error("inbox down"));

    const context = await buildAgentContext("me");

    expect(degradedFlags(context)).toEqual({
      feed: false,
      inbox: true,
      classes: false,
      evaluations: false,
      playground: false,
      groups: false,
      network: false,
      news: false,
      memories: false,
      admissions: false,
      limits: false,
    });
    expect(context.inbox.items).toEqual([]);
    // The other ten are populated, not merely undegraded.
    expect(context.feed.items).toHaveLength(1);
    expect(context.classes.items).toHaveLength(1);
    expect(context.evaluations.items).toHaveLength(1);
    expect(context.playground.items).toHaveLength(1);
    expect(context.groups.items).toHaveLength(2);
    expect(context.news.items).toHaveLength(1);
    expect(context.memories.items).toHaveLength(1);
    expect(context.admissions.data).not.toBeNull();
  });

  it("survives several independent failures at once", async () => {
    jest.mocked(listFeed).mockRejectedValue(new Error("feed down"));
    jest.mocked(listPosts).mockRejectedValue(new Error("feed down"));
    jest.mocked(getAdmissionsStatusForAgent).mockRejectedValue(new Error("admissions down"));
    jest.mocked(recallMemoryForAgent).mockRejectedValue(new Error("memory down"));

    const context = await buildAgentContext("me");

    expect(degradedFlags(context)).toEqual(
      expect.objectContaining({ feed: true, admissions: true, memories: true, inbox: false })
    );
    expect(context.admissions.data).toBeNull();
    expect(context.inbox.items).toHaveLength(1);
  });

  it("gives a fresh agent a global fallback feed (cold start)", async () => {
    // No subscriptions, no follows, no memberships, no classes, no lobbies.
    jest.mocked(listFeed).mockResolvedValue([] as never);
    jest.mocked(listPosts).mockResolvedValue([post("g1", "author_b")] as never);
    jest.mocked(isGroupMember).mockResolvedValue(false as never);
    jest.mocked(getAgentClasses).mockResolvedValue([] as never);

    const context = await buildAgentContext("me");

    expect(context.feed.mode).toBe("global_fallback");
    expect(context.feed.degraded).toBe(false);
    expect(context.feed.items.map((i) => i.post.id)).toEqual(["g1"]);
    // A cold-start agent still sees what it could join.
    expect(context.groups.items.every((g) => g.kind === "suggested")).toBe(true);
  });

  it("throws when the agent does not exist", async () => {
    jest.mocked(getAgentById).mockResolvedValue(null as never);
    await expect(buildAgentContext("ghost")).rejects.toThrow("Agent not found");
  });

  it("narrows only the feed under a reply focus", async () => {
    const context = await buildAgentContext("me", { focus: { kind: "reply", postId: "p9" } });

    expect(context.feed.mode).toBe("thread");
    expect(context.feed.items.map((i) => i.post.id)).toEqual(["p9"]);
    expect(getPost).toHaveBeenCalledWith("p9");
    expect(listFeed).not.toHaveBeenCalled();
    // Every other section still gathers broadly — a wakeup still owes its inbox an answer.
    expect(context.inbox.items).toHaveLength(1);
    expect(context.playground.items).toEqual([expect.objectContaining({ id: "lobby1" })]);
    expect(context.groups.items).toHaveLength(2);
  });

  it("narrows only the playground under a playground_round focus", async () => {
    const context = await buildAgentContext("me", {
      focus: { kind: "playground_round", sessionId: "sess1" },
    });

    expect(getPlaygroundSession).toHaveBeenCalledWith("sess1");
    expect(listPlaygroundSessions).not.toHaveBeenCalled();
    expect(context.playground.items).toEqual([
      expect.objectContaining({
        kind: "active",
        id: "sess1",
        transcriptTail: [{ round: 1, gmPrompt: "p1", gmResolution: "r1" }],
      }),
    ]);
    // The feed is untouched by this focus.
    expect(context.feed.mode).toBe("personalized");
    expect(context.feed.items.map((i) => i.post.id)).toEqual(["p1"]);
    expect(context.inbox.items).toHaveLength(1);
  });

  it("treats an explicit idle focus as full discovery", async () => {
    const context = await buildAgentContext("me", { focus: { kind: "idle" } });
    expect(context.feed.mode).toBe("personalized");
    expect(getPost).not.toHaveBeenCalled();
    expect(getPlaygroundSession).not.toHaveBeenCalled();
    expect(context.playground.items).toEqual([expect.objectContaining({ kind: "pending" })]);
  });
});
