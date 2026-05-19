import type { StoredAgent } from "@/lib/store-types";

const agent = {
  id: "agent_loop_test",
  name: "looptest",
  displayName: "Loop Test",
  description: "test",
  identityMd: "occasional poster",
} as StoredAgent;

/** A representative slice of real platform tools spanning discovery + two domains. */
const PLATFORM_TOOLS = [
  "list_feed",
  "list_groups",
  "list_playground_sessions",
  "list_playground_games",
  "create_post",
  "create_comment",
  "upvote_post",
  "join_group",
  "join_playground_session",
  "submit_playground_action",
  "get_playground_session",
].map((name) => ({
  type: "function" as const,
  function: { name, description: name, parameters: { type: "object" } },
}));

type LlmResponse = { content?: string | null; toolCalls?: unknown[] };

const ORIGINAL_HF_TOKEN = process.env.HF_TOKEN;

afterEach(() => {
  if (ORIGINAL_HF_TOKEN === undefined) delete process.env.HF_TOKEN;
  else process.env.HF_TOKEN = ORIGINAL_HF_TOKEN;
});

function baseStore(overrides: Record<string, unknown> = {}) {
  return {
    getAgentById: jest.fn(async (id: string) =>
      id === agent.id ? agent : ({ id, name: `agent_${id}` } as StoredAgent)
    ),
    listPosts: jest.fn(async () => []),
    listComments: jest.fn(async () => []),
    getAgentClasses: jest.fn(async () => []),
    getClassById: jest.fn(),
    listClassSessions: jest.fn(async () => []),
    listClassEvaluations: jest.fn(async () => []),
    listClasses: jest.fn(async () => []),
    setAgentVetted: jest.fn(),
    setAgentIdentityMd: jest.fn(),
    listPlaygroundSessions: jest.fn(async () => []),
    getPlaygroundActions: jest.fn(async () => []),
    getPassedEvaluations: jest.fn(async () => []),
    ensureGeneralGroup: jest.fn(async () => undefined),
    listNotifications: jest.fn(async () => []),
    listGroups: jest.fn(async () => []),
    getFollowingCount: jest.fn(async () => 0),
    ...overrides,
  };
}

