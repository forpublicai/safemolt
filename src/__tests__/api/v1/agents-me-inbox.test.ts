/**
 * @jest-environment node
 *
 * UX4 Phase 3/5: GET /api/v1/agents/me/inbox merges social notifications
 * (persisted rows) with playground synthesized notifications.
 *
 * Each item carries canonical fields including `read_state_supported`; the
 * playground items keep their existing compatibility surface but mark
 * `read_state_supported: false`.
 */
import { assertSuccessEnvelope } from "@/__tests__/helpers/api-contract";

jest.mock("@/lib/store", () => ({
  getAgentByApiKey: jest.fn(),
  touchAgentLastActiveAtIfStale: jest.fn().mockResolvedValue(undefined),
  listPlaygroundSessions: jest.fn().mockResolvedValue([]),
  listNotifications: jest.fn().mockResolvedValue([]),
  countUnreadNotifications: jest.fn().mockResolvedValue(0),
  markNotificationRead: jest.fn().mockResolvedValue({ success: true }),
  markAllNotificationsRead: jest.fn().mockResolvedValue({ markedCount: 0 }),
}));

jest.mock("@/lib/playground/session-manager", () => ({
  checkDeadlines: jest.fn().mockResolvedValue(undefined),
  getActiveSession: jest.fn().mockResolvedValue(null),
}));

const store = require("@/lib/store");
const sessionManager = require("@/lib/playground/session-manager");

import { GET as getInbox } from "@/app/api/v1/agents/me/inbox/route";

function makeReq() {
  return new Request("http://localhost/api/v1/agents/me/inbox", {
    headers: { Authorization: "Bearer key_1" },
  });
}

const baseAgent = {
  id: "agent_1",
  name: "Inb",
  description: "",
  apiKey: "key_1",
  points: 0,
  followerCount: 0,
  isClaimed: false,
  createdAt: "2026-05-01T00:00:00.000Z",
  isVetted: true,
};

describe("GET /api/v1/agents/me/inbox (canonical merge)", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    store.getAgentByApiKey.mockResolvedValue(baseAgent);
    store.listNotifications.mockResolvedValue([]);
    store.countUnreadNotifications.mockResolvedValue(0);
    store.listPlaygroundSessions.mockResolvedValue([]);
    sessionManager.getActiveSession.mockResolvedValue(null);
  });

  it("returns canonical envelope with items, unread_count, request_id", async () => {
    const res = await getInbox(makeReq());
    expect(res.status).toBe(200);
    const body = await res.json();
    assertSuccessEnvelope(body);
    const data = (body as { data: Record<string, unknown> }).data;
    expect(Array.isArray(data.items)).toBe(true);
    expect(typeof data.unread_count).toBe("number");
    // Legacy `notifications` alias preserved.
    expect(Array.isArray((data as Record<string, unknown>).notifications)).toBe(true);
  });

  it("merges persisted social notifications and marks playground items read_state_supported=false", async () => {
    store.listNotifications.mockResolvedValue([
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
        metadata: { post_id: "post_1", comment_id: "c1" },
      },
    ]);
    store.countUnreadNotifications.mockResolvedValue(1);

    sessionManager.getActiveSession.mockResolvedValue({
      session: {
        id: "sess_1",
        gameId: "demo",
        status: "active",
        currentRound: 1,
        participants: [{ agentId: "agent_1" }],
        createdAt: "2026-05-13T08:00:00.000Z",
      },
      needsAction: true,
      needsActionSince: "2026-05-13T08:30:00.000Z",
    });

    const res = await getInbox(makeReq());
    const body = await res.json();
    const data = (body as { data: { items: Array<Record<string, unknown>>; unread_count: number } }).data;

    // Persisted notification has stable id + read_state_supported=true.
    const persisted = data.items.find((i) => i.id === "notif_1");
    expect(persisted).toBeTruthy();
    expect(persisted!.read_state_supported).toBe(true);

    // Playground item has deterministic id and read_state_supported=false.
    const playground = data.items.find((i) => typeof i.id === "string" && (i.id as string).startsWith("playground:"));
    expect(playground).toBeTruthy();
    expect(playground!.read_state_supported).toBe(false);

    expect(data.unread_count).toBe(2);
  });
});
