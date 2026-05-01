import type { StoredAgent } from "@/lib/store-types";

describe("agent loop tool runtime", () => {
  it("logs a runtime-executed create_post action", async () => {
    jest.resetModules();

    const agent = {
      id: "agent_loop_test",
      name: "looptest",
      displayName: "Loop Test",
      description: "test",
      identityMd: "occasional poster",
    } as StoredAgent;
    const sql = jest.fn(async (_strings: TemplateStringsArray, ...values: unknown[]) => {
      return values[1] === "create_post" ? [{ id: "log_1" }] : [];
    });
    const executeTool = jest.fn(async () => ({
      success: true,
      data: { post_id: "post_1", title: "hello" },
    }));

    jest.doMock("@/lib/db", () => ({ sql }));
    jest.doMock("@/lib/agent-tools", () => ({
      PLATFORM_TOOLS: [
        {
          type: "function",
          function: { name: "create_post", description: "Create post", parameters: { type: "object" } },
        },
      ],
      executeTool,
    }));
    jest.doMock("@/lib/agent-runtime/adapters/openai-compatible", () => ({
      makeHfRouterCallLLM: () => async () => ({
        content: null,
        toolCalls: [{
          id: "call_1",
          name: "create_post",
          arguments: { group_name: "general", title: "hello", content: "world" },
        }],
      }),
      makeOpenAiCallLLM: jest.fn(),
    }));
    jest.doMock("@/lib/store", () => ({
      getAgentById: jest.fn(async () => agent),
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
    }));
    jest.doMock("@/lib/human-users", () => ({
      listUserIdsLinkedToAgent: jest.fn(async () => ["user_1"]),
      getUserInferenceSecrets: jest.fn(async () => ({ hf_token_override: "token" })),
      getUserInferenceTokenOverride: jest.fn(),
      incrementSponsoredInferenceUsage: jest.fn(),
    }));
    jest.doMock("@/lib/memory/sponsored-public-ai", () => ({ isSponsoredPublicAiAgent: jest.fn(async () => false) }));
    jest.doMock("@/lib/memory/memory-service", () => ({
      recallMemoryForAgent: jest.fn(async () => []),
      upsertVectorForAgent: jest.fn(async () => undefined),
    }));
    jest.doMock("@/lib/agent-identity-generator", () => ({
      isPlaceholderIdentity: jest.fn(() => false),
      generateRandomIdentity: jest.fn(),
    }));
    jest.doMock("@/lib/evaluations/loader", () => ({ listEvaluations: jest.fn(() => []) }));
    jest.doMock("@/lib/playground/games", () => ({ listGames: jest.fn(() => []) }));
    jest.doMock("@/lib/rss", () => ({
      getNewsItems: jest.fn(async () => [{ title: "news", url: "https://example.test/news" }]),
    }));
    jest.doMock("@/lib/store/activity/events", () => ({ recordAgentLoopActivityEvent: jest.fn() }));

    const { tickAgent } = await import("@/lib/agent-loop");
    const result = await tickAgent(agent.id);

    expect(result.action).toBe("create_post");
    expect(executeTool).toHaveBeenCalledWith(
      "create_post",
      { group_name: "general", title: "hello", content: "world" },
      agent
    );
    expect(sql.mock.calls.some(([, , action]) => action === "create_post")).toBe(true);
  });
});
