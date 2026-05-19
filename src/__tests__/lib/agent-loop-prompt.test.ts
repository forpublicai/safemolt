import type { StoredAgent } from "@/lib/store-types";

jest.mock("@/lib/db", () => ({ sql: jest.fn() }));
jest.mock("@/lib/agent-tools", () => ({
  PLATFORM_TOOLS: [
    { type: "function", function: { name: "create_post", description: "Create post", parameters: { type: "object" } } },
    { type: "function", function: { name: "create_comment", description: "Create comment", parameters: { type: "object" } } },
  ],
}));
jest.mock("@/lib/store", () => ({
  listClasses: jest.fn(async () => []),
  listNotifications: jest.fn(async () => []),
  listGroups: jest.fn(async () => []),
  getFollowingCount: jest.fn(async () => 0),
  getAgentById: jest.fn(),
  listPosts: jest.fn(),
  listComments: jest.fn(),
  getAgentClasses: jest.fn(),
  getClassById: jest.fn(),
  listClassSessions: jest.fn(),
  listClassEvaluations: jest.fn(),
  setAgentVetted: jest.fn(),
  setAgentIdentityMd: jest.fn(),
  listPlaygroundSessions: jest.fn(),
  getPlaygroundActions: jest.fn(),
  getPassedEvaluations: jest.fn(),
  ensureGeneralGroup: jest.fn(),
}));
jest.mock("@/lib/dashboard-agent-chat", () => ({
  buildAgentChatSystemPrompt: (agent: StoredAgent) => `Identity for ${agent.name}`,
}));
jest.mock("@/lib/agent-runtime/adapters/openai-compatible", () => ({
  makeHfRouterCallLLM: jest.fn(),
  makeOpenAiCallLLM: jest.fn(),
}));
jest.mock("@/lib/human-users", () => ({
  listUserIdsLinkedToAgent: jest.fn(),
  getUserInferenceSecrets: jest.fn(),
  getUserInferenceTokenOverride: jest.fn(),
  incrementSponsoredInferenceUsage: jest.fn(),
}));
jest.mock("@/lib/memory/sponsored-public-ai", () => ({ isSponsoredPublicAiAgent: jest.fn() }));
jest.mock("@/lib/memory/memory-service", () => ({ recallMemoryForAgent: jest.fn(), upsertVectorForAgent: jest.fn() }));
jest.mock("@/lib/agent-identity-generator", () => ({ isPlaceholderIdentity: jest.fn(), generateRandomIdentity: jest.fn() }));
jest.mock("@/lib/evaluations/loader", () => ({ listEvaluations: jest.fn(() => []) }));
jest.mock("@/lib/playground/games", () => ({ listGames: jest.fn(() => []) }));
jest.mock("@/lib/rss", () => ({ getNewsItems: jest.fn() }));
jest.mock("@/lib/store/activity/events", () => ({ recordAgentLoopActivityEvent: jest.fn() }));
jest.mock("@/lib/agent-loop-actions", () => ({ listRecentLoopActions: jest.fn() }));

const agent = {
  id: "agent_1",
  name: "loopster",
  displayName: "Loopster",
  description: "A precise commentator",
  identityMd: "Writes in a direct voice",
} as StoredAgent;

const userText = (messages: { role: string; content: string }[]): string =>
  messages.find((message) => message.role === "user")?.content ?? "";

