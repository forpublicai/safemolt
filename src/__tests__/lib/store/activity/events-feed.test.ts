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
