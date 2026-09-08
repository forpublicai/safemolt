import { randomUUID } from "node:crypto";
import { claimNextWebhookDelivery, recordWebhookAttempt } from "@/lib/store";
import { deliverWakeup } from "@/lib/webhooks/deliver";
import type { ShouldStop } from "@/lib/worker/stop-signal";

/**
 * M11b Lane W (P5.1) — claim → deliver → record, one delivery at a time, bounded per pass so a
 * degraded (cron-only) invocation stays bounded even under a permanent backlog.
 */

const DEFAULT_BATCH = 20;
const LEASE_MS = 30_000;

function batchSize(): number {
  const raw = Number(process.env.WEBHOOK_DELIVERY_BATCH ?? DEFAULT_BATCH);
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : DEFAULT_BATCH;
}

export interface WebhookDeliveryPassResult {
  claimed: number;
  delivered: number;
  failed: number;
}

type AttemptOutcome = "empty" | "delivered" | "failed";

/**
 * A claimed row with no live registration (deleted between enqueue and claim) has nothing to
 * deliver to; record it as a failed attempt so the store's own fenced update terminalizes it
 * (`gone`/`disabled`) rather than rescheduling forever. F1: a `disabledAt` registration is the same
 * case — never send another HTTP request after auto-disable, let the fenced update terminalize it.
 */
async function attemptOne(): Promise<AttemptOutcome> {
  const claimed = await claimNextWebhookDelivery({ claimToken: randomUUID(), leaseMs: LEASE_MS });
  if (!claimed) return "empty";
  if (claimed.url === null || claimed.secret === null || claimed.disabledAt !== null) {
    await recordWebhookAttempt({ id: claimed.id, claimToken: claimed.claimToken, agentId: claimed.agentId, status: null, ok: false });
    return "failed";
  }
  const result = await deliverWakeup({
    url: claimed.url,
    secret: claimed.secret,
    wakeupId: claimed.wakeupId,
    eventId: claimed.eventId,
    payload: {
      reason: claimed.reason,
      wakeup_id: claimed.wakeupId,
      ...(claimed.eventId !== null ? { event_id: claimed.eventId } : {}),
      subject: claimed.payload,
      context_href: "/",
    },
  });
  await recordWebhookAttempt({
    id: claimed.id,
    claimToken: claimed.claimToken,
    agentId: claimed.agentId,
    status: result.status,
    ok: result.ok,
  });
  return result.ok ? "delivered" : "failed";
}

/** Re-checks `shouldStop` before EVERY claim, mirroring `claimAndRunWakeups`'s loop idiom. */
export async function runWebhookDeliveryPass(shouldStop: ShouldStop = () => false): Promise<WebhookDeliveryPassResult> {
  const counts: WebhookDeliveryPassResult = { claimed: 0, delivered: 0, failed: 0 };
  const limit = batchSize();
  for (let i = 0; i < limit; i++) {
    if (shouldStop()) break;
    const outcome = await attemptOne();
    if (outcome === "empty") break;
    counts.claimed += 1;
    if (outcome === "delivered") counts.delivered += 1;
    else counts.failed += 1;
  }
  return counts;
}
