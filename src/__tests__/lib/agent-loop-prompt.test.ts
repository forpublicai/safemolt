import type { StoredAgent } from "@/lib/store-types";
import type { AgentContext } from "@/lib/agent-senses";

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
  listFeed: jest.fn(),
  getPost: jest.fn(),
  listComments: jest.fn(),
  getAgentClasses: jest.fn(),
  getClassById: jest.fn(),
  listClassSessions: jest.fn(),
  listClassEvaluations: jest.fn(),
  getStudentClassResults: jest.fn(),
  getGroupMemberCount: jest.fn(),
  isGroupMember: jest.fn(),
  setAgentVetted: jest.fn(),
  setAgentIdentityMd: jest.fn(),
  listPlaygroundSessions: jest.fn(),
  getPlaygroundSession: jest.fn(),
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
jest.mock("@/lib/admissions", () => ({ getAdmissionsStatusForAgent: jest.fn() }));
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

/**
 * M11-2 P4.3: `buildDecisionPrompt` renders one `AgentContext` instead of thirteen positional
 * parameters. The sections below are the empty context; each case overrides only what it asserts
 * on, and every assertion in this file is unchanged from the pre-P4.3 version.
 */
function makeContext(overrides: Partial<AgentContext> = {}): AgentContext {
  return {
    feed: { items: [], degraded: false, mode: "personalized" },
    inbox: { items: [], degraded: false },
    classes: { items: [], degraded: false, openForEnrollment: [] },
    evaluations: { items: [], degraded: false },
    playground: { items: [], degraded: false },
    groups: { items: [], degraded: false },
    network: { data: { followerCount: 0, followingCount: 0 }, degraded: false },
    news: { items: [], degraded: false },
    memories: { items: [], degraded: false },
    admissions: { data: null, degraded: false },
    limits: {
      data: {
        postCooldownMs: 30000,
        commentCooldownMs: 20000,
        maxCommentsPerDay: 50,
        loopNextEligibleAt: null,
      },
      degraded: false,
    },
    ...overrides,
  };
}

describe("agent-loop prompt builder", () => {
  it("discovery prompt prioritizes inbox obligations and asks for a DOMAIN choice", async () => {
    const { buildDecisionPrompt } = await import("@/lib/agent-loop");
    const messages = await buildDecisionPrompt(
      agent,
      makeContext({
        inbox: {
          items: [
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
          degraded: false,
        },
      }),
      [
        {
          action: "create_comment",
          targetType: "post",
          targetId: "post_1",
          contentSnippet: "Honestly, the key issue is incentives",
          createdAt: new Date().toISOString(),
        },
      ]
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
      makeContext({
        groups: {
          items: [
            {
              kind: "suggested",
              id: "group_1",
              name: "builders",
              displayName: "Builders",
              memberCount: 3,
            },
          ],
          degraded: false,
        },
        network: { data: { followerCount: 2, followingCount: 1 }, degraded: false },
      }),
      [],
      { kind: "discovery" }
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

    const messages = await buildDecisionPrompt(agent, makeContext(), recentActions);

    const user = userText(messages);
    expect(user).toContain("target_id=post_1");
    expect(user).toContain("target_id=post_5");
    expect(user).not.toContain("target_id=post_6");
  });

  it("domain-stage prompt scopes guidance to one terminal action in the chosen domain", async () => {
    const { buildDecisionPrompt } = await import("@/lib/agent-loop");
    const messages = await buildDecisionPrompt(agent, makeContext(), [], {
      kind: "domain",
      domain: "playground",
    });

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
      makeContext({
        feed: {
          items: [
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
          degraded: false,
          mode: "personalized",
        },
        news: {
          items: [
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
          degraded: false,
        },
      }),
      []
    );

    const user = userText(messages);
    expect(user).toContain("post_id: post_best");
    expect(user).toContain("YOU ALREADY COMMENTED IN INCLUDED THREAD");
    expect(user).toContain("News headlines are low-priority");
  });

  /**
   * M11-2 u5 fix round 1, finding B-1. The prompt projected ten of the context's eleven sections
   * and dropped `admissions`, so an agent with a pending admissions step could not see it. The
   * three cases below pin the whole rule: the five pinned fields render verbatim when the surface
   * is actionable, and nothing renders at all when it is not — an admitted agent with only the
   * static `admitted` line, and a degraded read, both cost zero prompt tokens.
   */
  const actionableAdmissions = {
    pool_eligible: false,
    public_ai_eligibility: { status: "ineligible" as const, reason: "Missing: sip_2_poaw." },
    next_action: {
      code: "complete_criteria",
      message: "Complete admissions criteria: sip_2_poaw.",
      href: "/evaluations",
    },
    criteria_progress: [
      { code: "vetting", label: "PoAW vetting complete", complete: true },
      { code: "sip_2_poaw", label: "SIP-2 PoAW passed", complete: false },
    ],
    admission_source: "not_admitted" as const,
    state_source: "eligibility" as const,
    is_admitted: false,
    cycle_id: null,
    application: null,
    offer: null,
  };

  it("renders the five pinned admissions fields when the surface is actionable", async () => {
    const { buildDecisionPrompt } = await import("@/lib/agent-loop");
    const messages = await buildDecisionPrompt(
      agent,
      makeContext({ admissions: { data: actionableAdmissions, degraded: false } }),
      []
    );

    const user = userText(messages);
    expect(user).toContain("## Admissions");
    // 1. next_action, with its href.
    expect(user).toContain("next_action: complete_criteria — Complete admissions criteria: sip_2_poaw.");
    expect(user).toContain("href: /evaluations");
    // 2. criteria_progress, every criterion with its completion state.
    expect(user).toContain("[x] vetting: PoAW vetting complete");
    expect(user).toContain("[ ] sip_2_poaw: SIP-2 PoAW passed");
    // 3. public_ai_eligibility, status and reason.
    expect(user).toContain("public_ai_eligibility: ineligible — Missing: sip_2_poaw.");
    // 4 and 5. admission_source and state_source.
    expect(user).toContain("admission_source: not_admitted");
    expect(user).toContain("state_source: eligibility");
  });

  it("renders no admissions section for an admitted agent with nothing to do", async () => {
    const { buildDecisionPrompt } = await import("@/lib/agent-loop");
    const messages = await buildDecisionPrompt(
      agent,
      makeContext({
        admissions: {
          data: {
            ...actionableAdmissions,
            is_admitted: true,
            admission_source: "application",
            state_source: "application",
            next_action: {
              code: "admitted",
              message: "You are admitted and can join admitted-school workflows.",
              href: "/schools",
            },
          },
          degraded: false,
        },
      }),
      []
    );

    const user = userText(messages);
    expect(user).not.toContain("## Admissions");
    expect(user).not.toContain("admission_source");
    expect(user).not.toContain("state_source");
  });

  it("renders no admissions section when the admissions read failed", async () => {
    const { buildDecisionPrompt } = await import("@/lib/agent-loop");
    const messages = await buildDecisionPrompt(
      agent,
      makeContext({ admissions: { data: null, degraded: true } }),
      []
    );

    expect(userText(messages)).not.toContain("## Admissions");
  });

  it("renders fresh news without existing-discussion lines", async () => {
    const { buildDecisionPrompt } = await import("@/lib/agent-loop");
    const messages = await buildDecisionPrompt(
      agent,
      makeContext({
        news: {
          items: [
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
          degraded: false,
        },
      }),
      []
    );

    const user = userText(messages);
    expect(user).toContain("Fresh agent infrastructure story");
    expect(user).not.toContain("Existing discussion 1");
  });
});
