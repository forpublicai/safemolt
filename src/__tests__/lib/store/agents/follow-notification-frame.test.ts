/**
 * M11b Lane S gap fix — memory-mode `agent.followed` notifications must carry an SSE stream frame.
 *
 * The db side frames a follow inside `buildFollowNotificationCte`, spliced into `followAgent`'s own
 * decisive statement. Memory mode has no separate decisive-statement splice: `followAgent`'s call to
 * `createFollowNotificationIdempotent` IS the only writer, so it must frame there or never at all.
 * A re-follow must still write nothing and frame nothing — `followAgent`'s own membership gate
 * already refuses before the notification call runs, so nothing extra is needed to prove the gate.
 */
jest.mock("@/lib/db", () => ({
  hasDatabase: () => false,
  sql: null,
}));

describe("follow notification stream frame (memory)", () => {
  beforeEach(() => {
    jest.resetModules();
  });

  async function freshStores() {
    const memory = await import("@/lib/store/_memory-state");
    memory.agents.clear();
    memory.apiKeyToAgentId.clear();
    memory.claimTokenToAgentId.clear();
    memory.following.clear();
    memory.notifications.clear();
    memory.notificationDedupKeys.clear();
    memory.resetStreamFramesState();
    return memory;
  }

  it("records one notification frame for a real follow, and none for a re-follow", async () => {
    const memory = await freshStores();
    const { createAgent, followAgent } = await import("@/lib/store/agents/memory");

    const ada = await createAgent("ada", "Curious about new agents.");
    const grace = await createAgent("grace", "Computing pioneer.");

    const ok = await followAgent(ada.id, grace.name);
    expect(ok).toBe(true);

    const frames = Array.from(memory.streamFrames.rows.values());
    expect(frames).toHaveLength(1);
    expect(frames[0]).toMatchObject({ agentId: grace.id, frame: "notification" });
    // No prepared events were passed to this call, so the dedup key is null and the frame key falls
    // back to the notification's own id (`notificationFrameCte`'s documented fallback) — this test
    // only needs to prove a frame was written at all, not which key shape it took.
    expect(String(frames[0].frameKey)).toMatch(/^notification:/);

    // A re-follow writes nothing and emits nothing (followAgent's own membership gate) — so it
    // must not add a second frame either.
    const again = await followAgent(ada.id, grace.name);
    expect(again).toBe(true);
    expect(memory.streamFrames.rows.size).toBe(1);
  });
});
