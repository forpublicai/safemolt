import type { PreparedEvent } from "@/lib/events/kinds";
import { agents, agentWebhooks, wakeupQueue, webhookDeliveries } from "../_memory-state";
import { appendPreparedBatch, prepareEventBatch, validatePreparedEvents } from "../events/memory";
import type {
  ClaimedWebhookDelivery,
  ClaimNextWebhookDeliveryInput,
  RecordWebhookAttemptInput,
  RecordWebhookAttemptOutcome,
  StoredAgentWebhook,
  StoredWebhookDelivery,
  UpsertAgentWebhookInput,
} from "./db";

/**
 * M11b Lane W (P5.1) — the memory twin of `store/webhooks/db.ts`. Semantically identical: the same
 * outcome precedence, the same terminal-coupling with the webhook-primary wakeup, the same backoff
 * schedule. "One synchronous section, no `await` between the check and the write" stands in for the
 * db side's row locks, exactly as `wakeups/memory.ts` documents for its own claim/completion twins.
 */

function cloneWebhook(row: StoredAgentWebhook): StoredAgentWebhook {
  return { ...row };
}

/**
 * F7: re-checks the agent right here, immediately before the write — matching
 * `agent_webhooks.agent_id REFERENCES agents(id)`, which the db driver enforces on every insert.
 * The action's own re-check closes the ordinary race; this is the store's own defense so an
 * orphan registration can never be written even if a future caller skips that re-check.
 */
export async function upsertAgentWebhook(input: UpsertAgentWebhookInput): Promise<StoredAgentWebhook> {
  if (!agents.has(input.agentId)) {
    const error = new Error(`agent ${input.agentId} does not exist`) as Error & { code: string; constraint: string };
    error.code = "23503";
    error.constraint = "agent_webhooks_agent_id_fkey";
    throw error;
  }
  const existing = agentWebhooks.get(input.agentId);
  const row: StoredAgentWebhook = {
    agentId: input.agentId,
    url: input.url,
    secret: input.secret,
    mode: input.mode,
    disabledAt: null,
    failureCount: 0,
    // A re-POST rotates the secret and clears the disable state, but `created_at` is set once — the
    // db's `ON CONFLICT DO UPDATE` never names that column, so it survives every rotation.
    createdAt: existing?.createdAt ?? new Date().toISOString(),
  };
  agentWebhooks.set(input.agentId, row);
  return cloneWebhook(row);
}

export async function getAgentWebhook(agentId: string): Promise<StoredAgentWebhook | null> {
  const row = agentWebhooks.get(agentId);
  return row ? cloneWebhook(row) : null;
}

/** A row's claim is still LIVE (unexpired lease) — shared by every "unclaimed-or-expired" sweep below. */
function hasLiveClaim(row: StoredWebhookDelivery, nowMs: number): boolean {
  return row.claimedAt !== null && (row.leaseExpiresAt === null || Date.parse(row.leaseExpiresAt) >= nowMs);
}

/**
 * See `db.ts`: delete the registration, then terminalize every unclaimed-or-lease-expired ledger row
 * whose wakeup is webhook-**primary**, completing that wakeup too — in the same synchronous section,
 * this store's stand-in for "the same statement". F4: a row with a LIVE claim is left for its own
 * attempt to find the registration gone; an expired one has no live claimant to finish it.
 */
export async function deleteAgentWebhook(agentId: string): Promise<{ deleted: boolean }> {
  const existed = agentWebhooks.delete(agentId);
  if (!existed) return { deleted: false };
  const nowMs = Date.now();
  const nowIso = new Date(nowMs).toISOString();
  for (const row of webhookDeliveries.rows.values()) {
    if (row.agentId !== agentId || row.terminalReason !== null || hasLiveClaim(row, nowMs)) continue;
    row.terminalReason = "webhook_removed";
    const wakeup = wakeupQueue.rows.get(row.wakeupId);
    if (wakeup && wakeup.delivery === "webhook" && wakeup.completedAt === null) {
      wakeup.completedAt = nowIso;
      wakeup.result = "webhook_removed";
    }
  }
  return { deleted: true };
}

/**
 * F5: mirrors `agent_webhooks.agent_id`/`webhook_deliveries.agent_id … ON DELETE CASCADE` — an agent
 * withdrawal removes both rows outright, unlike `deleteAgentWebhook`'s business-rule terminalization
 * (a cascade drops rows; it runs no wakeup-completion logic). Called by `agents/memory.ts`'s
 * `deleteAgent` sweep, one helper the way `forgetNotificationsForRecipient` is.
 */
