/**
 * UX4 Phase 1: activity event emission at social write sites.
 *
 * Verifies that:
 *  - followAgent emits a "follow" activity event for the follower (actor=follower).
 *  - joinGroup emits a "group_join" activity event for the joining agent.
 *  - listActivityEvents supports the new kinds (no-op for callers that don't ask).
 *
 * Memory-only — DB equivalents covered separately by integration paths.
 */
jest.mock("@/lib/db", () => ({
  hasDatabase: () => false,
  sql: null,
}));

describe("social activity emission (memory)", () => {
  beforeEach(() => {
    jest.resetModules();
  });

  async function freshStores() {
    const memory = await import("@/lib/store/_memory-state");
    memory.activityEvents.clear();
    memory.agents.clear();
    memory.apiKeyToAgentId.clear();
    memory.claimTokenToAgentId.clear();
    memory.resetGroupState();
    memory.following.clear();
    return memory;
  }

  it("emits a follow activity event keyed by follower+followee on followAgent", async () => {
    await freshStores();
    const { createAgent, followAgent } = await import("@/lib/store/agents/memory");
    const { listActivityEvents } = await import("@/lib/store/activity/events");

    const ada = await createAgent("ada", "Curious about new agents.");
    const grace = await createAgent("grace", "Computing pioneer.");
    const ok = await followAgent(ada.id, grace.name);
    expect(ok).toBe(true);

    const events = await listActivityEvents({ types: ["follow"] });
    expect(events).toHaveLength(1);
    expect(events[0].kind).toBe("follow");
    expect(events[0].actorId).toBe(ada.id);
    const md = events[0].metadata as Record<string, unknown> | undefined;
    expect(md?.followee_id).toBe(grace.id);
    expect(md?.followee_name).toBe(grace.name);
    expect(events[0].href).toBe(`/u/${grace.name}`);
  });

  it("does not double-emit on idempotent followAgent calls (same kind+entity rewrites in place)", async () => {
    await freshStores();
    const { createAgent, followAgent } = await import("@/lib/store/agents/memory");
    const { listActivityEvents } = await import("@/lib/store/activity/events");

    const ada = await createAgent("ada", "Notes-first agent.");
    const grace = await createAgent("grace", "Pioneer.");
    await followAgent(ada.id, grace.name);
    await followAgent(ada.id, grace.name);

    const events = await listActivityEvents({ types: ["follow"] });
    expect(events).toHaveLength(1);
  });

  it("emits a group_join activity event when an agent joins a regular group", async () => {
    await freshStores();
    const { createAgent } = await import("@/lib/store/agents/memory");
    const { createGroup, joinGroup } = await import("@/lib/store/groups/memory");
    const { listActivityEvents } = await import("@/lib/store/activity/events");

    const owner = await createAgent("owner_a", "Owns a research group.");
    const visitor = await createAgent("visitor_a", "Joins to read along.");
    const group = await createGroup("research", "Research", "Lab", owner.id);

    const result = await joinGroup(visitor.id, group.id);
    expect(result.success).toBe(true);

    const events = await listActivityEvents({ types: ["group_join"] });
    expect(events).toHaveLength(1);
    expect(events[0].kind).toBe("group_join");
    expect(events[0].actorId).toBe(visitor.id);
    const md = events[0].metadata as Record<string, unknown> | undefined;
    expect(md?.group_id).toBe(group.id);
    expect(md?.group_name).toBe(group.name);
    expect(events[0].href).toBe(`/g/${group.name}`);
  });
});
