import {
  dedupeActivities,
  filterActivities,
  formatTrailTimestamp,
  relativeActivityAge,
  type ActivityItem,
} from "@/lib/activity";
import { buildDeterministicContext } from "@/lib/activity-context";
import { isPublicPlatformMemoryKind } from "@/lib/memory/memory-service";

describe("activity trail helpers", () => {
  it("counts agents in the in-memory store without listing them", async () => {
    const { createAgent, countAgents } = await import("@/lib/store/agents/memory");
    const before = await countAgents();
    await createAgent(`count-test-${Date.now()}`, "count test");
    expect(await countAgents()).toBe(before + 1);
  });

  it("formats trail timestamps in mockup style", () => {
    expect(formatTrailTimestamp("2026-04-23T14:12:00.000Z")).toMatch(/04-23 \d{2}:12/);
  });

  it("falls back to deterministic context when LLM context is unavailable", () => {
    const activity: ActivityItem = {
      id: "post_1",
      kind: "post",
      occurredAt: "2026-04-23T14:12:00.000Z",
      timestampLabel: "04-23 14:12",
      title: "A poet walks into a network",
      segments: [],
      summary: "Martin submitted a new post.",
      contextHint: "A poet walks into a network",
      searchText: "Martin post A poet walks into a network",
    };

    const context = buildDeterministicContext(activity, [
      {
        id: "mem_1",
        kind: "platform_post",
        text: "Martin has recently been exploring network-shaped writing prompts.",
        filedAt: "2026-04-23T14:12:00.000Z",
        metadata: { kind: "platform_post" },
      },
    ]);

    expect(context).toContain("Martin submitted a new post.");
    expect(context).toContain("Related public memory");
  });

  it("only treats platform-ingested memory kinds as public", () => {
    expect(isPublicPlatformMemoryKind("platform_post")).toBe(true);
    expect(isPublicPlatformMemoryKind("playground_action")).toBe(true);
    expect(isPublicPlatformMemoryKind("context_file")).toBe(false);
    expect(isPublicPlatformMemoryKind("note")).toBe(false);
  });

  it("describes current activity age", () => {
    expect(relativeActivityAge(new Date().toISOString())).toBe("just now");
  });

  it("filters by hidden search text and activity type", () => {
    const activities: ActivityItem[] = [
      {
        id: "post_1",
        kind: "post",
        occurredAt: "2026-04-23T14:12:00.000Z",
        timestampLabel: "04-23 14:12",
        title: "This is the full post title hidden by truncation",
        segments: [],
        summary: "Post: This is the full...",
        contextHint: "",
        searchText: "orin post This is the full post title hidden by truncation",
      },
      {
        id: "eval_1",
        kind: "evaluation_result",
        occurredAt: "2026-04-23T15:12:00.000Z",
        timestampLabel: "04-23 15:12",
        title: "SIP-6",
        segments: [],
        summary: "Evaluation",
        contextHint: "",
        searchText: "chaos evaluation SIP-6",
      },
    ];

    expect(filterActivities(activities, { query: "hidden by truncation" })).toHaveLength(1);
    expect(filterActivities(activities, { types: ["evaluations"] })[0]?.kind).toBe("evaluation_result");
  });

  it("dedupes agent-loop post echoes when the real post is present", () => {
    const realPost: ActivityItem = {
      id: "post_1",
      kind: "post",
      occurredAt: "2026-04-23T14:12:00.000Z",
      timestampLabel: "04-23 14:12",
      title: "A post",
      segments: [],
      summary: "Post",
      contextHint: "",
      searchText: "post",
      metadata: { post_id: "post_1" },
    };
    const loopEcho: ActivityItem = {
      id: "loop_1",
      kind: "agent_loop",
      occurredAt: "2026-04-23T14:13:00.000Z",
      timestampLabel: "04-23 14:13",
      title: "loop",
      segments: [],
      summary: "loop",
      contextHint: "",
      searchText: "loop",
      metadata: { target_type: "post", target_id: "post_1" },
    };

    expect(dedupeActivities([realPost, loopEcho])).toEqual([realPost]);
  });

  it("builds the trail page with countAgents instead of listAgents", async () => {
    jest.resetModules();
    const countAgents = jest.fn(async () => 7);
    const listAgents = jest.fn(async () => []);
    const listActivityFeed = jest.fn(async () => []);

    jest.doMock("@/lib/store", () => ({
      countAgents,
      listAgents,
      listActivityFeed,
      listClasses: jest.fn(),
      getAgentById: jest.fn(),
      getGroup: jest.fn(),
      getPost: jest.fn(),
      listPosts: jest.fn(),
      listRecentCommentsWithPosts: jest.fn(),
      listRecentEvaluationResults: jest.fn(),
      listPlaygroundSessions: jest.fn(),
      listRecentPlaygroundActions: jest.fn(),
      listRecentAgentLoopActions: jest.fn(),
      getCachedActivityContext: jest.fn(),
      upsertActivityContext: jest.fn(),
      claimActivityContextEnrichment: jest.fn(),
      clearActivityContextEnrichmentClaim: jest.fn(),
    }));
    jest.doMock("@/lib/db", () => ({ hasDatabase: () => false }));
    jest.doMock("@/lib/evaluations/loader", () => ({ getEvaluation: () => null }));
    jest.doMock("@/lib/playground/games", () => ({ getGame: () => null }));
    jest.doMock("@/lib/playground/llm", () => ({ chatCompletionHfRouter: jest.fn() }));
    jest.doMock("@/lib/utils", () => ({ getAgentDisplayName: (agent: { name: string }) => agent.name }));
    jest.doMock("@/lib/memory/memory-service", () => ({
      listPublicPlatformMemoriesForAgent: jest.fn(async () => []),
      isPublicPlatformMemoryKind: jest.fn(),
    }));

    const { getActivityTrailPage } = await import("@/lib/activity");
    const data = await getActivityTrailPage({ limit: 5 });

    expect(data.stats.agentsEnrolled).toBe(7);
    expect(countAgents).toHaveBeenCalledTimes(1);
    expect(listAgents).not.toHaveBeenCalled();
    expect(listActivityFeed).toHaveBeenCalledWith({ limit: 6 });
  });
});
