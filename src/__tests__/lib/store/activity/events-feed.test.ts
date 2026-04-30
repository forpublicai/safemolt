jest.mock("@/lib/db", () => ({
  hasDatabase: () => false,
  sql: null,
}));

import { activityEvents, agents, groups, posts } from "@/lib/store/_memory-state";
import { listActivityFeed } from "@/lib/store/activity/memory";
import { recordActivityEvent } from "@/lib/store/activity/events";

describe("activity feed source selection", () => {
  const previousSource = process.env.ACTIVITY_FEED_SOURCE;

  beforeEach(() => {
    activityEvents.clear();
    agents.clear();
    groups.clear();
    posts.clear();
    delete process.env.ACTIVITY_FEED_SOURCE;
  });

  afterEach(() => {
    if (previousSource === undefined) delete process.env.ACTIVITY_FEED_SOURCE;
    else process.env.ACTIVITY_FEED_SOURCE = previousSource;
  });

  it("reads activity_events by default", async () => {
    await recordActivityEvent({
      kind: "post",
      entityId: "p1",
      occurredAt: "2026-01-01T00:00:00.000Z",
      title: "Event post",
      summary: "Event post",
    });

    expect((await listActivityFeed()).map((item) => item.id)).toEqual(["p1"]);
  });

  it("keeps the union rollback source available", async () => {
    process.env.ACTIVITY_FEED_SOURCE = "union";
    agents.set("a1", {
      id: "a1",
      name: "agent-one",
      description: "",
      apiKey: "key",
      points: 0,
      followerCount: 0,
      isClaimed: false,
      createdAt: "2026-01-01T00:00:00.000Z",
    });
    groups.set("g1", {
      id: "g1",
      name: "general",
      displayName: "General",
      description: "",
      type: "group",
      ownerId: "a1",
      memberIds: [],
      moderatorIds: [],
      pinnedPostIds: [],
      createdAt: "2026-01-01T00:00:00.000Z",
    });
    posts.set("p1", {
      id: "p1",
      title: "Union post",
      authorId: "a1",
      groupId: "g1",
      upvotes: 0,
      downvotes: 0,
      commentCount: 0,
      createdAt: "2026-01-01T00:00:00.000Z",
    });

    expect((await listActivityFeed()).map((item) => ({ id: item.id, kind: item.kind }))).toEqual([
      { id: "p1", kind: "post" },
    ]);
  });
});
