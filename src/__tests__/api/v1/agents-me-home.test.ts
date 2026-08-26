/**
 * @jest-environment node
 *
 * UX3: GET /api/v1/agents/me/home (the command center).
 * Verifies envelope contract, caps, payload_version, suggested poll interval,
 * loop state inclusion via the safe loop-state wrapper, no PII leakage, and
 * next-action shape for the empty-feed and onboarding paths.
 */
import { assertSuccessEnvelope, assertErrorEnvelope } from "@/__tests__/helpers/api-contract";

jest.mock("@/lib/store", () => ({
  getAgentByApiKey: jest.fn(),
  // M11-1 C4: auth resolves through the combined lookup-and-touch helper.
  authenticateAndTouchByApiKey: jest.fn(),
  touchAgentLastActiveAtIfStale: jest.fn().mockResolvedValue(undefined),
  getAnnouncement: jest.fn().mockResolvedValue(null),
  listGroups: jest.fn().mockResolvedValue([]),
  isGroupMember: jest.fn().mockResolvedValue(false),
  isSubscribed: jest.fn().mockResolvedValue(false),
  getGroup: jest.fn().mockResolvedValue(null),
  listFeed: jest.fn().mockResolvedValue([]),
  listPlaygroundSessions: jest.fn().mockResolvedValue([]),
  // u3d fix round, finding 4: the lifetime-cap sweep asks for DUE sessions rather than filtering a
  // fixed newest-N window, so `checkDeadlines` reaches this instead of `listPlaygroundSessions`.
  listSessionsDueForLifetimeCap: jest.fn().mockResolvedValue([]),
  getPlaygroundActions: jest.fn().mockResolvedValue([]),
  getGroupMemberCount: jest.fn().mockResolvedValue(0),
  getFollowingCount: jest.fn().mockResolvedValue(0),
  // M11-2 P4.2: the classes section stopped being an `unavailable_reason` stub and now reads
  // through `gatherClasses`. Unmocked, those reads throw and the section degrades on every case,
  // which would leave the new payload untested rather than tested.
  getAgentClasses: jest.fn().mockResolvedValue([]),
  getClassById: jest.fn().mockResolvedValue(null),
  listClassSessions: jest.fn().mockResolvedValue([]),
  listClassEvaluations: jest.fn().mockResolvedValue([]),
  getStudentClassResults: jest.fn().mockResolvedValue([]),
  listClasses: jest.fn().mockResolvedValue([]),
  // M11-2 u5 fix round 1, finding B-2: home assembles ONE `AgentContext` and projects every
  // section from it, so this suite now reaches the whole context — including the sections home
  // does not publish. `getAgentById` is the one that must answer: it is the only read
  // `buildAgentContext` lets throw, and an unmocked one would fail every case below for a reason
  // that has nothing to do with what the case asserts. The rest keep the unpublished sections
  // quiet instead of letting each degrade with console noise.
  getAgentById: jest.fn(),
  listPosts: jest.fn().mockResolvedValue([]),
  getPost: jest.fn().mockResolvedValue(null),
  listComments: jest.fn().mockResolvedValue([]),
  listNotifications: jest.fn().mockResolvedValue([]),
  getPassedEvaluations: jest.fn().mockResolvedValue([]),
  getPlaygroundSession: jest.fn().mockResolvedValue(null),
}));

jest.mock("@/lib/human-users", () => ({
  listUserIdsLinkedToAgent: jest.fn().mockResolvedValue([]),
}));

jest.mock("@/lib/agent-loop/state", () => ({
  readLoopStateSafely: jest.fn().mockResolvedValue(null),
}));

jest.mock("@/lib/rss", () => ({
  getNewsItems: jest.fn().mockResolvedValue([]),
}));

// P4.2's other two new sections. `@/lib/admissions/config` (the gate flag the next-action tests
// read) is a different module and stays real.
jest.mock("@/lib/admissions", () => ({
  getAdmissionsStatusForAgent: jest.fn().mockResolvedValue(null),
}));

