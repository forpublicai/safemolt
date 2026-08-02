/**
 * UX4 Phase 5: agent-home inbox section now summarizes unread/high-priority
 * counts and a capped preview without auto-marking anything read.
 *
 * It must continue to ship valid AgentHomePayload (no PII regressions).
 */
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
  getPlaygroundActions: jest.fn().mockResolvedValue([]),
  getGroupMemberCount: jest.fn().mockResolvedValue(0),
  getFollowingCount: jest.fn().mockResolvedValue(0),
  listNotifications: jest.fn(),
  countUnreadNotifications: jest.fn(),
  markNotificationRead: jest.fn(),
  markAllNotificationsRead: jest.fn(),
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

jest.mock("@/lib/agent-loop-actions", () => ({
  listRecentLoopActions: jest.fn().mockResolvedValue([]),
}));

const store = require("@/lib/store");
const loopActions = require("@/lib/agent-loop-actions");

import { buildAgentHomePayload } from "@/lib/agent-home/service";

const baseAgent = {
  id: "agent_1",
  name: "Acto",
  description: "",
  apiKey: "key_1",
  points: 0,
  followerCount: 0,
  isClaimed: false,
  createdAt: "2026-05-01T00:00:00.000Z",
  isVetted: true,
};

describe("agent-home inbox summary", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    store.listNotifications.mockResolvedValue([]);
    store.countUnreadNotifications.mockResolvedValue(0);
    loopActions.listRecentLoopActions.mockResolvedValue([]);
  });

  it("zero notifications yields unavailable=null and zero counts", async () => {
    const payload = await buildAgentHomePayload(baseAgent);
    expect(payload.inbox.items).toEqual([]);
    expect(payload.inbox.unread_count).toBe(0);
    expect(payload.inbox.high_priority_count).toBe(0);
    expect(payload.inbox.unavailable_reason).toBeUndefined();
  });

  it("caps preview to 3 items and reports unread_count + high_priority_count", async () => {
    const baseFields = {
      agent_id: "agent_1",
      actor: { id: "agent_2", name: "bob" },
      target: { type: "post", id: "post_1", title: "Hi" },
      href: "/post/post_1",
      metadata: {},
    };
    const items = Array.from({ length: 10 }, (_, i) => ({
      id: `notif_${i}`,
      type: i === 0 ? "comment_on_my_post" : "new_follower",
      priority: i % 2 === 0 ? "high" : "normal",
      created_at: `2026-05-13T${String(10 + (10 - i)).padStart(2, "0")}:00:00.000Z`,
      read_at: null,
      ...baseFields,
    }));
    store.listNotifications.mockResolvedValue(items);
    store.countUnreadNotifications.mockResolvedValue(10);

    const payload = await buildAgentHomePayload(baseAgent);
    expect(payload.inbox.items.length).toBeLessThanOrEqual(3);
    expect(payload.inbox.unread_count).toBe(10);
    expect(payload.inbox.high_priority_count).toBeGreaterThan(0);
  });

  it("does NOT auto-mark notifications read when summarizing home", async () => {
    const items = [
      {
        id: "notif_1",
        agent_id: "agent_1",
        type: "comment_on_my_post",
        priority: "normal",
        created_at: "2026-05-13T09:00:00.000Z",
        read_at: null,
        actor: { id: "agent_2", name: "bob" },
        target: { type: "post", id: "post_1", title: "Hi" },
        href: "/post/post_1",
        metadata: {},
      },
    ];
    store.listNotifications.mockResolvedValue(items);
    store.countUnreadNotifications.mockResolvedValue(1);

    await buildAgentHomePayload(baseAgent);
    expect(store.markNotificationRead).not.toHaveBeenCalled();
    expect(store.markAllNotificationsRead).not.toHaveBeenCalled();
  });

  it("exposes capped recent loop action summaries", async () => {
    loopActions.listRecentLoopActions.mockResolvedValue([
      {
        action: "create_comment",
        targetType: "post",
        targetId: "post_1",
        contentSnippet: "A concrete reply",
        createdAt: "2026-05-13T10:00:00.000Z",
      },
    ]);

    const payload = await buildAgentHomePayload(baseAgent);
    expect(loopActions.listRecentLoopActions).toHaveBeenCalledWith("agent_1", 5);
    expect(payload.loop.recent_actions).toEqual([
      {
        action: "create_comment",
        target_type: "post",
        target_id: "post_1",
        content_snippet: "A concrete reply",
        created_at: "2026-05-13T10:00:00.000Z",
      },
    ]);
  });
});
