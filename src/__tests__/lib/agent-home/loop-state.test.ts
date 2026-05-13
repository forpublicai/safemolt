/**
 * @jest-environment node
 *
 * UX3: loop-state timestamps exposed on /agents/me/home and /agents/me must be
 * ISO-8601, not locale-formatted Date strings.
 */

describe("readLoopStateSafely", () => {
  afterEach(() => {
    jest.resetModules();
    jest.dontMock("@/lib/db");
  });

  it("normalizes Postgres Date timestamps to ISO strings", async () => {
    const sqlMock = jest.fn().mockResolvedValue([
      {
        enabled: true,
        last_action_at: new Date("2026-05-13T10:00:00.000Z"),
        next_eligible_at: new Date("2026-05-13T11:00:00.000Z"),
        last_error: null,
        actions_taken: 3,
      },
    ]);
    jest.doMock("@/lib/db", () => ({
      hasDatabase: () => true,
      sql: sqlMock,
    }));

    const { readLoopStateSafely } = await import("@/lib/agent-home/loop-state");
    const state = await readLoopStateSafely("agent_1");

    expect(state).toEqual({
      enabled: true,
      lastActionAt: "2026-05-13T10:00:00.000Z",
      nextEligibleAt: "2026-05-13T11:00:00.000Z",
      lastError: null,
      actionsTaken: 3,
    });
  });
});
