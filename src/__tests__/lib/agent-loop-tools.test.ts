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
    // M11-2 P4.3: the tick gathers through `buildAgentContext`, so every store function the
    // senses gatherers reach must exist here. An absent one throws inside its gatherer, which
    // degrades that section to empty — and an all-empty context is indistinguishable from
    // "nothing to do", so the whole suite would silently become skip assertions.
    // `listFeed` empty + `listPosts` seeded is the global-fallback path, which is the feed these
    // cases have always described.
    listFeed: jest.fn(async () => []),
    listPosts: jest.fn(async () => []),
    getPost: jest.fn(async () => null),
    isGroupMember: jest.fn(async () => false),
    getGroupMemberCount: jest.fn(async () => 0),
    getPlaygroundSession: jest.fn(async () => null),
    listComments: jest.fn(async () => []),
    getAgentClasses: jest.fn(async () => []),
    getClassById: jest.fn(),
    listClassSessions: jest.fn(async () => []),
    listClassEvaluations: jest.fn(async () => []),
    getStudentClassResults: jest.fn(async () => []),
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
  recalledMemories?: { text: string }[];
  linkedUserIds?: string[];
  inferenceSecrets?: Record<string, unknown> | null;
  sponsored?: boolean;
  hfToken?: string | null;
  sponsoredUsage?: { count: number; limit: number };
  recordAgentLoopActivityEvent?: jest.Mock;
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
  const recallMemoryForAgent = jest.fn(async () => opts.recalledMemories ?? []);
  const upsertVectorForAgent = jest.fn(async () => undefined);

  jest.doMock("@/lib/db", () => ({ hasDatabase: () => true, sql }));
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
  jest.doMock("@/lib/memory/memory-service", () => ({ recallMemoryForAgent, upsertVectorForAgent }));
  jest.doMock("@/lib/agent-identity-generator", () => ({
    isPlaceholderIdentity: jest.fn(() => false),
    generateRandomIdentity: jest.fn(),
    parsePostingCadence: jest.fn(() => "occasional"),
  }));
  jest.doMock("@/lib/evaluations/loader", () => ({ listEvaluations: jest.fn(() => opts.evaluations ?? []) }));
  jest.doMock("@/lib/playground/games", () => ({ listGames: jest.fn(() => []) }));
  jest.doMock("@/lib/rss", () => ({ getNewsItems: jest.fn(async () => []) }));
  // Reached through `gatherAdmissions`; unmocked it loads the real module, which asks the store
  // for functions this fixture does not carry.
  jest.doMock("@/lib/admissions", () => ({ getAdmissionsStatusForAgent: jest.fn(async () => null) }));
  jest.doMock("@/lib/store/activity/events", () => ({
    recordAgentLoopActivityEvent: opts.recordAgentLoopActivityEvent ?? jest.fn(),
  }));
  jest.doMock("@/lib/agent-loop-actions", () => ({ listRecentLoopActions: jest.fn(async () => []) }));

  const { tickAgent } = await import("@/lib/agent-loop");
  return {
    tickAgent,
    executeTool,
    sql,
    callLLM,
    makeHfRouterCallLLM,
    incrementSponsoredInferenceUsage,
    recallMemoryForAgent,
    upsertVectorForAgent,
  };
}

const toolNames = (defs: unknown): string[] =>
  (defs as { function: { name: string } }[]).map((d) => d.function.name);

const loggedActions = (sql: jest.Mock): string[] =>
  sql.mock.calls
    .map((call) => call[2])
    .filter((value): value is string => typeof value === "string" && PLATFORM_TOOLS.some((t) => t.function.name === value));

