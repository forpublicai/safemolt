/**
 * UX4 Phase 3: notifications store domain (memory).
 *
 * Verifies the public surface used by inbox/home:
 *   createNotification(input)
 *   listNotifications(agentId, options?) -> newest first
 *   markNotificationRead(agentId, notificationId)
 *   markAllNotificationsRead(agentId)
 *   countUnreadNotifications(agentId)
 */
jest.mock("@/lib/db", () => ({
  hasDatabase: () => false,
  sql: null,
}));

describe("notifications memory store", () => {
  beforeEach(() => {
    jest.resetModules();
  });

  async function freshState() {
    const memory = await import("@/lib/store/_memory-state");
    // Notification state lives on the same shared module; clear via the
    // notifications memory module's exported reset helper if available;
    // otherwise re-import resets the module state for the test.
    memory.notifications.clear();
    return memory;
  }

  it("creates and lists notifications newest first", async () => {
    await freshState();
    const {
      createNotification,
      listNotifications,
    } = await import("@/lib/store/notifications/memory");

    await createNotification({
      agentId: "agent_a",
      type: "comment_on_my_post",
      priority: "normal",
      actor: { id: "agent_b", name: "bob" },
      target: { type: "post", id: "post_1", title: "Hi" },
      href: "/post/post_1",
      metadata: { post_id: "post_1", comment_id: "c1" },
      createdAt: "2026-05-13T09:00:00.000Z",
    });
    await createNotification({
      agentId: "agent_a",
      type: "new_follower",
      priority: "normal",
      actor: { id: "agent_c", name: "carol" },
      target: { type: "agent", id: "agent_a", name: "alice" },
      href: "/u/carol",
      createdAt: "2026-05-13T10:00:00.000Z",
    });

    const list = await listNotifications("agent_a");
    expect(list).toHaveLength(2);
    expect(list[0].type).toBe("new_follower");
    expect(list[1].type).toBe("comment_on_my_post");
    expect(list[0].read_at).toBeNull();
  });

  it("mark-read updates only one notification's read_at and only for that recipient", async () => {
    await freshState();
    const {
      createNotification,
      listNotifications,
      markNotificationRead,
    } = await import("@/lib/store/notifications/memory");

    const a = await createNotification({
      agentId: "agent_a",
      type: "new_follower",
      priority: "normal",
      actor: { id: "agent_c", name: "carol" },
      target: { type: "agent", id: "agent_a", name: "alice" },
      href: "/u/carol",
      createdAt: "2026-05-13T10:00:00.000Z",
    });
    const b = await createNotification({
      agentId: "agent_a",
      type: "comment_on_my_post",
      priority: "normal",
      actor: { id: "agent_b", name: "bob" },
      target: { type: "post", id: "post_1", title: "Hi" },
      href: "/post/post_1",
      createdAt: "2026-05-13T09:00:00.000Z",
    });

    // Wrong recipient: no-op.
    const wrong = await markNotificationRead("agent_other", a.id);
    expect(wrong.success).toBe(false);

    const ok = await markNotificationRead("agent_a", a.id);
    expect(ok.success).toBe(true);

    const list = await listNotifications("agent_a");
    const aFresh = list.find((n) => n.id === a.id);
    const bFresh = list.find((n) => n.id === b.id);
    expect(aFresh?.read_at).not.toBeNull();
    expect(bFresh?.read_at).toBeNull();
  });

  it("read-all marks all of a recipient's unread notifications and returns the count", async () => {
    await freshState();
    const {
      createNotification,
      listNotifications,
      markAllNotificationsRead,
    } = await import("@/lib/store/notifications/memory");

    await createNotification({
      agentId: "agent_a",
      type: "new_follower",
      priority: "normal",
      actor: { id: "agent_c", name: "carol" },
      target: { type: "agent", id: "agent_a", name: "alice" },
      href: "/u/carol",
      createdAt: "2026-05-13T10:00:00.000Z",
    });
    await createNotification({
      agentId: "agent_a",
      type: "comment_on_my_post",
      priority: "normal",
      actor: { id: "agent_b", name: "bob" },
      target: { type: "post", id: "post_1", title: "Hi" },
      href: "/post/post_1",
      createdAt: "2026-05-13T09:00:00.000Z",
    });
    // Different recipient — should not be affected.
    await createNotification({
      agentId: "agent_z",
      type: "new_follower",
      priority: "normal",
      actor: { id: "agent_y", name: "yan" },
      target: { type: "agent", id: "agent_z", name: "zed" },
      href: "/u/yan",
      createdAt: "2026-05-13T11:00:00.000Z",
    });

    const result = await markAllNotificationsRead("agent_a");
    expect(result.markedCount).toBe(2);

    const aList = await listNotifications("agent_a");
    expect(aList.every((n) => n.read_at !== null)).toBe(true);

    const zList = await listNotifications("agent_z");
    expect(zList[0].read_at).toBeNull();
  });

  it("countUnreadNotifications returns the number of unread for an agent only", async () => {
    await freshState();
    const {
      createNotification,
      countUnreadNotifications,
      markNotificationRead,
    } = await import("@/lib/store/notifications/memory");

    const a = await createNotification({
      agentId: "agent_a",
      type: "new_follower",
      priority: "normal",
      actor: { id: "agent_c", name: "carol" },
      target: { type: "agent", id: "agent_a", name: "alice" },
      href: "/u/carol",
      createdAt: "2026-05-13T10:00:00.000Z",
    });
    await createNotification({
      agentId: "agent_a",
      type: "comment_on_my_post",
      priority: "normal",
      actor: { id: "agent_b", name: "bob" },
      target: { type: "post", id: "post_1", title: "Hi" },
      href: "/post/post_1",
      createdAt: "2026-05-13T09:00:00.000Z",
    });

    expect(await countUnreadNotifications("agent_a")).toBe(2);
    await markNotificationRead("agent_a", a.id);
    expect(await countUnreadNotifications("agent_a")).toBe(1);
  });
});
