/**
 * M11b lane M (P6.1, codex round 1 F1) — the mention notification writer must not create a
 * dead-link row for a post the consumer's pre-read saw live but that has since been deleted.
 *
 * @jest-environment node
 */
jest.mock("@/lib/db", () => ({ hasDatabase: () => false, sql: null }));

describe("createMentionNotificationIdempotent (memory) — post liveness", () => {
  beforeEach(() => jest.resetModules());

  async function freshStores() {
    const memory = await import("@/lib/store/_memory-state");
    memory.agents.clear();
    memory.posts.clear();
    memory.notifications.clear();
    memory.notificationDedupKeys.clear();
    return memory;
  }

  it("creates nothing for a post deleted after the consumer's pre-read", async () => {
    const { agents, posts } = await freshStores();
    const { createMentionNotificationIdempotent } = await import("@/lib/store/notifications/memory");
    agents.set("recipient", { id: "recipient", name: "recipient" } as never);
    posts.set("post1", { id: "post1", title: "t", deletedAt: new Date().toISOString() } as never);

    const result = await createMentionNotificationIdempotent({
      dedupKey: "dk1",
      recipientAgentId: "recipient",
      actorAgentId: "actor",
      postId: "post1",
      createdAt: new Date().toISOString(),
    });

    expect(result).toBeNull();
  });

  it("creates nothing for a post id that was never inserted", async () => {
    const { agents } = await freshStores();
    const { createMentionNotificationIdempotent } = await import("@/lib/store/notifications/memory");
    agents.set("recipient", { id: "recipient", name: "recipient" } as never);

    const result = await createMentionNotificationIdempotent({
      dedupKey: "dk2",
      recipientAgentId: "recipient",
      actorAgentId: "actor",
      postId: "missing-post",
      createdAt: new Date().toISOString(),
    });

    expect(result).toBeNull();
  });

  it("codex round 3 F2: creates nothing for a recipient hidden by consume time", async () => {
    const { agents, posts } = await freshStores();
    const { createMentionNotificationIdempotent } = await import("@/lib/store/notifications/memory");
    agents.set("recipient", { id: "recipient", name: "recipient", metadata: { test: true } } as never);
    posts.set("post3", { id: "post3", title: "t" } as never);

    const result = await createMentionNotificationIdempotent({
      dedupKey: "dk4",
      recipientAgentId: "recipient",
      actorAgentId: "actor",
      postId: "post3",
      createdAt: new Date().toISOString(),
    });

    expect(result).toBeNull();
  });

  it("still creates a notification for a live post (control)", async () => {
    const { agents, posts } = await freshStores();
    const { createMentionNotificationIdempotent } = await import("@/lib/store/notifications/memory");
    agents.set("recipient", { id: "recipient", name: "recipient" } as never);
    posts.set("post2", { id: "post2", title: "t" } as never);

    const result = await createMentionNotificationIdempotent({
      dedupKey: "dk3",
      recipientAgentId: "recipient",
      actorAgentId: "actor",
      postId: "post2",
      createdAt: new Date().toISOString(),
    });

    expect(result).not.toBeNull();
    expect(result?.type).toBe("mention");
  });
});
