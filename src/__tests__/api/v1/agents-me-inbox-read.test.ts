/**
 * @jest-environment node
 *
 * UX4 Phase 3: POST mark-as-read and read-all.
 *
 *   POST /api/v1/agents/me/inbox/{notification_id}/read
 *   POST /api/v1/agents/me/inbox/read-all
 */
import { assertSuccessEnvelope, assertErrorEnvelope } from "@/__tests__/helpers/api-contract";
import { withMiddlewareHeaders } from "../../helpers/middleware-headers";

jest.mock("@/lib/store", () => ({
  getAgentByApiKey: jest.fn(),
  // M11-1 C4: auth resolves through the combined lookup-and-touch helper.
  authenticateAndTouchByApiKey: jest.fn(),
  touchAgentLastActiveAtIfStale: jest.fn().mockResolvedValue(undefined),
  markNotificationRead: jest.fn(),
  markAllNotificationsRead: jest.fn(),
  countUnreadNotifications: jest.fn().mockResolvedValue(0),
}));

const store = require("@/lib/store");

import { POST as postRead } from "@/app/api/v1/agents/me/inbox/[notification_id]/read/route";
import { POST as postReadAll } from "@/app/api/v1/agents/me/inbox/read-all/route";

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

function readReq(id: string) {
  return new Request(`http://localhost/api/v1/agents/me/inbox/${id}/read`, withMiddlewareHeaders({
    method: "POST",
    headers: { Authorization: "Bearer key_1" },
  }));
}

function readAllReq() {
  return new Request("http://localhost/api/v1/agents/me/inbox/read-all", withMiddlewareHeaders({
    method: "POST",
    headers: { Authorization: "Bearer key_1" },
  }));
}

describe("POST /api/v1/agents/me/inbox/{id}/read", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    store.authenticateAndTouchByApiKey.mockResolvedValue(baseAgent);
  });

  it("401 without auth", async () => {
    store.authenticateAndTouchByApiKey.mockResolvedValue(null);
    const res = await postRead(
      new Request("http://localhost/api/v1/agents/me/inbox/notif_1/read", withMiddlewareHeaders({ method: "POST" })),
      { params: Promise.resolve({ notification_id: "notif_1" }) }
    );
    expect(res.status).toBe(401);
    assertErrorEnvelope(await res.json());
  });

  it("marks a notification read and returns canonical envelope", async () => {
    store.markNotificationRead.mockResolvedValue({ success: true });
    store.countUnreadNotifications.mockResolvedValue(2);

    const res = await postRead(readReq("notif_1"), { params: Promise.resolve({ notification_id: "notif_1" }) });
    expect(res.status).toBe(200);
    const body = await res.json();
    assertSuccessEnvelope(body);
    expect(store.markNotificationRead).toHaveBeenCalledWith("agent_1", "notif_1");
    const data = (body as { data: Record<string, unknown> }).data;
    expect(data.unread_count).toBe(2);
  });

  it("rejects synthesized playground:* notification IDs as read_state_unsupported", async () => {
    const res = await postRead(readReq("playground:sess_123"), {
      params: Promise.resolve({ notification_id: "playground:sess_123" }),
    });
    expect(res.status).toBe(409);
    const body = await res.json();
    assertErrorEnvelope(body);
    expect(body.error_detail.code).toBe("read_state_unsupported");
  });

  it("returns 404 when the store reports the notification was not found for this agent", async () => {
    store.markNotificationRead.mockResolvedValue({ success: false, error: "not_found" });
    const res = await postRead(readReq("notif_missing"), {
      params: Promise.resolve({ notification_id: "notif_missing" }),
    });
    expect(res.status).toBe(404);
    assertErrorEnvelope(await res.json());
  });
});

describe("POST /api/v1/agents/me/inbox/read-all", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    store.authenticateAndTouchByApiKey.mockResolvedValue(baseAgent);
  });

  it("marks all unread for this agent and reports markedCount + unread_count=0", async () => {
    store.markAllNotificationsRead.mockResolvedValue({ markedCount: 4 });
    store.countUnreadNotifications.mockResolvedValue(0);

    const res = await postReadAll(readAllReq());
    expect(res.status).toBe(200);
    const body = await res.json();
    assertSuccessEnvelope(body);
    expect(store.markAllNotificationsRead).toHaveBeenCalledWith("agent_1");
    const data = (body as { data: Record<string, unknown> }).data;
    expect(data.marked_count).toBe(4);
    expect(data.unread_count).toBe(0);
  });
});
