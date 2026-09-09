/**
 * M11b Lane W (P5.1) round 2 F8(a)/F8(d) — `runWebhookDeliveryPass` against the memory store.
 *
 * (a) A claim whose registration is disabled makes NO request through `deliverWakeup` and
 * terminalizes the row instead (`attemptOne`'s own defense against sending after auto-disable).
 * (b) The payload actually sent to `deliverWakeup` carries only ids + `context_href` at the top
 * level — the wakeup's own payload rides nested under `subject`, never spread into it.
 *
 * `deliverWakeup` is mocked; everything else runs through the real memory store facade.
 *
 * @jest-environment node
 */
import {
  createAgent,
  enqueueWakeup,
  recordWebhookAttempt,
  upsertAgentWebhook,
} from "@/lib/store";
import { agentWebhooks, resetWakeupState, resetWebhookState, webhookDeliveries } from "@/lib/store/_memory-state";
import { deliverWakeup } from "@/lib/webhooks/deliver";
import { runWebhookDeliveryPass } from "@/lib/worker/webhook-pass";

jest.mock("@/lib/webhooks/deliver", () => ({ deliverWakeup: jest.fn() }));
const mockDeliver = deliverWakeup as jest.MockedFunction<typeof deliverWakeup>;

let seq = 0;
const nextId = (label: string) => `wp_${label}_${Date.now().toString(36)}_${(seq += 1)}`;

beforeEach(() => {
  resetWakeupState();
  resetWebhookState();
  mockDeliver.mockReset();
});

async function seedAgent(label: string) {
  return createAgent(nextId(label), "webhook-pass fixture");
}

function ledgerFor(wakeupId: number) {
  for (const row of webhookDeliveries.rows.values()) {
    if (row.wakeupId === wakeupId) return row;
  }
  throw new Error(`fixture: expected a ledger row for wakeup ${wakeupId}`);
}

describe("runWebhookDeliveryPass — F8(a): a disabled registration makes no request", () => {
  it("terminalizes a reclaimed row for a since-disabled registration without calling deliverWakeup", async () => {
    const agent = await seedAgent("disabled");
    await upsertAgentWebhook({ agentId: agent.id, url: "https://example.com/hook", secret: "s", mode: "primary" });

    const rowA = await enqueueWakeup({ agentId: agent.id, reason: "wp-a", eventId: null, payload: {}, delivery: "webhook" });
    const rowB = await enqueueWakeup({ agentId: agent.id, reason: "wp-b", eventId: null, payload: {}, delivery: "webhook" });
    if (!rowA.wakeup || !rowB.wakeup) throw new Error("fixture: expected fresh rows");

    // A is given a LIVE claim before B's exhaustion disables the registration — the disable
    // sweep must skip a live claim, leaving A nonterminal until its lease later expires.
    const ledgerA = ledgerFor(rowA.wakeup.id);
    ledgerA.claimedAt = new Date().toISOString();
    ledgerA.claimToken = "wp-live-a";
    ledgerA.leaseExpiresAt = new Date(Date.now() + 60_000).toISOString();

    agentWebhooks.get(agent.id)!.failureCount = 9;
    const ledgerB = ledgerFor(rowB.wakeup.id);
    ledgerB.claimedAt = new Date().toISOString();
    ledgerB.claimToken = "wp-b-tok";
    ledgerB.leaseExpiresAt = new Date(Date.now() + 60_000).toISOString();
    const outcome = await recordWebhookAttempt({ id: ledgerB.id, claimToken: "wp-b-tok", status: 500, ok: false });
    expect(outcome).toBe("disabled");

    // A's lease now expires (its worker crashed) — a fresh claim reclaims it while disabled.
    ledgerA.leaseExpiresAt = new Date(Date.now() - 1_000).toISOString();

    const result = await runWebhookDeliveryPass();

    expect(mockDeliver).not.toHaveBeenCalled();
    expect(result.claimed).toBeGreaterThan(0);
    expect(ledgerFor(rowA.wakeup.id).terminalReason).toBe("webhook_disabled");
  });
});

describe("runWebhookDeliveryPass — F3 round 3: subject is an ALLOWLIST of ids, never content", () => {
  it("drops title/content anywhere in the outbound body and keeps only allowlisted ids", async () => {
    const agent = await seedAgent("payload");
    await upsertAgentWebhook({ agentId: agent.id, url: "https://example.com/hook", secret: "s", mode: "primary" });
    mockDeliver.mockResolvedValue({ ok: true, status: 200 });

    const enq = await enqueueWakeup({
      agentId: agent.id,
      reason: "wp-payload",
      eventId: 42,
      payload: { title: "should not leak", content: "should not leak either", post_id: "p_1", group_id: "g_1" },
      delivery: "webhook",
    });
    if (!enq.wakeup) throw new Error("fixture: expected a fresh wakeup row");

    const result = await runWebhookDeliveryPass();

    expect(result.delivered).toBe(1);
    expect(mockDeliver).toHaveBeenCalledTimes(1);
    const sentPayload = mockDeliver.mock.calls[0][0].payload as Record<string, unknown>;

    expect(Object.keys(sentPayload).sort()).toEqual(["context_href", "event_id", "reason", "subject", "wakeup_id"]);
    // Checked at any depth, not just the top level — a nested leak under `subject` is the exact bug F3 closes.
    expect(JSON.stringify(sentPayload)).not.toContain("should not leak");
    expect(sentPayload.subject).toEqual({ post_id: "p_1", group_id: "g_1" });
  });
});
