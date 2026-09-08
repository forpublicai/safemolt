/**
 * M11b Lane W (P5.1) — memory-mode webhook store gates: register/rotate/delete, ledger creation on
 * enqueue (webhook-primary and `mode='both'`), attempt bookkeeping/backoff/exhaustion, the disable-
 * at-10 -> `webhook.disabled` -> `webhook_disabled` notification path, and delete/disable
 * disposition of in-flight vs. unclaimed ledger rows.
 *
 * Facade-only for production calls (`@/lib/store`), per the lane spec; `_memory-state` and the
 * notifications memory module are reached into directly only for setup/reset and for reading state
 * that has no store-level getter (the ledger rows themselves).
 *
 * @jest-environment node
 */
import {
  claimNextWebhookDelivery,
  createAgent,
  deleteAgentWebhook,
  enqueueWakeup,
  getAgentWebhook,
  listNotifications,
  recordWebhookAttempt,
  resolveWakeupDelivery,
  upsertAgentWebhook,
} from "@/lib/store";
import {
  agentLoopState,
  agentWebhooks,
  eventLog,
  resetAgentLoopState,
  resetWakeupState,
  resetWebhookState,
  wakeupQueue,
  webhookDeliveries,
} from "@/lib/store/_memory-state";
import { __resetNotificationsForTests } from "@/lib/store/notifications/memory";

let seq = 0;
const nextId = (label: string) => `w_${label}_${Date.now().toString(36)}_${(seq += 1)}`;

beforeEach(() => {
  resetWakeupState();
  resetWebhookState();
  resetAgentLoopState();
  __resetNotificationsForTests();
  eventLog.rows.length = 0;
  eventLog.nextId = 1;
});

async function seedAgent(label: string) {
  return createAgent(nextId(label), "webhook test fixture");
}

/** Marks an agent's loop enabled — the store has no facade setter; the memory map is the setup seam. */
function enableLoop(agentId: string): void {
  agentLoopState.set(agentId, {
    agentId,
    enabled: true,
    lastSeenAt: null,
    lastActionAt: null,
    nextEligibleAt: null,
    lastError: null,
    actionsTaken: 0,
    errors: 0,
  });
}

/** Test fixtures always enqueue for an agent that has a real channel — a `null` means a bad fixture. */
async function resolvedDelivery(agentId: string): Promise<"internal" | "webhook"> {
  const delivery = await resolveWakeupDelivery(agentId);
  if (delivery === null) throw new Error("fixture: agent has no resolvable delivery channel");
  return delivery;
}

async function enqueueForAgent(agentId: string, reason = "test-wakeup") {
  const delivery = await resolvedDelivery(agentId);
  const result = await enqueueWakeup({ agentId, reason, eventId: null, payload: { source: "test" }, delivery });
  if (!result.created || !result.wakeup) throw new Error("fixture: enqueue did not create a row");
  return result.wakeup;
}

/** No store-level getter exists for one ledger row by wakeup id — the map is the honest way to read it. */
function ledgerFor(wakeupId: number) {
  for (const row of webhookDeliveries.rows.values()) {
    if (row.wakeupId === wakeupId) return row;
  }
  return undefined;
}

describe("register / rotate / delete", () => {
  it("round-trips a registration", async () => {
    const agent = await seedAgent("reg");
    const created = await upsertAgentWebhook({
      agentId: agent.id,
      url: "https://a.example/hook",
      secret: "s1",
      mode: "primary",
    });
    expect(created).toMatchObject({
      agentId: agent.id,
      url: "https://a.example/hook",
      secret: "s1",
      mode: "primary",
      disabledAt: null,
      failureCount: 0,
    });
    expect(await getAgentWebhook(agent.id)).toMatchObject({ url: "https://a.example/hook", secret: "s1" });
  });

  it("a re-POST rotates url/secret/mode and clears a prior disable", async () => {
    const agent = await seedAgent("rot");
    await upsertAgentWebhook({ agentId: agent.id, url: "https://a.example/hook", secret: "s1", mode: "primary" });
    // Seed the disabled state 10 failures would have produced, directly — no need to loop.
    const row = agentWebhooks.get(agent.id)!;
    row.disabledAt = new Date().toISOString();
    row.failureCount = 10;

    const rotated = await upsertAgentWebhook({
      agentId: agent.id,
      url: "https://b.example/hook",
      secret: "s2",
      mode: "both",
    });
    expect(rotated).toMatchObject({ url: "https://b.example/hook", secret: "s2", mode: "both" });
    expect(rotated.disabledAt).toBeNull();
    expect(rotated.failureCount).toBe(0);
  });

  it("deletes a registration; a second delete on a non-existent one is a no-op", async () => {
    const agent = await seedAgent("del");
    await upsertAgentWebhook({ agentId: agent.id, url: "https://a.example/hook", secret: "s1", mode: "primary" });

    expect(await deleteAgentWebhook(agent.id)).toEqual({ deleted: true });
    expect(await getAgentWebhook(agent.id)).toBeNull();
    expect(await deleteAgentWebhook(agent.id)).toEqual({ deleted: false });
  });
});