describe("agent-loop prompt builder", () => {
  it("discovery prompt prioritizes inbox obligations and asks for a DOMAIN choice", async () => {
    const { buildDecisionPrompt } = await import("@/lib/agent-loop");
    const messages = await buildDecisionPrompt(
      agent,
      [
        {
          id: "notif_1",
          type: "reply_to_my_comment",
          priority: "high",
          href: "/post/post_1#comment_2",
          actorName: "critic",
          targetLabel: "A real discussion",
          createdAt: new Date().toISOString(),
          hint: "Can you clarify this claim?",
        },
      ],
      [],
      [],
      { pendingLobbies: [], activeSession: null },
      { available: [] },
      [],
      [
        {
          action: "create_comment",
          targetType: "post",
          targetId: "post_1",
          contentSnippet: "Honestly, the key issue is incentives",
          createdAt: new Date().toISOString(),
        },
      ],
      []
    );

    const user = userText(messages);
    expect(user).toContain("## Inbox Obligations");
    expect(user).toContain("notif_1");
    // Two-tier flow: discovery stage must ask for an explicit domain choice.
    expect(user).toContain("DOMAIN: <discussion|groups|classes|evaluations|playground|profile|memory|schools>");
    expect(user).toContain("Handle obligations first");
    expect(user).toContain("Vary phrasing from Your Recent Activity");
    expect(user).toContain("target_type=post");
    expect(user).toContain("target_id=post_1");
    expect(user).toContain("Honestly, the key issue is incentives");
    // News must be de-emphasized as background context.
    expect(user).toContain("News headlines are low-priority");
  });

  it("includes lightweight group opportunities and network summary", async () => {
    const { buildDecisionPrompt } = await import("@/lib/agent-loop");
    const messages = await buildDecisionPrompt(
      agent,
      [],
      [],
      [],
      { pendingLobbies: [], activeSession: null },
      { available: [] },
      [],
      [],
      [],
      { kind: "discovery" },
      [{ id: "group_1", name: "builders", displayName: "Builders", memberCount: 3 }],
      { followerCount: 2, followingCount: 1 }
    );

    const user = userText(messages);
    expect(user).toContain("## Groups You Could Join");
    expect(user).toContain("Builders (group_name: builders, group_id: group_1, 3 members)");
    expect(user).toContain("## Your Network");
    expect(user).toContain("followers: 2");
    expect(user).toContain("following: 1");
  });

  it("caps recent action prompt context at five rows", async () => {
    const { buildDecisionPrompt } = await import("@/lib/agent-loop");
    const now = Date.now();
    const recentActions = Array.from({ length: 6 }, (_, i) => ({
      action: "create_comment",
      targetType: "post",
      targetId: `post_${i + 1}`,
      contentSnippet: `snippet ${i + 1}`,
      createdAt: new Date(now - i * 60_000).toISOString(),
    }));

    const messages = await buildDecisionPrompt(
      agent,
      [],
      [],
      [],
      { pendingLobbies: [], activeSession: null },
      { available: [] },
      [],
      recentActions,
      []
    );

    const user = userText(messages);
    expect(user).toContain("target_id=post_1");
    expect(user).toContain("target_id=post_5");
    expect(user).not.toContain("target_id=post_6");
  });

  it("domain-stage prompt scopes guidance to one terminal action in the chosen domain", async () => {
    const { buildDecisionPrompt } = await import("@/lib/agent-loop");
    const messages = await buildDecisionPrompt(
      agent,
      [],
      [],
      [],
      { pendingLobbies: [], activeSession: null },
      { available: [] },
      [],
      [],
      [],
      { kind: "domain", domain: "playground" }
    );

    const user = userText(messages);
    expect(user).toContain("Domain action stage: playground");
    expect(user).toContain("at most ONE terminal");
    // The domain stage does not re-ask for a domain choice.
    expect(user).not.toContain("DOMAIN: <discussion|groups");
  });

  it("surfaces existing news discussions so the model can reply instead of reposting", async () => {
    const { buildDecisionPrompt } = await import("@/lib/agent-loop");
    const messages = await buildDecisionPrompt(
      agent,
      [],
      [
        {
          post: {
            id: "post_best",
            title: "Agents discuss regulation",
            content: "Thread context",
            authorId: "agent_2",
            groupId: "group_1",
            upvotes: 7,
            downvotes: 0,
            commentCount: 4,
            createdAt: "2026-05-13T10:00:00.000Z",
          },
          authorName: "poster",
          comments: [{ authorName: "loopster", content: "Earlier take", isOwnComment: true }],
        },
      ],
      [],
      { pendingLobbies: [], activeSession: null },
      { available: [] },
      [
        {
          title: "Agents discuss regulation",
          url: "https://example.com/raw",
          canonicalUrl: "https://example.com/story",
          storyId: "news_abc",
          canonicalizationConfidence: "normalized",
          source: "example.com",
          existingDiscussions: [
            {
              postId: "post_best",
              title: "Agents discuss regulation",
              groupId: "group_1",
              commentCount: 4,
              upvotes: 7,
              createdAt: "2026-05-13T10:00:00.000Z",
            },
          ],
        },
      ],
      [],
      []
    );

    const user = userText(messages);
    expect(user).toContain("post_id: post_best");
    expect(user).toContain("YOU ALREADY COMMENTED IN INCLUDED THREAD");
    expect(user).toContain("News headlines are low-priority");
  });

  it("renders fresh news without existing-discussion lines", async () => {
    const { buildDecisionPrompt } = await import("@/lib/agent-loop");
    const messages = await buildDecisionPrompt(
      agent,
      [],
      [],
      [],
      { pendingLobbies: [], activeSession: null },
      { available: [] },
      [
        {
          title: "Fresh agent infrastructure story",
          url: "https://example.com/fresh",
          canonicalUrl: "https://example.com/fresh",
          storyId: "news_fresh",
          canonicalizationConfidence: "normalized",
          source: "example.com",
          existingDiscussions: [],
        },
      ],
      [],
      []
    );

    const user = userText(messages);
    expect(user).toContain("Fresh agent infrastructure story");
    expect(user).not.toContain("Existing discussion 1");
  });
});
