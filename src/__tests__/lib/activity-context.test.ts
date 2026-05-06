import type { ActivityItem } from "@/lib/activity";

const publicKinds = new Set([
  "platform_post",
  "platform_comment",
  "playground_action",
  "playground_gm",
  "agent_loop_action",
]);

function commentActivity(overrides: Partial<ActivityItem> = {}): ActivityItem {
  return {
    id: "comment_1",
    kind: "comment",
    occurredAt: "2026-04-23T14:12:00.000Z",
    timestampLabel: "04-23 14:12",
    actorId: "agent_1",
    actorName: "Agent",
    title: "Comment on A post",
    segments: [],
    summary: "Comment: useful note",
    contextHint: "useful note",
    searchText: "comment useful note",
    ...overrides,
  };
}

describe("activity context memory lookup", () => {
  beforeEach(() => {
    jest.resetModules();
    jest.dontMock("@/lib/memory/memory-service");
  });

  it("filters private memory kinds and removes the same comment memory", async () => {
    const listPublicPlatformMemoriesForAgent = jest.fn(async () => [
      {
        id: "same-comment",
        text: "Post: A post\n\nComment:\nuseful note",
        kind: "platform_comment",
        metadata: { kind: "platform_comment", comment_id: "comment_1" },
      },
      {
        id: "private-note",
        text: "private context",
        kind: "note",
        metadata: { kind: "note" },
      },
      {
        id: "other-post",
        text: "A related public post",
        kind: "platform_post",
        metadata: { kind: "platform_post", post_id: "post_2" },
      },
    ]);

    jest.doMock("@/lib/memory/memory-service", () => ({
      isPublicPlatformMemoryKind: (kind: unknown) => typeof kind === "string" && publicKinds.has(kind),
      listPublicPlatformMemoriesForAgent,
    }));

    const { listPublicMemoriesForActivity } = await import("@/lib/activity-context");
    const memories = await listPublicMemoriesForActivity(commentActivity());

    expect(memories.map((memory) => memory.id)).toEqual(["other-post"]);
    expect(listPublicPlatformMemoriesForAgent).toHaveBeenCalledWith("agent_1", 6);
  });

  it("removes post self-references from public memories", async () => {
    jest.doMock("@/lib/memory/memory-service", () => ({
      isPublicPlatformMemoryKind: (kind: unknown) => typeof kind === "string" && publicKinds.has(kind),
      listPublicPlatformMemoriesForAgent: jest.fn(async () => [
        {
          id: "same-post",
          text: "The post itself",
          kind: "platform_post",
          metadata: { kind: "platform_post", post_id: "post_1" },
        },
        {
          id: "other-comment",
          text: "Post: Something else\n\nComment:\nA useful related comment.",
          kind: "platform_comment",
          metadata: { kind: "platform_comment", post_id: "post_2", comment_id: "comment_2" },
        },
      ]),
    }));

    const { listPublicMemoriesForActivity } = await import("@/lib/activity-context");
    const memories = await listPublicMemoriesForActivity({
      ...commentActivity({
        id: "post_1",
        kind: "post",
        title: "A post",
        summary: "Post: A post",
        contextHint: "A post",
      }),
    });

    expect(memories.map((memory) => memory.id)).toEqual(["other-comment"]);
  });

  it("falls back to no memories when the public memory scan fails", async () => {
    jest.doMock("@/lib/memory/memory-service", () => ({
      isPublicPlatformMemoryKind: (kind: unknown) => typeof kind === "string" && publicKinds.has(kind),
      listPublicPlatformMemoriesForAgent: jest.fn(async () => {
        throw new Error("backend unavailable");
      }),
    }));

    const { listPublicMemoriesForActivity } = await import("@/lib/activity-context");

    await expect(listPublicMemoriesForActivity(commentActivity())).resolves.toEqual([]);
  });
});

describe("public platform memory service", () => {
  it("does not return non-public vector kinds", async () => {
    jest.resetModules();
    jest.dontMock("@/lib/memory/memory-service");
    const { upsertVectorForAgent, listPublicPlatformMemoriesForAgent } = await import("@/lib/memory/memory-service");
    const agentId = `public-memory-filter-${Date.now()}`;

    await upsertVectorForAgent(agentId, "public-comment", "Public comment", {
      kind: "platform_comment",
      filed_at: "2026-04-23T14:12:00.000Z",
    });
    await upsertVectorForAgent(agentId, "private-note", "Private note", {
      kind: "note",
      filed_at: "2026-04-23T14:13:00.000Z",
    });

    const memories = await listPublicPlatformMemoriesForAgent(agentId, 10);

    expect(memories.map((memory) => memory.id)).toEqual(["public-comment"]);
  });
});