describe("enqueue creates a webhook delivery ledger", () => {
  it("webhook-primary (no loop, live registration): enqueue creates a ledger row", async () => {
    const agent = await seedAgent("wprime");
    await upsertAgentWebhook({ agentId: agent.id, url: "https://a.example/hook", secret: "s", mode: "primary" });
    expect(await resolveWakeupDelivery(agent.id)).toBe("webhook");

    const wakeup = await enqueueForAgent(agent.id);
    expect(wakeup.delivery).toBe("webhook");
    const ledger = ledgerFor(wakeup.id);
    expect(ledger).toBeDefined();
    expect(ledger).toMatchObject({ agentId: agent.id, attempts: 0, terminalReason: null });
  });

  it("mode='both' on a loop-enabled agent (internal-primary wakeup) still creates a ledger row", async () => {
    const agent = await seedAgent("wboth");
    enableLoop(agent.id);
    await upsertAgentWebhook({ agentId: agent.id, url: "https://a.example/hook", secret: "s", mode: "both" });
    expect(await resolveWakeupDelivery(agent.id)).toBe("internal");

    const wakeup = await enqueueForAgent(agent.id);
    expect(wakeup.delivery).toBe("internal");
    expect(ledgerFor(wakeup.id)).toMatchObject({ agentId: agent.id, terminalReason: null });
  });
});

describe("attempt bookkeeping — backoff then exhaustion", () => {
  afterEach(() => {
    jest.useRealTimers();
  });

  it("retries at 1m then 10m, and exhausts on the third failure", async () => {
    const agent = await seedAgent("bk");
    await upsertAgentWebhook({ agentId: agent.id, url: "https://a.example/hook", secret: "s", mode: "primary" });
    const wakeup = await enqueueForAgent(agent.id);

    jest.useFakeTimers();

    let claim = await claimNextWebhookDelivery({ claimToken: "t1", leaseMs: 60_000 });
    expect(claim?.wakeupId).toBe(wakeup.id);
    let before = Date.now();
    let outcome = await recordWebhookAttempt({ id: claim!.id, claimToken: "t1", agentId: agent.id, status: 500, ok: false });
    expect(outcome).toBe("retry");
    let ledger = ledgerFor(wakeup.id)!;
    expect(Date.parse(ledger.nextAttemptAt)).toBe(before + 60_000);
    expect(ledger.claimedAt).toBeNull(); // a retry releases the claim

    jest.advanceTimersByTime(60_001);
    claim = await claimNextWebhookDelivery({ claimToken: "t2", leaseMs: 60_000 });
    expect(claim?.id).toBe(ledger.id);
    before = Date.now();
    outcome = await recordWebhookAttempt({ id: claim!.id, claimToken: "t2", agentId: agent.id, status: 500, ok: false });
    expect(outcome).toBe("retry");
    ledger = ledgerFor(wakeup.id)!;
    expect(Date.parse(ledger.nextAttemptAt)).toBe(before + 600_000);

    jest.advanceTimersByTime(600_001);
    claim = await claimNextWebhookDelivery({ claimToken: "t3", leaseMs: 60_000 });
    outcome = await recordWebhookAttempt({ id: claim!.id, claimToken: "t3", agentId: agent.id, status: 500, ok: false });
    expect(outcome).toBe("exhausted");
    ledger = ledgerFor(wakeup.id)!;
    expect(ledger.terminalReason).toBe("exhausted");
    const completedWakeup = wakeupQueue.rows.get(wakeup.id)!;
    expect(completedWakeup.completedAt).not.toBeNull();
    expect(completedWakeup.result).toBe("exhausted");
  });
});