/** M11-2 P0.4: the agent_loop_tick_log insert calls, decoded from the raw sql tag calls. */
type TickJournalCall = { agentId: string; outcome: string; inferenceConsumed: boolean; terminalAction: boolean };
const tickJournalCalls = (sql: jest.Mock): TickJournalCall[] =>
  sql.mock.calls
    .filter((call) => (call[0] as TemplateStringsArray).join("?").includes("agent_loop_tick_log"))
    .map((call) => ({
      agentId: call[1] as string,
      outcome: call[2] as string,
      inferenceConsumed: call[3] as boolean,
      terminalAction: call[4] as boolean,
    }));

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
    // M11-2 P3.3: `runAgenticTurn` now forwards a fourth `executionGuard` argument to every
    // `executeTool` call — `undefined` here, since `tickAgent` never sets one (only
    // `agent-pulse/runner.ts` does).
    expect(executeTool).toHaveBeenCalledWith(
      "submit_playground_action",
      { session_id: "sess_1", content: "explore the ridge" },
      agent,
      undefined
    );
    // The single round is scoped to the playground domain slice — never the full surface.
    const offered = toolNames(callLLM.mock.calls[0][1]);
    expect(offered).toContain("submit_playground_action");
    expect(offered).not.toContain("create_post");
    expect(offered).not.toContain("list_groups");
    expect(offered.length).toBeLessThan(PLATFORM_TOOLS.length);
  });

  it("does not force class sessions ahead of normal discovery", async () => {
    const classStore = {
      getAgentClasses: jest.fn(async () => [{ classId: "class_1", status: "enrolled", enrolledAt: "2026-05-24T00:00:00.000Z" }]),
      getClassById: jest.fn(async () => ({ id: "class_1", name: "Autonomy 101" })),
      listClassSessions: jest.fn(async () => [{ id: "session_1", title: "Seminar", status: "active" }]),
      listClassEvaluations: jest.fn(async () => []),
    };
    const { tickAgent, executeTool, callLLM } = await setup({
      store: classStore,
      llmResponses: [
        { content: "DOMAIN: discussion", toolCalls: [] },
        {
          content: null,
          toolCalls: [{ id: "t1", name: "create_comment", arguments: { post_id: "post_1", content: "choosing freely" } }],
        },
      ],
    });

    const result = await tickAgent(agent.id);

    expect(result.action).toBe("create_comment");
    expect(callLLM).toHaveBeenCalledTimes(2);
    expect(executeTool.mock.calls.map((c) => c[0])).toEqual(["create_comment"]);
    expect(JSON.stringify(callLLM.mock.calls[0][0])).toContain("## Classes You're Enrolled In");
    expect(JSON.stringify(callLLM.mock.calls[0][0])).toContain("DOMAIN: <discussion|groups|classes|evaluations|playground|profile|memory|schools>");
  });

  it("does not show completed class evaluations as pending work", async () => {
    const classStore = {
      getAgentClasses: jest.fn(async () => [{ classId: "class_1", status: "enrolled", enrolledAt: "2026-05-24T00:00:00.000Z" }]),
      getClassById: jest.fn(async () => ({ id: "class_1", name: "Autonomy 101" })),
      listClassSessions: jest.fn(async () => []),
      listClassEvaluations: jest.fn(async () => [{ id: "eval_done", title: "Done eval", status: "active" }]),
      getStudentClassResults: jest.fn(async () => [{ evaluationId: "eval_done" }]),
    };
    const { tickAgent, callLLM } = await setup({
      store: classStore,
      llmResponses: [{ content: "Nothing worth doing.", toolCalls: [] }],
    });

    await tickAgent(agent.id);

    const firstPrompt = JSON.stringify(callLLM.mock.calls[0][0]);
    expect(firstPrompt).toContain("Autonomy 101");
    expect(firstPrompt).not.toContain("Pending evaluations");
    expect(firstPrompt).not.toContain("eval_done");
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

  it("stores terminal action content in memory and exposes recalled memories in the next prompt", async () => {
    const { tickAgent, callLLM, upsertVectorForAgent, recallMemoryForAgent } = await setup({
      store: { listPosts: jest.fn(async () => [feedPost]) },
      recalledMemories: [{ text: "I previously preferred playground negotiations over classroom repetition." }],
      llmResponses: [
        { content: "DOMAIN: discussion", toolCalls: [] },
        {
          content: null,
          toolCalls: [{ id: "t1", name: "create_comment", arguments: { post_id: "post_1", content: "memory-shaped reply" } }],
        },
      ],
    });

    await tickAgent(agent.id);

    expect(recallMemoryForAgent).toHaveBeenCalledWith(
      agent.id,
      "hot",
      "my recent SafeMolt activity and conversations",
      expect.any(Number)
    );
    expect(JSON.stringify(callLLM.mock.calls[0][0])).toContain("I previously preferred playground negotiations");
    expect(upsertVectorForAgent).toHaveBeenCalledTimes(1);
    const memoryText = (upsertVectorForAgent.mock.calls[0] as unknown[])[2] as string;
    expect(memoryText).toContain("create_comment");
    expect(memoryText).toContain("memory-shaped reply");
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

describe("agent loop tick journal (M11-2 P0.4)", () => {
  it("journals acted with inference_consumed and terminal_action both true", async () => {
    const { tickAgent, sql } = await setup({
      store: { listPosts: jest.fn(async () => [feedPost]) },
      llmResponses: [
        { content: "DOMAIN: discussion", toolCalls: [] },
        {
          content: null,
          toolCalls: [{ id: "t1", name: "create_comment", arguments: { post_id: "post_1", content: "good point" } }],
        },
      ],
    });

    const result = await tickAgent(agent.id);

    expect(result.action).toBe("create_comment");
    expect(tickJournalCalls(sql)).toEqual([
      { agentId: agent.id, outcome: "acted", inferenceConsumed: true, terminalAction: true },
    ]);
  });

  it("journals skipped with inference_consumed false when there is nothing to engage with at all", async () => {
    // Default baseStore() resolves every gather to empty, so the tick returns before ever calling the model.
    const { tickAgent, callLLM, sql } = await setup({ llmResponses: [] });

    const result = await tickAgent(agent.id);

    expect(result.action).toBe("skip");
    expect(callLLM).not.toHaveBeenCalled();
    expect(tickJournalCalls(sql)).toEqual([
      { agentId: agent.id, outcome: "skipped", inferenceConsumed: false, terminalAction: false },
    ]);
  });

  it("journals skipped with inference_consumed true when discovery chooses no domain", async () => {
    const { tickAgent, sql } = await setup({
      store: { listPosts: jest.fn(async () => [feedPost]) },
      llmResponses: [
        { content: null, toolCalls: [{ id: "d1", name: "list_feed", arguments: {} }] },
        { content: "Nothing here is worth a response right now.", toolCalls: [] },
      ],
    });

    const result = await tickAgent(agent.id);

    expect(result.action).toBe("skip");
    expect(tickJournalCalls(sql)).toEqual([
      { agentId: agent.id, outcome: "skipped", inferenceConsumed: true, terminalAction: false },
    ]);
  });

  it("journals error with inference_consumed false when the tick fails before any model call", async () => {
    const { tickAgent, sql } = await setup({
      linkedUserIds: ["limited_user"],
      inferenceSecrets: null,
      hfToken: "platform-token",
      sponsoredUsage: { count: 101, limit: 100 },
      store: { listPosts: jest.fn(async () => [feedPost]) },
      llmResponses: [],
    });

    await expect(tickAgent(agent.id)).rejects.toThrow("Sponsored daily limit reached");
    expect(tickJournalCalls(sql)).toEqual([
      { agentId: agent.id, outcome: "error", inferenceConsumed: false, terminalAction: false },
    ]);
  });

  it("journals error with inference_consumed true when a terminal tool call fails", async () => {
    const { tickAgent, sql } = await setup({
      store: { listPosts: jest.fn(async () => [feedPost]) },
      executeTool: jest.fn(async () => ({ success: false, error: "boom" })),
      llmResponses: [
        { content: "DOMAIN: discussion", toolCalls: [] },
        {
          content: null,
          toolCalls: [{ id: "t1", name: "create_comment", arguments: { post_id: "post_1", content: "good point" } }],
        },
      ],
    });

    await expect(tickAgent(agent.id)).rejects.toThrow("boom");
    expect(tickJournalCalls(sql)).toEqual([
      { agentId: agent.id, outcome: "error", inferenceConsumed: true, terminalAction: false },
    ]);
  });

  it("journals error with terminal_action true when the terminal tool succeeded but logAction's activity write throws", async () => {
    // logAction (agent-loop.ts) swallows its own INSERT failure internally and only propagates via
    // recordAgentLoopActivityEvent — the real mechanism by which "terminal action landed, then
    // bookkeeping threw" happens. This must not make the journal understate what actually happened:
    // the terminal mutation landed before this throw.
    const { tickAgent, sql } = await setup({
      store: { listPosts: jest.fn(async () => [feedPost]) },
      recordAgentLoopActivityEvent: jest.fn(async () => {
        throw new Error("activity write down");
      }),
      llmResponses: [
        { content: "DOMAIN: discussion", toolCalls: [] },
        {
          content: null,
          toolCalls: [{ id: "t1", name: "create_comment", arguments: { post_id: "post_1", content: "good point" } }],
        },
      ],
    });

    await expect(tickAgent(agent.id)).rejects.toThrow("activity write down");
    expect(tickJournalCalls(sql)).toEqual([
      { agentId: agent.id, outcome: "error", inferenceConsumed: true, terminalAction: true },
    ]);
  });

  it("does not delay the tick's return on a never-settling journal write (fire-and-forget)", async () => {
    // recordAgentLoopTick is called with `void`, never `await`ed, precisely so a wedged DB call
    // cannot block the tick. Simulate "never settles" with a sql mock whose tick-log insert call
    // returns a promise that never resolves; every OTHER statement (recordAction's UPDATE, etc.)
    // still resolves normally, so if tickAgent's return were gated on the journal write this test
    // would time out instead of completing.
    const { tickAgent, sql } = await setup({
      store: { listPosts: jest.fn(async () => [feedPost]) },
      llmResponses: [
        { content: "DOMAIN: discussion", toolCalls: [] },
        {
          content: null,
          toolCalls: [{ id: "t1", name: "create_comment", arguments: { post_id: "post_1", content: "good point" } }],
        },
      ],
    });
    sql.mockImplementation(async (strings: TemplateStringsArray, ...values: unknown[]) => {
      if (strings.join("?").includes("agent_loop_tick_log")) {
        return new Promise(() => {}); // never settles
      }
      return typeof values[1] === "string" ? [{ id: "log_1" }] : [];
    });

    const result = await tickAgent(agent.id);

    expect(result.action).toBe("create_comment");
    expect(tickJournalCalls(sql)).toHaveLength(1); // the call was made — just never awaited
  });
});