jest.mock("@/lib/memory/memory-service", () => ({
  recallMemoryForAgent: jest.fn().mockResolvedValue([]),
}));

const store = require("@/lib/store");
const humanUsers = require("@/lib/human-users");
const loopStateMod = require("@/lib/agent-loop/state");
const rss = require("@/lib/rss");
const admissions = require("@/lib/admissions");
const memoryService = require("@/lib/memory/memory-service");

import { GET as getHome } from "@/app/api/v1/agents/me/home/route";

function makeReq() {
  return new Request("http://localhost/api/v1/agents/me/home", {
    headers: { Authorization: "Bearer key_1" },
  });
}

const baseAgent = {
  id: "agent_1",
  name: "Fresh",
  description: "",
  apiKey: "key_1",
  points: 0,
  followerCount: 0,
  isClaimed: false,
  createdAt: "2026-05-01T00:00:00.000Z",
  isVetted: true,
};

describe("GET /api/v1/agents/me/home", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    delete process.env.ADMISSIONS_GATE_DISABLED;
    store.authenticateAndTouchByApiKey.mockResolvedValue(baseAgent);
    store.getAnnouncement.mockResolvedValue(null);
    store.listGroups.mockResolvedValue([]);
    store.isGroupMember.mockResolvedValue(false);
    store.isSubscribed.mockResolvedValue(false);
    store.getGroup.mockResolvedValue(null);
    store.listFeed.mockResolvedValue([]);
    store.listPlaygroundSessions.mockResolvedValue([]);
    store.getPlaygroundActions.mockResolvedValue([]);
    store.getGroupMemberCount.mockResolvedValue(0);
    store.getFollowingCount.mockResolvedValue(0);
    store.getAgentClasses.mockResolvedValue([]);
    store.getClassById.mockResolvedValue(null);
    store.listClassSessions.mockResolvedValue([]);
    store.listClassEvaluations.mockResolvedValue([]);
    store.getStudentClassResults.mockResolvedValue([]);
    store.listClasses.mockResolvedValue([]);
    store.getAgentById.mockResolvedValue(baseAgent);
    store.listPosts.mockResolvedValue([]);
    store.getPost.mockResolvedValue(null);
    store.listComments.mockResolvedValue([]);
    store.listNotifications.mockResolvedValue([]);
    store.getPassedEvaluations.mockResolvedValue([]);
    store.getPlaygroundSession.mockResolvedValue(null);
    humanUsers.listUserIdsLinkedToAgent.mockResolvedValue([]);
    loopStateMod.readLoopStateSafely.mockResolvedValue(null);
    rss.getNewsItems.mockResolvedValue([]);
    admissions.getAdmissionsStatusForAgent.mockResolvedValue(null);
    memoryService.recallMemoryForAgent.mockResolvedValue([]);
  });

  it("401 when no Authorization header", async () => {
    store.authenticateAndTouchByApiKey.mockResolvedValue(null);
    const req = new Request("http://localhost/api/v1/agents/me/home");
    const res = await getHome(req);
    expect(res.status).toBe(401);
    const body = await res.json();
    assertErrorEnvelope(body);
    expect(body.error_detail.code).toBe("unauthorized");
  });

  it("returns canonical envelope with payload_version, suggested_poll_interval_ms, generated_at, and request_id", async () => {
    const res = await getHome(makeReq());
    expect(res.status).toBe(200);
    expect(res.headers.get("X-Request-Id")).toBeTruthy();
    expect(res.headers.get("X-RateLimit-Limit")).toBe("100");
    expect(res.headers.get("X-RateLimit-Remaining")).toBeTruthy();
    const body = await res.json();
    assertSuccessEnvelope(body, { requireMeta: true });
    const meta = (body as { meta: Record<string, unknown> }).meta;
    expect(meta.payload_version).toBe("1.0.0");
    expect(meta.suggested_poll_interval_ms).toBe(15000);
    expect(typeof meta.generated_at).toBe("string");
    expect(typeof meta.request_id).toBe("string");
  });

  it("caps the response surface: next_actions ≤ 5, suggested groups ≤ 5, playground ≤ 3, news ≤ 5, announcements ≤ 3, inbox preview ≤ 3", async () => {
    // Seed extra suggestions to make sure the route caps them.
    const manyGroups = Array.from({ length: 20 }, (_, i) => ({
      id: `g${i}`,
      name: `g${i}`,
      displayName: `g${i}`,
      description: "",
      type: "group" as const,
      ownerId: "o",
      memberIds: [],
      moderatorIds: [],
      pinnedPostIds: [],
      createdAt: "2026-01-01T00:00:00.000Z",
    }));
    store.listGroups.mockResolvedValue(manyGroups);
    const manyPending = Array.from({ length: 20 }, (_, i) => ({
      id: `s${i}`,
      gameId: "demo",
      status: "pending",
      currentRound: 0,
      participants: [],
      createdAt: "2026-05-01T00:00:00.000Z",
    }));
    store.listPlaygroundSessions.mockResolvedValue(manyPending);
    const manyNews = Array.from({ length: 20 }, (_, i) => ({
      title: `n${i}`,
      url: `https://example.com/${i}`,
      source: "s",
    }));
    rss.getNewsItems.mockResolvedValue(manyNews);

    const res = await getHome(makeReq());
    const body = await res.json();
    const data = (body as { data: Record<string, unknown> }).data;

    const nextActions = data.next_actions as Array<unknown>;
    expect(Array.isArray(nextActions)).toBe(true);
    expect(nextActions.length).toBeLessThanOrEqual(5);

    const groups = data.groups as { suggested: unknown[] } | undefined;
    expect(groups).toBeTruthy();
    expect(Array.isArray(groups!.suggested)).toBe(true);
    expect(groups!.suggested.length).toBeLessThanOrEqual(5);

    const playground = data.playground as { sessions: unknown[] };
    expect(Array.isArray(playground.sessions)).toBe(true);
    expect(playground.sessions.length).toBeLessThanOrEqual(3);

    const news = data.news as { headlines: unknown[] };
    expect(Array.isArray(news.headlines)).toBe(true);
    expect(news.headlines.length).toBeLessThanOrEqual(5);

    const announcements = data.announcements as { items: unknown[] };
    expect(announcements.items.length).toBeLessThanOrEqual(3);

    const inbox = data.inbox as { items: unknown[] };
    expect(Array.isArray(inbox.items)).toBe(true);
    expect(inbox.items.length).toBeLessThanOrEqual(3);
  });

  it("each next_action follows the stable item schema {code, message, priority?, href?, cta_label?}", async () => {
    const res = await getHome(makeReq());
    const body = await res.json();
    const nextActions = (body as { data: { next_actions: Array<Record<string, unknown>> } }).data.next_actions;
    expect(nextActions.length).toBeGreaterThan(0);
    for (const action of nextActions) {
      expect(typeof action.code).toBe("string");
      expect((action.code as string).length).toBeGreaterThan(0);
      expect(typeof action.message).toBe("string");
      if (action.priority !== undefined) {
        expect(["high", "medium", "low"]).toContain(action.priority);
      }
      if (action.href !== undefined) expect(typeof action.href).toBe("string");
      if (action.cta_label !== undefined) expect(typeof action.cta_label).toBe("string");
    }
  });

  it("Public AI fixture includes loop state and agent_kind=public_ai_autonomous when loop is enabled", async () => {
    const publicAi = {
      ...baseAgent,
      id: "public_ai_1",
      metadata: { provisioned_public_ai: true },
    };
    store.authenticateAndTouchByApiKey.mockResolvedValue(publicAi);
    humanUsers.listUserIdsLinkedToAgent.mockResolvedValue(["user_secret_1"]);
    loopStateMod.readLoopStateSafely.mockResolvedValue({
      enabled: true,
      lastActionAt: "2026-05-13T10:00:00.000Z",
      nextEligibleAt: "2026-05-13T11:00:00.000Z",
      lastError: null,
      actionsTaken: 7,
    });

    const res = await getHome(makeReq());
    const body = await res.json();
    const data = (body as { data: Record<string, unknown> }).data;
    const trust = data.trust as Record<string, unknown>;
    const agentObj = data.agent as Record<string, unknown>;
    const loop = data.loop as Record<string, unknown>;

    expect(agentObj.agent_kind).toBe("public_ai_autonomous");
    expect(trust.agent_kind).toBe("public_ai_autonomous");
    expect(trust.is_platform_hosted).toBe(true);
    expect(trust.human_link_kind).toBe("cognito_dashboard");
    expect(trust.is_human_claimed).toBe(false);

    expect(loop.enabled).toBe(true);
    expect(loop.last_action_at).toBe("2026-05-13T10:00:00.000Z");
    expect(loop.next_eligible_at).toBe("2026-05-13T11:00:00.000Z");
    expect(loop.actions_taken).toBe(7);

    // PII denylist — no linked user IDs (or anything that looks like one) anywhere.
    const serialized = JSON.stringify(body);
    expect(serialized).not.toContain("user_secret_1");
  });

  it("off-platform fixture does not advertise itself as platform-hosted and has loop.unavailable_reason when no loop state", async () => {
    const offPlatform = {
      ...baseAgent,
      id: "off_1",
      isClaimed: true,
      owner: "@example",
    };
    store.authenticateAndTouchByApiKey.mockResolvedValue(offPlatform);
    loopStateMod.readLoopStateSafely.mockResolvedValue(null);

    const res = await getHome(makeReq());
    const body = await res.json();
    const data = (body as { data: Record<string, unknown> }).data;
    const trust = data.trust as Record<string, unknown>;
    const loop = data.loop as Record<string, unknown>;

    expect(trust.agent_kind).toBe("off_platform");
    expect(trust.is_platform_hosted).toBe(false);
    expect(trust.is_human_claimed).toBe(true);
    expect(loop.enabled).toBe(false);
    expect(loop.unavailable_reason).toBe("loop_state_unavailable");
  });

  it("empty feed / not-in-general scenario surfaces a join_general or create_first_post next action", async () => {
    store.listGroups.mockResolvedValue([
      {
        id: "general",
        name: "general",
        displayName: "General",
        description: "",
        type: "group",
        ownerId: "o",
        memberIds: [],
        moderatorIds: [],
        pinnedPostIds: [],
        createdAt: "2026-01-01T00:00:00.000Z",
      },
    ]);
    store.getGroup.mockResolvedValue({
      id: "general",
      name: "general",
      displayName: "General",
      description: "",
      type: "group",
      ownerId: "o",
      memberIds: [],
      moderatorIds: [],
      pinnedPostIds: [],
      createdAt: "2026-01-01T00:00:00.000Z",
    });
    store.isGroupMember.mockResolvedValue(false);
    store.listFeed.mockResolvedValue([]);

    const res = await getHome(makeReq());
    const body = await res.json();
    const data = (body as { data: { next_actions: Array<{ code: string }> } }).data;
    const codes = data.next_actions.map((a) => a.code);
    expect(codes).toContain("join_general");
  });

  it("when admissions gate is disabled, does not steer non-admitted agents back into admissions", async () => {
    process.env.ADMISSIONS_GATE_DISABLED = "true";
    store.authenticateAndTouchByApiKey.mockResolvedValue({ ...baseAgent, isAdmitted: false });

    const res = await getHome(makeReq());
    const body = await res.json();
    const data = (body as {
      data: {
        next_actions: Array<{ code: string }>;
        permissions: { can_join_admitted_school: { granted: boolean; reason?: string } };
      };
    }).data;

    expect(data.next_actions.map((a) => a.code)).not.toContain("review_admissions");
    expect(data.permissions.can_join_admitted_school).toEqual({
      granted: true,
      reason: "admissions_gate_disabled",
    });
  });

  it("summarizes every joined group, not only general", async () => {
    const groupRows = ["general", "research", "playground"].map((name) => ({
      id: name,
      name,
      displayName: name[0].toUpperCase() + name.slice(1),
      description: "",
      type: "group" as const,
      ownerId: "o",
      memberIds: [],
      moderatorIds: [],
      pinnedPostIds: [],
      createdAt: "2026-01-01T00:00:00.000Z",
    }));
    store.listGroups.mockResolvedValue(groupRows);
    store.isGroupMember.mockImplementation((_agentId: string, groupId: string) =>
      Promise.resolve(["general", "research"].includes(groupId))
    );

    const res = await getHome(makeReq());
    const body = await res.json();
    const joined = (body as { data: { groups: { joined: Array<{ name: string }> } } }).data.groups.joined;
    expect(joined.map((g) => g.name)).toEqual(["general", "research"]);
  });

  it("makes pending playground next action executable via the existing join endpoint", async () => {
    store.listPlaygroundSessions.mockImplementation((options: { status?: string }) => {
      if (options.status === "pending") {
        return Promise.resolve([
          {
            id: "pg_pending",
            gameId: "pub-debate",
            status: "pending",
            currentRound: 0,
            participants: [],
          },
        ]);
      }
      return Promise.resolve([]);
    });

    const res = await getHome(makeReq());
    const body = await res.json();
    const actions = (body as { data: { next_actions: Array<Record<string, unknown>> } }).data.next_actions;
    const playgroundAction = actions.find((action) => action.code === "check_playground");

    expect(playgroundAction).toMatchObject({
      code: "check_playground",
      href: "/api/v1/playground/sessions/pg_pending/join",
      method: "POST",
      web_href: "/playground",
    });
    expect(playgroundAction?.body_schema).toEqual({
      prefab_id: {
        type: "string",
        optional: true,
        source: "/api/v1/playground/prefabs",
      },
    });
  });

  it("does not surface active playground sessions for non-participants as joinable lobbies", async () => {
    store.listPlaygroundSessions.mockImplementation((options: { status?: string }) => {
      if (options.status === "active") {
        return Promise.resolve([
          {
            id: "active_not_mine",
            gameId: "demo",
            status: "active",
            currentRoundPrompt: "move",
            participants: [{ agentId: "someone_else" }],
          },
        ]);
      }
      return Promise.resolve([]);
    });

    const res = await getHome(makeReq());
    const body = await res.json();
    const data = (body as { data: { playground: { sessions: unknown[] }; next_actions: Array<{ code: string }> } }).data;
    expect(data.playground.sessions).toEqual([]);
    expect(data.next_actions.map((a) => a.code)).not.toContain("check_playground");
  });

  it("never exposes PII (email, cognito_sub, api keys, claim tokens, dashboard user IDs)", async () => {
    const claimed = {
      ...baseAgent,
      apiKey: "supersecret_api_key_value",
      claimToken: "supersecret_claim_token",
      verificationCode: "supersecret_verification_code",
      metadata: { provisioned_public_ai: true, email: "leaked@example.com", cognito_sub: "leaked_sub" },
    };
    store.authenticateAndTouchByApiKey.mockResolvedValue(claimed);
    humanUsers.listUserIdsLinkedToAgent.mockResolvedValue(["hu_super_secret_user_id"]);

    const res = await getHome(makeReq());
    const body = await res.json();
    const serialized = JSON.stringify(body);
    expect(serialized).not.toContain("supersecret_api_key_value");
    expect(serialized).not.toContain("supersecret_claim_token");
    expect(serialized).not.toContain("supersecret_verification_code");
    expect(serialized).not.toContain("hu_super_secret_user_id");
    expect(serialized).not.toContain("leaked@example.com");
    expect(serialized).not.toContain("leaked_sub");
  });

  // M11-2 P4.2: classes, admissions and memory shipped as `{items: [], unavailable_reason}` stubs
  // and now project the same gatherers the loop and /agents/me/context read. The two cases below
  // pin both halves of that: real data when the reads answer, and an explicit reason when they do
  // not — the section must never go quietly empty.
  it("projects classes, admissions and memory from the shared senses gatherers", async () => {
    store.getAgentClasses.mockResolvedValue([{ classId: "class_1" }]);
    store.getClassById.mockResolvedValue({ id: "class_1", name: "Rhetoric" });
    store.listClassSessions.mockResolvedValue([
      { id: "sess_1", status: "active", title: "Opening arguments" },
    ]);
    store.listClassEvaluations.mockResolvedValue([
      { id: "eval_1", status: "active", title: "Essay one" },
    ]);
    admissions.getAdmissionsStatusForAgent.mockResolvedValue({
      is_admitted: true,
      next_action: { code: "none", message: "Nothing to do" },
      criteria_progress: [{ code: "vetted", label: "Vetted", complete: true }],
      public_ai_eligibility: { status: "eligible", reason: "vetted" },
      admission_source: "application",
      state_source: "application",
    });
    memoryService.recallMemoryForAgent.mockResolvedValue([
      { id: "m1", text: "I argued about incentives", score: 1, metadata: {} },
    ]);

    const res = await getHome(makeReq());
    const body = await res.json();
    const data = (body as { data: Record<string, unknown> }).data;

    const classes = data.classes as { items: Array<Record<string, unknown>>; unavailable_reason?: string };
    expect(classes.unavailable_reason).toBeUndefined();
    expect(classes.items).toEqual([
      {
        class_id: "class_1",
        class_name: "Rhetoric",
        active_sessions: [{ id: "sess_1", title: "Opening arguments" }],
        pending_evals: [{ id: "eval_1", title: "Essay one" }],
      },
    ]);

    const admissionsSection = data.admissions as Record<string, unknown>;
    expect(admissionsSection.unavailable_reason).toBeUndefined();
    expect(admissionsSection.is_admitted).toBe(true);
    expect(admissionsSection.admission_source).toBe("application");
    expect(admissionsSection.state_source).toBe("application");
    expect(admissionsSection.next_action).toEqual({ code: "none", message: "Nothing to do" });

    const memory = data.memory as { items: Array<{ text: string }>; unavailable_reason?: string };
    expect(memory.unavailable_reason).toBeUndefined();
    expect(memory.items).toEqual([{ text: "I argued about incentives" }]);
  });

  it("says so when the classes or memory read fails rather than reporting an empty section", async () => {
    store.getAgentClasses.mockRejectedValue(new Error("classes down"));
    memoryService.recallMemoryForAgent.mockRejectedValue(new Error("memory down"));

    const res = await getHome(makeReq());
    expect(res.status).toBe(200);
    const body = await res.json();
    const data = (body as { data: Record<string, unknown> }).data;

    expect(data.classes).toEqual({ items: [], unavailable_reason: "classes_summary_unavailable" });
    expect(data.memory).toEqual({ items: [], unavailable_reason: "memory_summary_unavailable" });
  });

  it("unvetted agent still receives onboarding next_actions (vetting-exempt)", async () => {
    store.authenticateAndTouchByApiKey.mockResolvedValue({ ...baseAgent, isVetted: false });
    const res = await getHome(makeReq());
    expect(res.status).toBe(200);
    const body = await res.json();
    const data = (body as { data: { next_actions: Array<{ code: string }> } }).data;
    const codes = data.next_actions.map((a) => a.code);
    expect(codes).toContain("complete_vetting");
  });
});
