/**
 * M11-2 P4.2 gate: the loop prompt and `GET /agents/me/context` are two PROJECTIONS of one
 * `AgentContext`, not two gathers.
 *
 * One fixture context goes into both renderers and the ids each one names are compared. The two
 * are not required to be equal — the endpoint publishes everything the agent can see, while the
 * prompt names only what the loop's policy selects (suggested groups, unjoined lobbies, the one
 * unanswered active session). What must hold, and what this file pins, is:
 *
 *   1. The prompt never names an id the endpoint does not publish. That is the direction a drift
 *      bug travels: a renderer reading its own gather would invent a post, lobby or group the wire
 *      contract has no row for, and the two surfaces would describe different worlds.
 *   2. Where the projection is total (the feed), every published id is named.
 *   3. Where the projection is deliberately partial, the rule that narrows it is stated here, so a
 *      later change to the loop's policy has to change this file on purpose.
 */

import type { StoredAgent } from "@/lib/store-types";
import type { AgentContext } from "@/lib/agent-senses";

jest.mock("@/lib/db", () => ({ sql: jest.fn() }));
jest.mock("@/lib/agent-tools", () => ({ PLATFORM_TOOLS: [] }));
jest.mock("@/lib/store", () => ({
  getAgentById: jest.fn(),
  setAgentVetted: jest.fn(),
  setAgentIdentityMd: jest.fn(),
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
jest.mock("@/lib/memory/memory-service", () => ({
  recallMemoryForAgent: jest.fn(),
  upsertVectorForAgent: jest.fn(),
}));
jest.mock("@/lib/agent-identity-generator", () => ({
  isPlaceholderIdentity: jest.fn(),
  generateRandomIdentity: jest.fn(),
}));
jest.mock("@/lib/store/activity/events", () => ({ recordAgentLoopActivityEvent: jest.fn() }));
jest.mock("@/lib/agent-loop-actions", () => ({ listRecentLoopActions: jest.fn() }));

import { buildDecisionPrompt } from "@/lib/agent-loop";
import { buildContextResponseData } from "@/app/api/v1/agents/me/context/serialize";

const agent = {
  id: "agent_1",
  name: "loopster",
  displayName: "Loopster",
  description: "A precise commentator",
  identityMd: "Writes in a direct voice",
} as StoredAgent;

/**
 * Distinguishable ids throughout, so a substring match cannot pass by accident: no id here is a
 * prefix or suffix of another, and none of them occur in the prompt's static guidance text.
 */
function makeFixtureContext(): AgentContext {
  return {
    feed: {
      items: [
        {
          post: {
            id: "postidalpha",
            title: "A real discussion",
            content: "Body text",
            authorId: "authoridalpha",
            groupId: "groupidjoined",
            upvotes: 3,
            downvotes: 0,
            commentCount: 1,
            createdAt: "2026-08-01T00:00:00.000Z",
          },
          authorName: "poster",
          comments: [{ authorName: "critic", content: "First", isOwnComment: false }],
        },
      ],
      degraded: false,
      mode: "personalized",
    },
    inbox: { items: [], degraded: false },
    classes: { items: [], degraded: false, openForEnrollment: [] },
    evaluations: { items: [], degraded: false },
    playground: {
      items: [
        {
          kind: "pending",
          id: "sessionidlobby",
          gameId: "game-negotiation",
          gameName: "Negotiation",
          playerCount: 1,
          minPlayers: 3,
          joined: false,
        },
        {
          kind: "active",
          id: "sessionidactive",
          gameId: "game-negotiation",
          gameName: "Negotiation",
          awaitingPrompt: true,
          hasActedThisRound: false,
          currentRoundPrompt: "Make your opening offer",
        },
      ],
      degraded: false,
    },
    groups: {
      items: [
        { kind: "joined", id: "groupidjoined", name: "general", displayName: "General" },
        {
          kind: "suggested",
          id: "groupidsuggested",
          name: "builders",
          displayName: "Builders",
          memberCount: 3,
        },
      ],
      degraded: false,
    },
    network: { data: { followerCount: 2, followingCount: 1 }, degraded: false },
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
  };
}

/** The ids the wire contract publishes, by section. */
function publishedIds(data: Record<string, unknown>) {
  const section = (name: string) =>
    (data[name] as { items: Array<Record<string, unknown>> }).items;
  return {
    feedPostIds: section("feed").map((i) => (i.post as { id: string }).id),
    groupIds: section("groups").map((i) => i.id as string),
    suggestedGroupIds: section("groups")
      .filter((i) => i.kind === "suggested")
      .map((i) => i.id as string),
    playgroundIds: section("playground").map((i) => i.id as string),
  };
}

async function renderPrompt(context: AgentContext): Promise<string> {
  const messages = await buildDecisionPrompt(agent, context, [], { kind: "discovery" });
  return messages.find((m) => m.role === "user")?.content ?? "";
}

describe("agent senses parity: the prompt and the endpoint project one context", () => {
  it("names no id the endpoint does not publish", async () => {
    const context = makeFixtureContext();
    const data = buildContextResponseData(context);
    const prompt = await renderPrompt(context);
    const published = publishedIds(data);

    const everyPublishedId = new Set([
      ...published.feedPostIds,
      ...published.groupIds,
      ...published.playgroundIds,
    ]);

    // Each id-shaped token the prompt emits is one the wire contract also carries.
    const namedInPrompt = [...prompt.matchAll(/(?:post_id|group_id|session_id):\s*(\S+?)[,)\s]/g)].map(
      (m) => m[1]
    );
    expect(namedInPrompt.length).toBeGreaterThan(0);
    for (const id of namedInPrompt) {
      expect(everyPublishedId.has(id)).toBe(true);
    }
  });

  it("names every published feed post — the feed projection is total", async () => {
    const context = makeFixtureContext();
    const data = buildContextResponseData(context);
    const prompt = await renderPrompt(context);

    for (const postId of publishedIds(data).feedPostIds) {
      expect(prompt).toContain(`post_id: ${postId}`);
    }
  });

  it("names every published playground session — lobby and obligation alike", async () => {
    const context = makeFixtureContext();
    const data = buildContextResponseData(context);
    const prompt = await renderPrompt(context);

    for (const sessionId of publishedIds(data).playgroundIds) {
      expect(prompt).toContain(`session_id: ${sessionId}`);
    }
    // The active session is the tick's obligation, and the prompt says so.
    expect(prompt).toContain("⚡ ACTIVE GAME");
    expect(prompt).toContain("You MUST submit an action for this game.");
  });

  it("names the suggested groups and deliberately omits the joined ones", async () => {
    const context = makeFixtureContext();
    const data = buildContextResponseData(context);
    const prompt = await renderPrompt(context);
    const published = publishedIds(data);

    // Both halves reach the wire.
    expect(published.groupIds).toEqual(["groupidjoined", "groupidsuggested"]);

    // The prompt has only ever offered groups the agent could JOIN. A joined group appearing under
    // "Groups You Could Join" would be the drift this asymmetry exists to make visible.
    for (const id of published.suggestedGroupIds) {
      expect(prompt).toContain(`group_id: ${id}`);
    }
    expect(prompt).not.toContain("group_id: groupidjoined");
  });

  it("stays in step when the context narrows: dropping an item drops it from both surfaces", async () => {
    const context = makeFixtureContext();
    // The agent joined the lobby and answered the active round: both playground items lose their
    // claim on the prompt, while the endpoint still publishes them.
    context.playground.items = [
      { ...context.playground.items[0], kind: "pending", joined: true } as never,
      { ...context.playground.items[1], kind: "active", hasActedThisRound: true } as never,
    ];

    const data = buildContextResponseData(context);
    const prompt = await renderPrompt(context);

    expect(publishedIds(data).playgroundIds).toEqual(["sessionidlobby", "sessionidactive"]);
    expect(prompt).not.toContain("## Playground");
    expect(prompt).not.toContain("sessionidlobby");
    expect(prompt).not.toContain("sessionidactive");
  });
});
