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

/**
 * M11-2 P0.4 — recordAgentLoopTick, the store write behind the tick-outcome
 * journal (ai/validation/m11-baseline.md section 4).
 */
describe("recordAgentLoopTick", () => {
  afterEach(() => {
    jest.resetModules();
    jest.dontMock("@/lib/db");
  });

  it("inserts one row with the given fields when a database is configured", async () => {
    const sqlMock = jest.fn().mockResolvedValue([]);
    jest.doMock("@/lib/db", () => ({
      hasDatabase: () => true,
      sql: sqlMock,
    }));

    const { recordAgentLoopTick } = await import("@/lib/agent-loop/state");
    await recordAgentLoopTick({
      agentId: "agent_1",
      outcome: "acted",
      inferenceConsumed: true,
      terminalAction: true,
    });

    expect(sqlMock).toHaveBeenCalledTimes(1);
    const [strings, ...values] = sqlMock.mock.calls[0] as [TemplateStringsArray, ...unknown[]];
    expect(strings.join("?")).toContain("agent_loop_tick_log");
    expect(values).toEqual(["agent_1", "acted", true, true]);
  });

  it("is a no-op without touching sql when no database is configured (memory mode is not a meaningful baseline)", async () => {
    const sqlMock = jest.fn();
    jest.doMock("@/lib/db", () => ({
      hasDatabase: () => false,
      sql: null,
    }));

    const { recordAgentLoopTick } = await import("@/lib/agent-loop/state");
    await expect(
      recordAgentLoopTick({ agentId: "agent_1", outcome: "skipped", inferenceConsumed: false, terminalAction: false })
    ).resolves.toBeUndefined();
    expect(sqlMock).not.toHaveBeenCalled();
  });

  it("never throws, even when the insert itself fails", async () => {
    const sqlMock = jest.fn().mockRejectedValue(new Error("connection reset"));
    jest.doMock("@/lib/db", () => ({
      hasDatabase: () => true,
      sql: sqlMock,
    }));
    const consoleError = jest.spyOn(console, "error").mockImplementation(() => undefined);

    const { recordAgentLoopTick } = await import("@/lib/agent-loop/state");
    await expect(
      recordAgentLoopTick({ agentId: "agent_1", outcome: "error", inferenceConsumed: true, terminalAction: false })
    ).resolves.toBeUndefined();
    expect(consoleError).toHaveBeenCalled();

    consoleError.mockRestore();
  });

  it("never throws when hasDatabase itself is missing from the module (a permissive test double, not production shape)", async () => {
    jest.doMock("@/lib/db", () => ({ sql: jest.fn() }));
    const consoleError = jest.spyOn(console, "error").mockImplementation(() => undefined);

    const { recordAgentLoopTick } = await import("@/lib/agent-loop/state");
    await expect(
      recordAgentLoopTick({ agentId: "agent_1", outcome: "error", inferenceConsumed: false, terminalAction: false })
    ).resolves.toBeUndefined();

    consoleError.mockRestore();
  });
});
