/**
 * M11b Lane W (P5.1) round 2 F9 — the drain pass's EMBEDDED webhook pass takes the same shutdown
 * signal the worker's dedicated webhook duty already had. Before this fix, an active drain kept
 * claiming and sending webhook requests after SIGTERM, because `runEventDrainPass` called
 * `runWebhookDeliveryPass()` with no `shouldStop` at all.
 *
 * The store and `runWebhookDeliveryPass` are mocked wholesale: what is under test is that the
 * caller's `shouldStop` reaches the webhook pass, not any writer's SQL.
 *
 * @jest-environment node
 */
const passCalls: unknown[] = [];

jest.mock("@/lib/store", () => ({
  activateEventConsumer: jest.fn(async () => {}),
  beginEventDrainHeartbeat: jest.fn(async () => {}),
  claimHourlyEventDuties: jest.fn(async () => false),
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
  pruneTerminalWakeups: jest.fn(async () => 0),
  recordEventDrainHeartbeat: jest.fn(async () => {}),
  sweepEventConsumer: jest.fn(async () => ({ processed: 0, receipted: 0, failed: 0, deadLettered: 0 })),
}));
jest.mock("@/lib/admissions", () => ({ runAdmissionsExpiryDuty: jest.fn(async () => {}) }));
jest.mock("@/lib/agent-pulse/runner", () => ({
  runPulseMaintenance: jest.fn(async () => ({ abandoned: 0, autonomyDisabled: 0 })),
}));
jest.mock("@/lib/events/consumers/registry", () => ({ eventConsumers: [] }));
jest.mock("@/lib/worker/webhook-pass", () => ({
  runWebhookDeliveryPass: jest.fn(async (...args: unknown[]) => {
    passCalls.push(args);
    return { claimed: 0, delivered: 0, failed: 0 };
  }),
}));

import { runEventDrainPass } from "@/lib/worker/event-drain-pass";

beforeEach(() => {
  passCalls.length = 0;
});

describe("runEventDrainPass — F9: forwards shouldStop to the embedded webhook pass", () => {
  it("passes the caller's shouldStop through, unchanged", async () => {
    const shouldStop = () => true;
    await runEventDrainPass("test-worker", shouldStop);

    expect(passCalls).toEqual([[shouldStop]]);
  });

  it("passes undefined when the caller (a cron-only invocation) gives no signal", async () => {
    await runEventDrainPass("test-worker");

    expect(passCalls).toEqual([[undefined]]);
  });
});