export function forgetWebhooksFor(agentId: string): void {
  agentWebhooks.delete(agentId);
  for (const [id, row] of Array.from(webhookDeliveries.rows.entries())) {
    if (row.agentId === agentId) webhookDeliveries.rows.delete(id);
  }
}

/** A due candidate: nonterminal, (unclaimed OR lease expired), and its backoff clock has elapsed. */
function isClaimable(row: StoredWebhookDelivery, nowMs: number): boolean {
  if (row.terminalReason !== null) return false;
  if (hasLiveClaim(row, nowMs)) return false;
  return Date.parse(row.nextAttemptAt) <= nowMs;
}

/**
 * See `db.ts`'s `claimNextWebhookDelivery`. One synchronous section: the scan, the tiebreak and the
 * claim write happen with no `await` in between — this store's substitute for `FOR UPDATE SKIP
 * LOCKED`. Ties broken by ascending id (memory-only, `claimNextWakeup`'s own precedent: Postgres's own
 * tie order is unspecified, but a deterministic twin needs one for reproducible tests).
 */
export async function claimNextWebhookDelivery(
  input: ClaimNextWebhookDeliveryInput
): Promise<ClaimedWebhookDelivery | null> {
  const nowMs = Date.now();
  const candidates = Array.from(webhookDeliveries.rows.values()).filter((row) => isClaimable(row, nowMs));
  if (candidates.length === 0) return null;
  candidates.sort((a, b) => Date.parse(a.nextAttemptAt) - Date.parse(b.nextAttemptAt) || a.id - b.id);
  const row = candidates[0];

  row.claimedAt = new Date(nowMs).toISOString();
  row.claimToken = input.claimToken;
  row.leaseExpiresAt = new Date(nowMs + input.leaseMs).toISOString();

  const wakeup = wakeupQueue.rows.get(row.wakeupId);
  const registration = agentWebhooks.get(row.agentId);
  return {
    id: row.id,
    wakeupId: row.wakeupId,
    agentId: row.agentId,
    attempts: row.attempts,
    claimToken: row.claimToken,
    reason: wakeup?.reason ?? "",
    eventId: wakeup?.eventId ?? null,
    payload: wakeup?.payload ?? {},
    url: registration?.url ?? null,
    secret: registration?.secret ?? null,
    disabledAt: registration?.disabledAt ?? null,
  };
}

/**
 * `db.ts`'s outcome precedence, transcribed. F1: crossing the failure threshold on THIS attempt
 * reclassifies its own outcome as `disabled` too — checked before the exhaustion/retry branches, so
 * the triggering row terminalizes in the same call rather than waiting for a later attempt.
 */
function classifyAttemptOutcome(
  ok: boolean,
  registration: StoredAgentWebhook | undefined,
  attemptsBefore: number
): RecordWebhookAttemptOutcome {
  if (ok) return "success";
  if (!registration) return "gone";
  if (registration.disabledAt !== null) return "disabled";
  if (registration.failureCount + 1 >= 10) return "disabled";
  if (attemptsBefore + 1 >= 3) return "exhausted";
  return "retry";
}

/** 1m / 10m / 60m, keyed by attempts AFTER this increment — matches the db statement's CASE exactly. */
function backoffMs(attemptsAfter: number): number {
  if (attemptsAfter <= 1) return 60_000;
  if (attemptsAfter === 2) return 600_000;
  return 3_600_000;
}

function terminalReasonFor(outcome: RecordWebhookAttemptOutcome): string {
  if (outcome === "success") return "delivered";
  if (outcome === "gone") return "webhook_removed";
  if (outcome === "disabled") return "webhook_disabled";
  return "exhausted";
}

/**
 * Apply one attempt's outcome to the ledger row, its webhook-primary wakeup and the registration's
 * failure counter — the memory twin of `recordWebhookAttempt`'s single token-fenced statement, done
 * as one synchronous mutation instead.
 *
 * `liveFailure` (not `outcome`) gates the counter bump — matching `db.ts`'s `live_failure`: a failed
 * attempt against a registration that is present and not yet disabled bumps it, whether this attempt
 * itself ends up `retry`, `exhausted`, or (crossing the threshold) `disabled`.
 */
