jest.mock("@/lib/db", () => ({
  hasDatabase: () => false,
  sql: null,
}));

describe("activity feed event projection", () => {
  beforeEach(() => {
    jest.resetModules();
  });

  it("reads activity_events", async () => {
    const { activityEvents } = await import("@/lib/store/_memory-state");
    const { listActivityFeed } = await import("@/lib/store/activity/memory");
    const { recordActivityEvent } = await import("@/lib/store/activity/events");
    activityEvents.clear();

    await recordActivityEvent({
      kind: "post",
      entityId: "p1",
      occurredAt: "2026-01-01T00:00:00.000Z",
      title: "Event post",
      summary: "Event post",
    });

    expect((await listActivityFeed()).map((item) => item.id)).toEqual(["p1"]);
  });

  it("projects post and comment creation into the activity feed", async () => {
    const {
      activityEvents,
      agents,
      apiKeyToAgentId,
      claimTokenToAgentId,
      comments,
      groups,
      posts,
    } = await import("@/lib/store/_memory-state");
    const { createAgent } = await import("@/lib/store/agents/memory");
    const { createGroup } = await import("@/lib/store/groups/memory");
    // Fixture writers: C16's cooldown refuses same-author writes made back to back, and these
    // tests are about projections and notifications, not about the rate windows.
    const { seedPost: createPost, seedComment: createComment } = await import(
      "@/__tests__/helpers/store-fixtures"
    );
    const { listActivityFeed } = await import("@/lib/store/activity/memory");

    activityEvents.clear();
    agents.clear();
    apiKeyToAgentId.clear();
    claimTokenToAgentId.clear();
    comments.clear();
    groups.clear();
    posts.clear();

    const agent = await createAgent("ada", "Writes careful notes.");
    const group = await createGroup("activity-test", "Activity Test", "Projection checks", agent.id);
    const post = await createPost(agent.id, group.id, "Projection launch", "Hello from the writer");
    const comment = await createComment(post.id, agent.id, "The comment is live.");

    expect(comment).not.toBeNull();
    const feed = await listActivityFeed({ types: ["post", "comment"], limit: 10 });

    expect(feed).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: post.id,
          kind: "post",
          title: "Projection launch",
          href: `/post/${post.id}`,
        }),
        expect.objectContaining({
          id: comment!.id,
          kind: "comment",
          title: "Comment on Projection launch",
          href: `/post/${post.id}`,
        }),
      ])
    );
  });

  it("refreshes playground session activity when participants or context change", async () => {
    const {
      activityEvents,
      agents,
      apiKeyToAgentId,
      claimTokenToAgentId,
      playgroundSessions,
    } = await import("@/lib/store/_memory-state");
    const { createAgent } = await import("@/lib/store/agents/memory");
    const {
      createPlaygroundSession,
      joinPlaygroundSession,
      updatePlaygroundSession,
    } = await import("@/lib/store/playground/memory");
    const { listActivityFeed } = await import("@/lib/store/activity/memory");

    activityEvents.clear();
    agents.clear();
    apiKeyToAgentId.clear();
    claimTokenToAgentId.clear();
    playgroundSessions.clear();

    const first = await createAgent("first", "First player");
    const second = await createAgent("second", "Second player");
    await createPlaygroundSession({
      id: "session-activity-refresh",
      gameId: "test-game",
      status: "pending",
      participants: [{ agentId: first.id, agentName: first.name, status: "active" }],
      currentRound: 1,
      currentRoundPrompt: "Opening prompt",
      maxRounds: 2,
      schoolId: "foundation",
    });

    expect((await listActivityFeed({ types: ["playground"], limit: 1 }))[0].summary).toContain("1 participant");

    await joinPlaygroundSession(
      "session-activity-refresh",
      { agentId: second.id, agentName: second.name, status: "active" },
      2
    );

    const [activity] = await listActivityFeed({ types: ["playground"], limit: 1 });
    expect(activity.summary).toContain("2 participant");
    expect(activity.searchText).toContain("second");

    await updatePlaygroundSession("session-activity-refresh", {
      currentRoundPrompt: "Revised round prompt",
      summary: "Fresh session summary",
    });

    const [updatedActivity] = await listActivityFeed({ types: ["playground"], limit: 1 });
    expect(updatedActivity.contextHint).toBe("Fresh session summary");
  });

  it("over-fetches so loop-event dedupe does not shrink visible pages", async () => {
    const { activityEvents } = await import("@/lib/store/_memory-state");
    const { recordActivityEvent } = await import("@/lib/store/activity/events");
    const { getActivityTrailPage } = await import("@/lib/activity");
    activityEvents.clear();

    await recordActivityEvent({
      kind: "agent_loop",
      entityId: "loop-p1",
      occurredAt: "2026-01-01T00:05:00.000Z",
      actorName: "Ada",
      actorCanonicalName: "ada",
      title: "Ada create_post",
      summary: "Ada created a post",
      metadata: { action: "create_post", target_type: "post", target_id: "p1", target_title: "First" },
    });
    await recordActivityEvent({
      kind: "agent_loop",
      entityId: "loop-p2",
      occurredAt: "2026-01-01T00:04:00.000Z",
      actorName: "Ada",
      actorCanonicalName: "ada",
      title: "Ada create_post",
      summary: "Ada created a post",
      metadata: { action: "create_post", target_type: "post", target_id: "p2", target_title: "Second" },
    });
    await recordActivityEvent({
      kind: "post",
      entityId: "p1",
      occurredAt: "2026-01-01T00:03:00.000Z",
      actorName: "Ada",
      actorCanonicalName: "ada",
      title: "First",
      summary: "First post",
      metadata: { post_id: "p1" },
    });
    await recordActivityEvent({
      kind: "post",
      entityId: "p2",
      occurredAt: "2026-01-01T00:02:00.000Z",
      actorName: "Ada",
      actorCanonicalName: "ada",
      title: "Second",
      summary: "Second post",
      metadata: { post_id: "p2" },
    });
    await recordActivityEvent({
      kind: "comment",
      entityId: "c1",
      occurredAt: "2026-01-01T00:01:00.000Z",
      actorName: "Ada",
      actorCanonicalName: "ada",
      title: "Comment on First",
      summary: "Comment",
      metadata: { comment_id: "c1", post_id: "p1", post_title: "First" },
    });

    const page = await getActivityTrailPage({ limit: 3 });

    expect(page.activities).toHaveLength(3);
    expect(page.activities.map((activity) => `${activity.kind}:${activity.id}`)).toEqual([
      "post:p1",
      "post:p2",
      "comment:c1",
    ]);
  });
});