describe("disable at 10 failures emits webhook.disabled -> webhook_disabled notification", () => {
  it("the 10th failure disables the registration and the notification appears", async () => {
    const agent = await seedAgent("dis");
    await upsertAgentWebhook({ agentId: agent.id, url: "https://a.example/hook", secret: "s", mode: "primary" });
    // Seed 9 prior failures directly — avoids looping 10 real claim/record cycles.
    agentWebhooks.get(agent.id)!.failureCount = 9;
    const wakeup = await enqueueForAgent(agent.id);

    const claim = await claimNextWebhookDelivery({ claimToken: "t1", leaseMs: 60_000 });
    const outcome = await recordWebhookAttempt({
      id: claim!.id,
      claimToken: "t1",
      agentId: agent.id,
      status: 500,
      ok: false,
    });
    expect(outcome).toBe("retry"); // this delivery's own attempt count is still below 3

    const registration = await getAgentWebhook(agent.id);
    expect(registration?.disabledAt).not.toBeNull();
    expect(registration?.failureCount).toBe(10);

    const notifications = await listNotifications(agent.id);
    expect(notifications.some((n) => n.type === "webhook_disabled")).toBe(true);
    void wakeup; // enqueued only to give the attempt something to claim
  });
});

describe("delete/disable disposition of ledger rows", () => {
  it("terminalizes the unclaimed row, leaves the claimed row alone until it self-terminalizes", async () => {
    const agent = await seedAgent("disp");
    await upsertAgentWebhook({ agentId: agent.id, url: "https://a.example/hook", secret: "s", mode: "primary" });
    const rowA = await enqueueForAgent(agent.id, "wh-a");
    const rowB = await enqueueForAgent(agent.id, "wh-b");

    // The claim picks whichever is due first; either is fine — what matters is that exactly one
    // of the two is claimed and the other stays unclaimed.
    const claim = await claimNextWebhookDelivery({ claimToken: "hold", leaseMs: 300_000 });
    const claimedWakeup = claim!.wakeupId === rowA.id ? rowA : rowB;
    const unclaimedWakeup = claim!.wakeupId === rowA.id ? rowB : rowA;

    await deleteAgentWebhook(agent.id);

    const unclaimedLedger = ledgerFor(unclaimedWakeup.id)!;
    expect(unclaimedLedger.terminalReason).toBe("webhook_removed");
    const unclaimedWakeupRow = wakeupQueue.rows.get(unclaimedWakeup.id)!;
    expect(unclaimedWakeupRow.completedAt).not.toBeNull();
    expect(unclaimedWakeupRow.result).toBe("webhook_removed");

    const claimedLedger = ledgerFor(claimedWakeup.id)!;
    expect(claimedLedger.terminalReason).toBeNull();
    expect(claimedLedger.claimToken).toBe("hold");

    // The in-flight attempt finishes on its own; the fenced update finds the registration gone.
    const outcome = await recordWebhookAttempt({
      id: claimedLedger.id,
      claimToken: "hold",
      agentId: agent.id,
      status: null,
      ok: false,
    });
    expect(outcome).toBe("gone");
    expect(ledgerFor(claimedWakeup.id)!.terminalReason).toBe("webhook_removed");
    expect(wakeupQueue.rows.get(claimedWakeup.id)!.result).toBe("webhook_removed");
  });
});

describe("mode='both' ledgers leave the internal-primary wakeup alone", () => {
  it("a successful webhook delivery completes only the ledger, not the internal wakeup", async () => {
    const agent = await seedAgent("bothok");
    enableLoop(agent.id);
    await upsertAgentWebhook({ agentId: agent.id, url: "https://a.example/hook", secret: "s", mode: "both" });
    const wakeup = await enqueueForAgent(agent.id);
    expect(wakeup.delivery).toBe("internal");

    const claim = await claimNextWebhookDelivery({ claimToken: "t1", leaseMs: 60_000 });
    expect(claim?.wakeupId).toBe(wakeup.id);
    const outcome = await recordWebhookAttempt({
      id: claim!.id,
      claimToken: "t1",
      agentId: agent.id,
      status: 200,
      ok: true,
    });

    expect(outcome).toBe("success");
    expect(ledgerFor(wakeup.id)!.terminalReason).toBe("delivered");
    // The tick, not this delivery, owns an internal-primary wakeup's completion.
    expect(wakeupQueue.rows.get(wakeup.id)!.completedAt).toBeNull();
  });
});
