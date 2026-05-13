/**
 * UX4 Phase 4: social notifications emitted at store write sites.
 *
 * Verifies that comment/reply/follow paths create notification rows for the
 * appropriate recipient (not the actor themselves).
 */
jest.mock("@/lib/db", () => ({
  hasDatabase: () => false,
  sql: null,
}));

describe("social notifications (memory write sites)", () => {
  beforeEach(() => {
    jest.resetModules();
  });

  async function freshStores() {
    const memory = await import("@/lib/store/_memory-state");
    memory.activityEvents.clear();
    memory.agents.clear();
    memory.apiKeyToAgentId.clear();
    memory.claimTokenToAgentId.clear();
    memory.groups.clear();
    memory.posts.clear();
    memory.comments.clear();
    memory.following.clear();
    return memory;
  }

  it("notifies the post author when someone else comments on their post", async () => {
    await freshStores();
    const { createAgent } = await import("@/lib/store/agents/memory");
    const { createGroup } = await import("@/lib/store/groups/memory");
    const { createPost } = await import("@/lib/store/posts/memory");
    const { createComment } = await import("@/lib/store/comments/memory");
    const { listNotifications } = await import("@/lib/store/notifications/memory");

    const ada = await createAgent("ada", "Author");
    const bob = await createAgent("bob", "Commenter");
    const group = await createGroup("research", "Research", "Lab", ada.id);
    const post = await createPost(ada.id, group.id, "Hello", "World");
    await createComment(post.id, bob.id, "Great post.");

    const adasInbox = await listNotifications(ada.id);
    expect(adasInbox).toHaveLength(1);
    expect(adasInbox[0].type).toBe("comment_on_my_post");
    expect(adasInbox[0].actor.id).toBe(bob.id);

    // Author commenting on own post should NOT self-notify.
    await createComment(post.id, ada.id, "Self note.");
    const adasInboxAfter = await listNotifications(ada.id);
    expect(adasInboxAfter).toHaveLength(1);
  });

  it("notifies the parent comment author on a reply", async () => {
    await freshStores();
    const { createAgent } = await import("@/lib/store/agents/memory");
    const { createGroup } = await import("@/lib/store/groups/memory");
    const { createPost } = await import("@/lib/store/posts/memory");
    const { createComment } = await import("@/lib/store/comments/memory");
    const { listNotifications } = await import("@/lib/store/notifications/memory");

    const ada = await createAgent("ada", "Original author");
    const bob = await createAgent("bob", "First commenter");
    const carol = await createAgent("carol", "Replier");
    const group = await createGroup("research", "Research", "Lab", ada.id);
    const post = await createPost(ada.id, group.id, "Hello", "World");
    const parent = await createComment(post.id, bob.id, "Top-level comment.");
    expect(parent).not.toBeNull();
    await createComment(post.id, carol.id, "Reply to bob.", parent!.id);

    const bobsInbox = await listNotifications(bob.id);
    const replyOnes = bobsInbox.filter((n) => n.type === "reply_to_my_comment");
    expect(replyOnes).toHaveLength(1);
    expect(replyOnes[0].actor.id).toBe(carol.id);
    expect(replyOnes[0].metadata?.parent_comment_id).toBe(parent!.id);
  });

  it("notifies the followee when a new follower arrives, but not when the same follower follows again", async () => {
    await freshStores();
    const { createAgent, followAgent } = await import("@/lib/store/agents/memory");
    const { listNotifications } = await import("@/lib/store/notifications/memory");

    const ada = await createAgent("ada", "Followee");
    const bob = await createAgent("bob", "Follower");

    await followAgent(bob.id, ada.name);
    await followAgent(bob.id, ada.name); // idempotent

    const adasInbox = await listNotifications(ada.id);
    const followerNotifs = adasInbox.filter((n) => n.type === "new_follower");
    expect(followerNotifs).toHaveLength(1);
    expect(followerNotifs[0].actor.id).toBe(bob.id);
  });
});
