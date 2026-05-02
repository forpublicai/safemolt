jest.mock("@/lib/db", () => ({
  hasDatabase: () => false,
  sql: null,
}));

import { activityContextKey, activityContexts, activityEvents } from "@/lib/store/_memory-state";
import { listActivityEvents, recordActivityEvent } from "@/lib/store/activity/events";

describe("activity events memory store", () => {
  beforeEach(() => {
    activityContexts.clear();
    activityEvents.clear();
  });

  it("updates duplicate kind/entityId events instead of duplicating", async () => {
    await recordActivityEvent({
      kind: "post",
      entityId: "p1",
      occurredAt: "2026-01-01T00:00:00.000Z",
      title: "Old",
      summary: "Old",
    });
    await recordActivityEvent({
      kind: "post",
      entityId: "p1",
      occurredAt: "2026-01-01T00:01:00.000Z",
      title: "New",
      summary: "New",
      searchText: "fresh words",
    });

    const events = await listActivityEvents();
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ id: "p1", title: "New", searchText: "fresh words" });
  });

  it("returns newest first and supports type, search, and before filters", async () => {
    await recordActivityEvent({
      kind: "post",
      entityId: "p1",
      occurredAt: "2026-01-01T00:00:00.000Z",
      title: "Alpha",
      summary: "Alpha",
      searchText: "alpha",
    });
    await recordActivityEvent({
      kind: "comment",
      entityId: "c1",
      occurredAt: "2026-01-01T00:02:00.000Z",
      title: "Beta",
      summary: "Beta",
      searchText: "needle beta",
    });
    await recordActivityEvent({
      kind: "post",
      entityId: "p2",
      occurredAt: "2026-01-01T00:03:00.000Z",
      title: "Gamma",
      summary: "Gamma",
      searchText: "needle gamma",
    });

    expect((await listActivityEvents()).map((event) => event.id)).toEqual(["p2", "c1", "p1"]);
    expect((await listActivityEvents({ types: ["post"] })).map((event) => event.id)).toEqual(["p2", "p1"]);
    expect((await listActivityEvents({ query: "needle" })).map((event) => event.id)).toEqual(["p2", "c1"]);
    expect((await listActivityEvents({ before: "2026-01-01T00:03:00.000Z" })).map((event) => event.id)).toEqual(["c1", "p1"]);
  });

  it("uses a compound cursor for events with the same timestamp", async () => {
    const occurredAt = "2026-01-01T00:00:00.000Z";
    await recordActivityEvent({
      kind: "post",
      entityId: "p1",
      occurredAt,
      title: "First",
      summary: "First",
    });
    await recordActivityEvent({
      kind: "post",
      entityId: "p2",
      occurredAt,
      title: "Second",
      summary: "Second",
    });

    const firstPage = await listActivityEvents({ limit: 1 });
    expect(firstPage).toHaveLength(1);
    expect((await listActivityEvents({ before: occurredAt, beforeId: firstPage[0].cursorId, limit: 1 })).map((event) => event.id)).toEqual(["p1"]);
  });

  it("invalidates cached activity contexts when an event row is rewritten", async () => {
    await recordActivityEvent({
      kind: "playground_session",
      entityId: "session-1",
      occurredAt: "2026-01-01T00:00:00.000Z",
      title: "lobby",
      summary: "lobby",
    });
    activityContexts.set(activityContextKey("playground_session", "session-1", "activity-trail-enriched-v1"), {
      activityKind: "playground_session",
      activityId: "session-1",
      promptVersion: "activity-trail-enriched-v1",
      content: "stale lobby context",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    });

    await recordActivityEvent({
      kind: "playground_session",
      entityId: "session-1",
      occurredAt: "2026-01-01T00:01:00.000Z",
      title: "active",
      summary: "active",
    });

    expect(activityContexts.has(activityContextKey("playground_session", "session-1", "activity-trail-enriched-v1"))).toBe(false);
  });
});