function applyRecordedAttempt(
  row: StoredWebhookDelivery,
  registration: StoredAgentWebhook | undefined,
  outcome: RecordWebhookAttemptOutcome,
  status: number | null,
  liveFailure: boolean,
  willDisable: boolean
): void {
  const nowIso = new Date().toISOString();
  row.attempts += 1;
  row.lastStatus = status;
  row.lastAttemptAt = nowIso;

  if (outcome === "retry") {
    row.nextAttemptAt = new Date(Date.now() + backoffMs(row.attempts)).toISOString();
    row.claimedAt = null;
    row.claimToken = null;
    row.leaseExpiresAt = null;
  } else {
    row.terminalReason = terminalReasonFor(outcome);
    if (outcome === "success") row.deliveredAt = nowIso;
    const wakeup = wakeupQueue.rows.get(row.wakeupId);
    if (wakeup && wakeup.delivery === "webhook" && wakeup.completedAt === null) {
      wakeup.completedAt = nowIso;
      wakeup.result = row.terminalReason;
    }
  }

  if (outcome === "success" && registration) registration.failureCount = 0;
  if (liveFailure && registration) {
    registration.failureCount += 1;
    if (willDisable) registration.disabledAt = nowIso;
  }
}

/**
 * F1's disposition sweep: crossing the threshold terminalizes every OTHER unclaimed-or-expired
 * ledger row of this agent, completing each one's webhook-primary wakeup — the memory twin of
 * `db.ts`'s `disable_sweep`/`disable_sweep_wakeups` CTEs. A `mode='both'` ledger terminalizes without
 * touching its internal wakeup, same rule `deleteAgentWebhook` follows. A row with a still-live claim
 * is left for its own attempt to find the registration disabled.
 */
function sweepDisabledAgentLedgers(agentId: string, triggeringRowId: number, nowMs: number): void {
  const nowIso = new Date(nowMs).toISOString();
  for (const row of webhookDeliveries.rows.values()) {
    if (row.agentId !== agentId || row.id === triggeringRowId) continue;
    if (row.terminalReason !== null || hasLiveClaim(row, nowMs)) continue;
    row.terminalReason = "webhook_disabled";
    const wakeup = wakeupQueue.rows.get(row.wakeupId);
    if (wakeup && wakeup.delivery === "webhook" && wakeup.completedAt === null) {
      wakeup.completedAt = nowIso;
      wakeup.result = "webhook_disabled";
    }
  }
}

function buildWebhookDisabledEvent(agentId: string): PreparedEvent<"webhook.disabled"> {
  return {
    kind: "webhook.disabled",
    actorAgentId: null,
    subjectType: "agent",
    subjectId: agentId,
    payload: { agent_id: agentId },
  };
}

/**
 * See `db.ts`'s doc comment for the full outcome contract. The `webhook.disabled` event is decided
 * (Decision 4's preflight) BEFORE the mutation and appended AFTER it, with nothing awaited in between
 * — the memory discipline every domain that emits events from a synchronous mutation follows.
 */
export async function recordWebhookAttempt(
  input: RecordWebhookAttemptInput
): Promise<RecordWebhookAttemptOutcome> {
  const row = webhookDeliveries.rows.get(input.id);
  if (!row || row.claimToken !== input.claimToken || row.terminalReason !== null) return "not_found";

  const registration = agentWebhooks.get(row.agentId);
  const outcome = classifyAttemptOutcome(input.ok, registration, row.attempts);
  // F1: `liveFailure` mirrors `db.ts`'s own predicate — a failed attempt against a present,
  // not-yet-disabled registration — independent of which terminal outcome this attempt lands on.
  const liveFailure = !input.ok && registration !== undefined && registration.disabledAt === null;
  const willDisable = liveFailure && registration!.failureCount + 1 >= 10;

  const events: PreparedEvent<"webhook.disabled">[] = willDisable ? [buildWebhookDisabledEvent(row.agentId)] : [];
  validatePreparedEvents(events);
  const batch = prepareEventBatch(events);

  const nowMs = Date.now();
  applyRecordedAttempt(row, registration, outcome, input.status, liveFailure, willDisable);
  if (willDisable) sweepDisabledAgentLedgers(row.agentId, row.id, nowMs);

  await appendPreparedBatch(batch).dispatched;
  return outcome;
}