async function setup(opts: {
  llmResponses: LlmResponse[];
  store?: Record<string, unknown>;
  executeTool?: jest.Mock;
  evaluations?: { id: string; name: string; status?: string }[];
  linkedUserIds?: string[];
  inferenceSecrets?: Record<string, unknown> | null;
  sponsored?: boolean;
  hfToken?: string | null;
  sponsoredUsage?: { count: number; limit: number };
}) {
  jest.resetModules();

  const callLLM = jest.fn();
  for (const r of opts.llmResponses) {
    callLLM.mockResolvedValueOnce({ content: r.content ?? null, toolCalls: r.toolCalls ?? [] });
  }
  const sql = jest.fn(async (_strings: TemplateStringsArray, ...values: unknown[]) =>
    typeof values[1] === "string" ? [{ id: "log_1" }] : []
  );
  const executeTool =
    opts.executeTool ?? jest.fn(async (name: string) => ({ success: true, data: { tool: name } }));
  if (Object.prototype.hasOwnProperty.call(opts, "hfToken")) {
    if (opts.hfToken == null) delete process.env.HF_TOKEN;
    else process.env.HF_TOKEN = opts.hfToken;
  } else {
    process.env.HF_TOKEN = ORIGINAL_HF_TOKEN ?? "platform-token";
  }
  const makeHfRouterCallLLM = jest.fn(() => callLLM);
  const incrementSponsoredInferenceUsage = jest.fn(async () => opts.sponsoredUsage ?? { count: 1, limit: 100 });

  jest.doMock("@/lib/db", () => ({ sql }));
  jest.doMock("@/lib/agent-tools", () => ({ PLATFORM_TOOLS, executeTool }));
  jest.doMock("@/lib/agent-runtime/adapters/openai-compatible", () => ({
    makeHfRouterCallLLM,
    makeOpenAiCallLLM: jest.fn(),
  }));
  jest.doMock("@/lib/store", () => baseStore(opts.store));
  jest.doMock("@/lib/human-users", () => ({
    listUserIdsLinkedToAgent: jest.fn(async () => opts.linkedUserIds ?? ["user_1"]),
    getUserInferenceSecrets: jest.fn(async () =>
      Object.prototype.hasOwnProperty.call(opts, "inferenceSecrets")
        ? opts.inferenceSecrets
        : { hf_token_override: "token" }
    ),
    getUserInferenceTokenOverride: jest.fn(),
    incrementSponsoredInferenceUsage,
  }));
  jest.doMock("@/lib/memory/sponsored-public-ai", () => ({
    isSponsoredPublicAiAgent: jest.fn(async () => opts.sponsored ?? false),
  }));
  jest.doMock("@/lib/memory/memory-service", () => ({
    recallMemoryForAgent: jest.fn(async () => []),
    upsertVectorForAgent: jest.fn(async () => undefined),
  }));
  jest.doMock("@/lib/agent-identity-generator", () => ({
    isPlaceholderIdentity: jest.fn(() => false),
    generateRandomIdentity: jest.fn(),
  }));
  jest.doMock("@/lib/evaluations/loader", () => ({ listEvaluations: jest.fn(() => opts.evaluations ?? []) }));
  jest.doMock("@/lib/playground/games", () => ({ listGames: jest.fn(() => []) }));
  jest.doMock("@/lib/rss", () => ({ getNewsItems: jest.fn(async () => []) }));
  jest.doMock("@/lib/store/activity/events", () => ({ recordAgentLoopActivityEvent: jest.fn() }));
  jest.doMock("@/lib/agent-loop-actions", () => ({ listRecentLoopActions: jest.fn(async () => []) }));

  const { tickAgent } = await import("@/lib/agent-loop");
  return { tickAgent, executeTool, sql, callLLM, makeHfRouterCallLLM, incrementSponsoredInferenceUsage };
}

const toolNames = (defs: unknown): string[] =>
  (defs as { function: { name: string } }[]).map((d) => d.function.name);

const loggedActions = (sql: jest.Mock): string[] =>
  sql.mock.calls
    .map((call) => call[2])
    .filter((value): value is string => typeof value === "string" && PLATFORM_TOOLS.some((t) => t.function.name === value));

const feedPost = {
  id: "post_1",
  title: "A topic",
  content: "body text",
  authorId: "agent_other",
  groupId: "g1",
  upvotes: 1,
  downvotes: 0,
  commentCount: 0,
  createdAt: "2026-05-18T00:00:00.000Z",
};

const activePlaygroundStore = {
  listPlaygroundSessions: jest.fn(async (q: { status: string }) =>
    q.status === "active"
      ? [
          {
            id: "sess_1",
            gameId: "game_1",
            currentRound: 1,
            currentRoundPrompt: "What do you do?",
            participants: [{ agentId: agent.id, status: "active" }],
          },
        ]
      : []
  ),
};

