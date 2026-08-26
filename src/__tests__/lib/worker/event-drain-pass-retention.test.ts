/**
 * M11-2 u6 stitch item 4 — the wakeup queue's retention duty is WIRED INTO THE SHARED DRAIN PASS.
 *
 * The store primitive is tested in `src/__tests__/lib/store/wakeups/claim.test.ts`. What this file
 * pins is the thing that makes the policy real in the supported Vercel-only topology: the duty runs
 * from `runEventDrainPass`'s hourly block, which BOTH `internal/events-drain` (cron) and the worker's
 * fast loop drive. Wired only into the worker's own timer, the cron-only deployment would accumulate
 * completed wakeups forever — the same gap the ledger prune sits here to close.
 *
 * The store is mocked wholesale: the orchestration is what is under test, not any writer's SQL.
 *
 * @jest-environment node
 */
const calls: { pruneTerminalWakeups: unknown[][] } = { pruneTerminalWakeups: [] };
let hourlyDue = true;

jest.mock("@/lib/store", () => ({
  activateEventConsumer: jest.fn(async () => {}),
  beginEventDrainHeartbeat: jest.fn(async () => {}),
  claimHourlyEventDuties: jest.fn(async () => hourlyDue),
  drainEventConsumer: jest.fn(async () => ({ processed: 0, receipted: 0, failed: 0, deadLettered: 0 })),
  eventDrainPhaseBudgetMs: jest.fn(() => 60_000),
  pruneEventLedgers: jest.fn(async () => ({
    events: 0,
    receipts: 0,
    shadowRows: 0,
    failures: 0,
    deadLetters: 0,
    ingestProgress: 0,
    orphanedFailures: 0,
  })),
  pruneTerminalWakeups: jest.fn(async (...args: unknown[]) => {
    calls.pruneTerminalWakeups.push(args);
    return 7;
  }),
  recordEventDrainHeartbeat: jest.fn(async () => {}),
  sweepEventConsumer: jest.fn(async () => ({ processed: 0, receipted: 0, failed: 0, deadLettered: 0 })),
}));
jest.mock("@/lib/admissions", () => ({ runAdmissionsExpiryDuty: jest.fn(async () => {}) }));
jest.mock("@/lib/agent-pulse/runner", () => ({
  runPulseMaintenance: jest.fn(async () => ({ abandoned: 0, autonomyDisabled: 0 })),
}));
jest.mock("@/lib/events/consumers/registry", () => ({ eventConsumers: [] }));

import { runEventDrainPass } from "@/lib/worker/event-drain-pass";

const ORIGINAL = process.env.WAKEUP_RETENTION_DAYS;

beforeEach(() => {
  calls.pruneTerminalWakeups = [];
  hourlyDue = true;
  delete process.env.WAKEUP_RETENTION_DAYS;
});

afterAll(() => {
  if (ORIGINAL === undefined) delete process.env.WAKEUP_RETENTION_DAYS;
  else process.env.WAKEUP_RETENTION_DAYS = ORIGINAL;
});

describe("runEventDrainPass — wakeup retention", () => {
  it("prunes completed wakeups on the hourly duty, at the 30-day default, and reports the count", async () => {
    const result = await runEventDrainPass("test-worker");

    expect(calls.pruneTerminalWakeups).toEqual([[30, 1000]]);
    expect(result.hourlyRan).toBe(true);
    expect(result.hourly?.prunedWakeups).toBe(7);
  });

  it("honours WAKEUP_RETENTION_DAYS, and ignores a value that is not a positive number", async () => {
    process.env.WAKEUP_RETENTION_DAYS = "7";
    await runEventDrainPass("test-worker");
    expect(calls.pruneTerminalWakeups[0][0]).toBe(7);

    calls.pruneTerminalWakeups = [];
    process.env.WAKEUP_RETENTION_DAYS = "not-a-number";
    await runEventDrainPass("test-worker");
    expect(calls.pruneTerminalWakeups[0][0]).toBe(30);

    calls.pruneTerminalWakeups = [];
    process.env.WAKEUP_RETENTION_DAYS = "0";
    await runEventDrainPass("test-worker");
    expect(calls.pruneTerminalWakeups[0][0]).toBe(30);
  });

  it("does not prune on a pass whose hourly duties were not claimed", async () => {
    hourlyDue = false;
    const result = await runEventDrainPass("test-worker");

    expect(calls.pruneTerminalWakeups).toEqual([]);
    expect(result.hourlyRan).toBe(false);
    expect(result.hourly).toBeNull();
  });
});
