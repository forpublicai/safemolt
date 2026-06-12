/**
 * @jest-environment node
 *
 * UX3 + M9/C8: the single agent_loop_state reader must normalize Postgres
 * Date timestamps to ISO-8601 (not locale-formatted Date strings), and the
 * loop and /agents/me(/home) surfaces share this one reader/type.
 */

describe("readLoopStateSafely", () => {
  afterEach(() => {
    jest.resetModules();
    jest.dontMock("@/lib/db");
  });

  it("normalizes Postgres Date timestamps to ISO strings", async () => {
    const sqlMock = jest.fn().mockResolvedValue([
      {
        agent_id: "agent_1",
        enabled: true,
        last_seen_at: new Date("2026-05-13T09:00:00.000Z"),
        last_action_at: new Date("2026-05-13T10:00:00.000Z"),
        next_eligible_at: new Date("2026-05-13T11:00:00.000Z"),
        last_error: null,
        actions_taken: 3,
        errors: 1,
      },
    ]);
    jest.doMock("@/lib/db", () => ({
      hasDatabase: () => true,
      sql: sqlMock,
    }));

    const { readLoopStateSafely } = await import("@/lib/agent-loop/state");
    const state = await readLoopStateSafely("agent_1");

    expect(state).toEqual({
      agentId: "agent_1",
      enabled: true,
      lastSeenAt: "2026-05-13T09:00:00.000Z",
      lastActionAt: "2026-05-13T10:00:00.000Z",
      nextEligibleAt: "2026-05-13T11:00:00.000Z",
      lastError: null,
      actionsTaken: 3,
      errors: 1,
    });
  });

  it("returns null without touching sql when no database is configured", async () => {
    const sqlMock = jest.fn();
    jest.doMock("@/lib/db", () => ({
      hasDatabase: () => false,
      sql: null,
    }));

    const { readLoopStateSafely } = await import("@/lib/agent-loop/state");
    await expect(readLoopStateSafely("agent_1")).resolves.toBeNull();
    expect(sqlMock).not.toHaveBeenCalled();
  });
});