describe("agent loop two-tier router (ADR-0001)", () => {
  it("routes an active playground obligation straight to the playground domain", async () => {
    const { tickAgent, executeTool, callLLM } = await setup({
      store: activePlaygroundStore,
      llmResponses: [
        {
          content: null,
          toolCalls: [
            {
              id: "c1",
              name: "submit_playground_action",
              arguments: { session_id: "sess_1", content: "explore the ridge" },
            },
          ],
        },
      ],
    });

    const result = await tickAgent(agent.id);

    expect(result.action).toBe("submit_playground_action");
    expect(callLLM).toHaveBeenCalledTimes(1);
    expect(executeTool).toHaveBeenCalledWith(
      "submit_playground_action",
      { session_id: "sess_1", content: "explore the ridge" },
      agent
    );
    // The single round is scoped to the playground domain slice — never the full surface.
    const offered = toolNames(callLLM.mock.calls[0][1]);
    expect(offered).toContain("submit_playground_action");
    expect(offered).not.toContain("create_post");
    expect(offered).not.toContain("list_groups");
    expect(offered.length).toBeLessThan(PLATFORM_TOOLS.length);
  });

  it("discovers a domain, then runs one terminal action when there is no hard obligation", async () => {
    const { tickAgent, executeTool, callLLM, sql } = await setup({
      store: { listPosts: jest.fn(async () => [feedPost]) },
      evaluations: [{ id: "eval_available", name: "Available evaluation", status: "active" }],
      llmResponses: [
        // Discovery stage: read, then declare a domain.
        { content: null, toolCalls: [{ id: "d1", name: "list_feed", arguments: {} }] },
        { content: "DOMAIN: discussion", toolCalls: [] },
        // Domain stage: one terminal action.
        {
          content: null,
          toolCalls: [
            { id: "t1", name: "create_comment", arguments: { post_id: "post_1", content: "good point" } },
          ],
        },
      ],
    });

    const result = await tickAgent(agent.id);

    expect(result.action).toBe("create_comment");
    expect(callLLM).toHaveBeenCalledTimes(3);
    expect(executeTool.mock.calls.map((c) => c[0])).toEqual(["list_feed", "create_comment"]);

    // Discovery round sees only read tools; domain round sees only discussion tools.
    const discoveryTools = toolNames(callLLM.mock.calls[0][1]);
    expect(discoveryTools).toContain("list_feed");
    expect(discoveryTools).not.toContain("create_post");
    expect(discoveryTools).not.toContain("create_comment");
    const domainTools = toolNames(callLLM.mock.calls[2][1]);
    expect(domainTools).toContain("create_comment");
    expect(domainTools).not.toContain("list_groups");
    expect(JSON.stringify(callLLM.mock.calls[2][0])).toContain("## Domain action stage: discussion");
    expect(JSON.stringify(callLLM.mock.calls[2][0])).toContain("Take at most ONE terminal");
    // No loop round ever receives the whole platform surface (old behavior is gone).
    for (const call of callLLM.mock.calls) {
      expect((call[1] as unknown[]).length).toBeLessThan(PLATFORM_TOOLS.length);
    }

    // Only the terminal tool is journaled — the read-only discovery call is not.
    expect(loggedActions(sql)).toEqual(["create_comment"]);
  });

  it("lets discovery use its full read budget before declaring a domain", async () => {
    const { tickAgent, executeTool, callLLM, sql } = await setup({
      store: { listPosts: jest.fn(async () => [feedPost]) },
      llmResponses: [
        {
          content: null,
          toolCalls: [
            { id: "d1", name: "list_feed", arguments: {} },
            { id: "d2", name: "list_groups", arguments: {} },
          ],
        },
        { content: "DOMAIN: groups", toolCalls: [] },
        {
          content: null,
          toolCalls: [{ id: "t1", name: "join_group", arguments: { group_name: "builders" } }],
        },
      ],
    });

    const result = await tickAgent(agent.id);

    expect(result.action).toBe("join_group");
    expect(callLLM).toHaveBeenCalledTimes(3);
    expect(executeTool.mock.calls.map((c) => c[0])).toEqual(["list_feed", "list_groups", "join_group"]);
    expect(loggedActions(sql)).toEqual(["join_group"]);
  });

  it("allows an unlinked agent to participate through platform inference", async () => {
    const { tickAgent, executeTool, sql, makeHfRouterCallLLM, incrementSponsoredInferenceUsage } = await setup({
      linkedUserIds: [],
      hfToken: "platform-token",
      store: { listPosts: jest.fn(async () => [feedPost]) },
      llmResponses: [
        { content: "DOMAIN: discussion", toolCalls: [] },
        {
          content: null,
          toolCalls: [{ id: "t1", name: "create_comment", arguments: { post_id: "post_1", content: "joining in" } }],
        },
        { content: "commented", toolCalls: [] },
      ],
    });

    const result = await tickAgent(agent.id);

    expect(result.action).toBe("create_comment");
    expect(executeTool.mock.calls.map((c) => c[0])).toEqual(["create_comment"]);
    expect(loggedActions(sql)).toEqual(["create_comment"]);
    expect(makeHfRouterCallLLM).toHaveBeenCalledWith({ apiKey: "platform-token", billToPublicAi: true });
    expect(incrementSponsoredInferenceUsage).not.toHaveBeenCalled();
  });

  it("falls back to platform inference when a linked owner has no configured provider", async () => {
    const { tickAgent, executeTool, makeHfRouterCallLLM, incrementSponsoredInferenceUsage } = await setup({
      linkedUserIds: ["user_without_provider"],
      inferenceSecrets: null,
      hfToken: "platform-token",
      store: { listPosts: jest.fn(async () => [feedPost]) },
      llmResponses: [
        { content: "DOMAIN: discussion", toolCalls: [] },
        {
          content: null,
          toolCalls: [{ id: "t1", name: "create_comment", arguments: { post_id: "post_1", content: "fallback works" } }],
        },
        { content: "commented", toolCalls: [] },
      ],
    });

    const result = await tickAgent(agent.id);

    expect(result.action).toBe("create_comment");
    expect(executeTool.mock.calls.map((c) => c[0])).toEqual(["create_comment"]);
    expect(incrementSponsoredInferenceUsage).toHaveBeenCalledWith("user_without_provider");
    expect(makeHfRouterCallLLM).toHaveBeenCalledWith({ apiKey: "platform-token", billToPublicAi: true });
  });

  it("rejects linked platform fallback when sponsored daily usage is exhausted", async () => {
    const { tickAgent, incrementSponsoredInferenceUsage } = await setup({
      linkedUserIds: ["limited_user"],
      inferenceSecrets: null,
      hfToken: "platform-token",
      sponsoredUsage: { count: 101, limit: 100 },
      store: { listPosts: jest.fn(async () => [feedPost]) },
      llmResponses: [],
    });

    await expect(tickAgent(agent.id)).rejects.toThrow("Sponsored daily limit reached");
    expect(incrementSponsoredInferenceUsage).toHaveBeenCalledWith("limited_user");
  });

  it("fails unlinked agents only when no platform inference token is configured", async () => {
    const { tickAgent } = await setup({
      linkedUserIds: [],
      hfToken: null,
      store: { listPosts: jest.fn(async () => [feedPost]) },
      llmResponses: [],
    });

    await expect(tickAgent(agent.id)).rejects.toThrow("No inference provider configured for unlinked agent");
  });

  it("uses a linked owner's HF override without platform billing", async () => {
    const { tickAgent, makeHfRouterCallLLM, incrementSponsoredInferenceUsage } = await setup({
      linkedUserIds: ["owner_with_token"],
      inferenceSecrets: { hf_token_override: "owner-token" },
      hfToken: "platform-token",
      store: { listPosts: jest.fn(async () => [feedPost]) },
      llmResponses: [
        { content: "DOMAIN: discussion", toolCalls: [] },
        {
          content: null,
          toolCalls: [{ id: "t1", name: "create_comment", arguments: { post_id: "post_1", content: "owner token" } }],
        },
        { content: "commented", toolCalls: [] },
      ],
    });

    const result = await tickAgent(agent.id);

    expect(result.action).toBe("create_comment");
    expect(makeHfRouterCallLLM).toHaveBeenCalledWith({ apiKey: "owner-token", billToPublicAi: false });
    expect(incrementSponsoredInferenceUsage).not.toHaveBeenCalled();
  });

  it("records a skip when discovery chooses no domain", async () => {
    const { tickAgent, executeTool, sql } = await setup({
      store: { listPosts: jest.fn(async () => [feedPost]) },
      llmResponses: [
        { content: null, toolCalls: [{ id: "d1", name: "list_feed", arguments: {} }] },
        { content: "Nothing here is worth a response right now.", toolCalls: [] },
      ],
    });

    const result = await tickAgent(agent.id);

    expect(result.action).toBe("skip");
    expect(executeTool.mock.calls.map((c) => c[0])).toEqual(["list_feed"]);
    expect(loggedActions(sql)).toEqual([]);
  });
});
