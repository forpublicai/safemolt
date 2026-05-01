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
});
