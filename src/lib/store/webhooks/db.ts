import { sql } from "@/lib/db";
import { toIsoOrEmpty, toIsoOrNull } from "@/lib/iso-date";
import type { PreparedEvent } from "@/lib/events/kinds";
import { emitEventCtes, sqlColumn, sqlPayloadObject } from "../events/statement";

/**
 * M11b Lane W (P5.1) — the webhook registration and its per-wakeup delivery ledger.
 *
 * Two tables, one domain: `agent_webhooks` (one row per agent) and `webhook_deliveries` (one row
 * per webhook-bearing wakeup, `UNIQUE (wakeup_id)`). Channel state lives on the ledger, never on
 * `agent_wakeups` itself — see `scripts/migrate-m11-webhooks.sql`.
 */

export type WebhookMode = "primary" | "both";

export interface StoredAgentWebhook {
  agentId: string;
  url: string;
  secret: string;
  mode: WebhookMode;
  disabledAt: string | null;
  failureCount: number;
  createdAt: string;
}

export interface UpsertAgentWebhookInput {
  agentId: string;
  url: string;
  secret: string;
  mode: WebhookMode;
}

export interface StoredWebhookDelivery {
  id: number;
  wakeupId: number;
  agentId: string;
  attempts: number;
  lastAttemptAt: string | null;
  deliveredAt: string | null;
  lastStatus: number | null;
  claimedAt: string | null;
  claimToken: string | null;
  leaseExpiresAt: string | null;
  terminalReason: string | null;
  nextAttemptAt: string;
}

interface AgentWebhookRow {
  agent_id: string;
  url: string;
  secret: string;
  mode: string;
  disabled_at: unknown;
  failure_count: number | string;
  created_at: unknown;
}

function rowToAgentWebhook(row: unknown): StoredAgentWebhook {
  const r = row as AgentWebhookRow;
  return {
    agentId: String(r.agent_id),
    url: String(r.url),
    secret: String(r.secret),
    mode: String(r.mode) as WebhookMode,
    disabledAt: toIsoOrNull(r.disabled_at),
    failureCount: Number(r.failure_count),
    createdAt: toIsoOrEmpty(r.created_at),
  };
}

/**
 * Registers or rotates an agent's webhook. `ON CONFLICT` clears `disabled_at`/`failure_count`
 * unconditionally, per P5.1: a re-POST is a fresh start, not a merge.
 */
export async function upsertAgentWebhook(input: UpsertAgentWebhookInput): Promise<StoredAgentWebhook> {
  const rows = await sql!(
    `INSERT INTO agent_webhooks (agent_id, url, secret, mode, disabled_at, failure_count, created_at)
     VALUES ($1, $2, $3, $4, NULL, 0, NOW())
     ON CONFLICT (agent_id) DO UPDATE
       SET url = EXCLUDED.url, secret = EXCLUDED.secret, mode = EXCLUDED.mode,
           disabled_at = NULL, failure_count = 0
     RETURNING *`,
    [input.agentId, input.url, input.secret, input.mode]
  );
  return rowToAgentWebhook(rows[0]);
}

export async function getAgentWebhook(agentId: string): Promise<StoredAgentWebhook | null> {
  const rows = await sql!(`SELECT * FROM agent_webhooks WHERE agent_id = $1`, [agentId]);
  return rows.length > 0 ? rowToAgentWebhook(rows[0]) : null;
}

/**
 * Deletes the registration and, in the SAME statement, terminalizes every UNCLAIMED ledger row for
 * this agent whose wakeup is webhook-**primary** (`agent_wakeups.delivery = 'webhook'`) — completing
 * each such wakeup too (CLAUDE.md's terminal-coupling rule: no committable state may pair a terminal
 * delivery with a nonterminal webhook-primary wakeup).
 *
 * A `mode='both'` ledger's wakeup is `delivery = 'internal'` and is deliberately left untouched — the
 * tick still owns it. A row with a LIVE claim (unexpired lease) is left alone: it finishes its own
 * attempt under its token, and `recordWebhookAttempt`'s fenced update — finding the registration gone
 * — terminalizes it then. F4: a row whose lease already EXPIRED has no live claimant to finish it, so
 * it is swept here too, same as an unclaimed row — otherwise a crashed claimant's row and its wakeup
 * stay nonterminal forever.
 */
export async function deleteAgentWebhook(agentId: string): Promise<{ deleted: boolean }> {
  const rows = await sql!(
    `WITH deleted_reg AS (
       DELETE FROM agent_webhooks WHERE agent_id = $1
       RETURNING agent_id
     ),
     terminalized AS (
       UPDATE webhook_deliveries wd
       SET terminal_reason = 'webhook_removed'
       FROM deleted_reg dr
       WHERE wd.agent_id = dr.agent_id
         AND wd.terminal_reason IS NULL
         AND (wd.claimed_at IS NULL OR wd.lease_expires_at < NOW())
       RETURNING wd.wakeup_id
     ),
     completed_wakeups AS (
       UPDATE agent_wakeups w
       SET completed_at = NOW(), result = 'webhook_removed'
       FROM terminalized t
       WHERE w.id = t.wakeup_id
         AND w.delivery = 'webhook'
         AND w.completed_at IS NULL
       RETURNING w.id
     )
     SELECT (SELECT count(*) FROM deleted_reg)::int AS deleted_count`,
    [agentId]
  );
  const count = Number((rows[0] as { deleted_count?: number } | undefined)?.deleted_count ?? 0);
  return { deleted: count > 0 };
}

export interface ClaimNextWebhookDeliveryInput {
  claimToken: string;
  leaseMs: number;
}

/** What `deliverWakeup` (a later deliverable) needs: the ledger row, the wakeup payload, the secret. */
export interface ClaimedWebhookDelivery {
  id: number;
  wakeupId: number;
  agentId: string;
  attempts: number;
  claimToken: string;
  reason: string;
  eventId: number | null;
  payload: Record<string, unknown>;
  /** Null when the registration was deleted between enqueue and claim — nothing to deliver to. */
  url: string | null;
  secret: string | null;
  disabledAt: string | null;
}

interface ClaimedDeliveryRow {
  id: number | string;
  wakeup_id: number | string;
  agent_id: string;
  attempts: number | string;
  claim_token: string;
  reason: string;
  event_id: number | string | null;
  payload: Record<string, unknown> | null;
  url: string | null;
  secret: string | null;
  disabled_at: unknown;
}

/**
 * `FOR UPDATE SKIP LOCKED` claim, mirroring `claimNextWakeup`'s shape: due = nonterminal AND
 * (unclaimed OR lease expired) AND `next_attempt_at <= NOW()`. `agent_webhooks` is LEFT JOINed — a
 * registration deleted in the instant between eligibility and this claim must not silently swallow
 * an otherwise-claimable row; the caller sees `url: null` and treats it as "nothing to deliver to".
 */
export async function claimNextWebhookDelivery(
  input: ClaimNextWebhookDeliveryInput
): Promise<ClaimedWebhookDelivery | null> {
  const rows = await sql!(
    `WITH cand AS (
       SELECT wd.id
       FROM webhook_deliveries wd
       WHERE wd.terminal_reason IS NULL
         AND (wd.claimed_at IS NULL OR wd.lease_expires_at < NOW())
         AND wd.next_attempt_at <= NOW()
       ORDER BY wd.next_attempt_at
       LIMIT 1
       FOR UPDATE OF wd SKIP LOCKED
     ),
     claimed AS (
       UPDATE webhook_deliveries wd
       SET claimed_at = NOW(), claim_token = $1,
           lease_expires_at = NOW() + make_interval(secs => $2::double precision / 1000.0)
       FROM cand
       WHERE wd.id = cand.id
       RETURNING wd.*
     )
     SELECT c.id, c.wakeup_id, c.agent_id, c.attempts, c.claim_token,
            w.reason, w.event_id, w.payload,
            h.url, h.secret, h.disabled_at
     FROM claimed c
     JOIN agent_wakeups w ON w.id = c.wakeup_id
     LEFT JOIN agent_webhooks h ON h.agent_id = c.agent_id`,
    [input.claimToken, input.leaseMs]
  );
  const row = rows[0] as ClaimedDeliveryRow | undefined;
  if (!row) return null;
  return {
    id: Number(row.id),
    wakeupId: Number(row.wakeup_id),
    agentId: String(row.agent_id),
    attempts: Number(row.attempts),
    claimToken: String(row.claim_token),
    reason: String(row.reason),
    eventId: row.event_id == null ? null : Number(row.event_id),
    payload: row.payload ?? {},
    url: row.url == null ? null : String(row.url),
    secret: row.secret == null ? null : String(row.secret),
    disabledAt: toIsoOrNull(row.disabled_at),
  };
}

export interface RecordWebhookAttemptInput {
  id: number;
  claimToken: string;
  /** Known to the caller from the claim step — carried here rather than re-derived. */
  agentId: string;
  status: number | null;
  ok: boolean;
}

/**
 * `not_found` — the token fence found nothing (already terminal, wrong token, or a stale claim).
 * Every other value is what the ONE token-fenced statement below decided this attempt's outcome was.
 */
export type RecordWebhookAttemptOutcome = "success" | "gone" | "disabled" | "exhausted" | "retry" | "not_found";

/**
 * `webhook.disabled`'s payload/subject — always agent-scoped, always system-driven.
 *
 * F8: `subjectId`/`payload.agent_id` here are placeholders only. The statement overrides both from
 * `disabled_now.agent_id` (the token-fenced row's own agent), never from a caller-supplied argument
 * that could name a different agent than the one the locked row actually disabled.
 */
function buildWebhookDisabledEvent(): PreparedEvent<"webhook.disabled"> {
  return {
    kind: "webhook.disabled",
    actorAgentId: null,
    subjectType: "agent",
    subjectId: null,
    payload: { agent_id: "" },
  };
}

/**
 * ONE token-fenced statement covering the whole outcome of one delivery attempt (CLAUDE.md: "the
 * statement that makes a delivery terminal must complete its webhook-primary wakeup in the SAME
 * token-fenced statement", never a second auto-committed call).
 *
 * Outcome precedence, decided entirely in SQL against one locked snapshot:
 *  - `ok` → `success` (delivered), regardless of registration state — a delivery that happened stays
 *    recorded as delivered even if the registration is disabled a moment later.
 *  - not `ok`, registration gone → `gone`.
 *  - not `ok`, registration disabled → `disabled`.
 *  - not `ok`, live, `attempts+1 >= 3` → `exhausted`.
 *  - not `ok`, live, otherwise → `retry` (backoff, claim released).
 *
 * `success`/`gone`/`disabled`/`exhausted` all complete the webhook-primary wakeup (gated on
 * `agent_wakeups.delivery = 'webhook'` — a `mode='both'` internal-primary wakeup is never touched
 * here). A live failure (not `success`, registration present and not yet disabled) bumps
 * `agent_webhooks.failure_count`; crossing 10 on THIS attempt sets `disabled_at` and reclassifies
 * this very attempt's own outcome as `disabled` too (F1) — the triggering row terminalizes in the
 * SAME statement rather than waiting for a later attempt to notice `disabled_at`.
 *
 * F1's disposition sweep: crossing the threshold also terminalizes every OTHER unclaimed-or-expired
 * ledger row of this agent (`disable_sweep`), completing each one's webhook-primary wakeup
 * (`disable_sweep_wakeups`) — a `mode='both'` ledger terminalizes without touching its internal
 * wakeup, same rule `deleteAgentWebhook` follows. A row with a still-live claim is left for its own
 * attempt to find the registration disabled.
 */
export async function recordWebhookAttempt(
  input: RecordWebhookAttemptInput
): Promise<RecordWebhookAttemptOutcome> {
  const params: unknown[] = [input.id, input.claimToken, input.ok, input.status];
  // Always rendered; the insert's own `WHERE EXISTS (SELECT 1 FROM disabled_now)` gate (built into
  // `emitEventCtes`/`emitEventStatement`) is what makes it a no-op on every attempt that does not
  // cross the threshold — the event is never a JS-side conditional. F8: subject/payload come from
  // `disabled_now.agent_id`, the token-fenced row's own agent — never from `input.agentId`.
  const events: PreparedEvent<"webhook.disabled">[] = [buildWebhookDisabledEvent()];
  const emitted = emitEventCtes(events, "disabled_now", {
    firstParamIndex: params.length + 1,
    overrides: [
      {
        rowSource: "disabled_now",
        columnSql: { subject_id: sqlColumn("disabled_now.agent_id") },
        payloadMergeSql: sqlPayloadObject({ agent_id: sqlColumn("disabled_now.agent_id") }),
      },
    ],
  });
  const rows = await sql!(
    `WITH target AS (
       SELECT wd.id, wd.wakeup_id, wd.agent_id, wd.attempts, w.delivery AS wakeup_delivery
       FROM webhook_deliveries wd
       JOIN agent_wakeups w ON w.id = wd.wakeup_id
       WHERE wd.id = $1::bigint AND wd.claim_token = $2::text AND wd.terminal_reason IS NULL
       FOR UPDATE OF wd
     ),
     reg AS (
       SELECT h.agent_id, h.disabled_at, h.failure_count
       FROM agent_webhooks h
       JOIN target t ON t.agent_id = h.agent_id
       FOR UPDATE OF h
     ),
     outcome AS (
       SELECT
         t.id, t.wakeup_id, t.agent_id, t.attempts, t.wakeup_delivery,
         CASE
           WHEN $3::boolean THEN 'success'
           WHEN r.agent_id IS NULL THEN 'gone'
           WHEN r.disabled_at IS NOT NULL THEN 'disabled'
           WHEN (r.failure_count + 1 >= 10) THEN 'disabled'
           WHEN t.attempts + 1 >= 3 THEN 'exhausted'
           ELSE 'retry'
         END AS outcome,
         (NOT $3::boolean AND r.agent_id IS NOT NULL AND r.disabled_at IS NULL) AS live_failure,
         (r.failure_count + 1 >= 10) AS crosses_threshold
       FROM target t
       LEFT JOIN reg r ON r.agent_id = t.agent_id
     ),
     updated_delivery AS (
       UPDATE webhook_deliveries wd
       SET
         attempts = wd.attempts + 1,
         last_status = $4::int,
         last_attempt_at = NOW(),
         delivered_at = CASE WHEN o.outcome = 'success' THEN NOW() ELSE wd.delivered_at END,
         terminal_reason = CASE
           WHEN o.outcome = 'success' THEN 'delivered'
           WHEN o.outcome = 'gone' THEN 'webhook_removed'
           WHEN o.outcome = 'disabled' THEN 'webhook_disabled'
           WHEN o.outcome = 'exhausted' THEN 'exhausted'
           ELSE NULL
         END,
         next_attempt_at = CASE
           WHEN o.outcome = 'retry' THEN NOW() + (
             CASE WHEN o.attempts + 1 <= 1 THEN interval '1 minute'
                  WHEN o.attempts + 1 = 2 THEN interval '10 minutes'
                  ELSE interval '60 minutes' END
           )
           ELSE wd.next_attempt_at
         END,
         claimed_at = CASE WHEN o.outcome = 'retry' THEN NULL ELSE wd.claimed_at END,
         claim_token = CASE WHEN o.outcome = 'retry' THEN NULL ELSE wd.claim_token END,
         lease_expires_at = CASE WHEN o.outcome = 'retry' THEN NULL ELSE wd.lease_expires_at END
       FROM outcome o
       WHERE wd.id = o.id
       RETURNING wd.id, o.outcome, o.wakeup_id, o.wakeup_delivery, o.agent_id, o.live_failure, o.crosses_threshold
     ),
     completed_wakeup AS (
       UPDATE agent_wakeups w
       SET completed_at = NOW(), result = CASE
             WHEN ud.outcome = 'success' THEN 'delivered'
             WHEN ud.outcome = 'exhausted' THEN 'exhausted'
             WHEN ud.outcome = 'gone' THEN 'webhook_removed'
             WHEN ud.outcome = 'disabled' THEN 'webhook_disabled'
             ELSE NULL
           END
       FROM updated_delivery ud
       WHERE w.id = ud.wakeup_id
         AND ud.wakeup_delivery = 'webhook'
         AND ud.outcome IN ('success', 'exhausted', 'gone', 'disabled')
         AND w.completed_at IS NULL
       RETURNING w.id
     ),
     reset_failure AS (
       UPDATE agent_webhooks h
       SET failure_count = 0
       FROM updated_delivery ud
       WHERE h.agent_id = ud.agent_id AND ud.outcome = 'success'
       RETURNING h.agent_id
     ),
     bumped_failure AS (
       UPDATE agent_webhooks h
       SET
         failure_count = h.failure_count + 1,
         disabled_at = CASE WHEN ud.crosses_threshold THEN NOW() ELSE h.disabled_at END
       FROM updated_delivery ud
       WHERE h.agent_id = ud.agent_id AND ud.live_failure
       RETURNING h.agent_id, ud.crosses_threshold
     ),
     disabled_now AS (
       SELECT agent_id FROM bumped_failure WHERE crosses_threshold
     ),
     disable_sweep AS (
       UPDATE webhook_deliveries wd
       SET terminal_reason = 'webhook_disabled'
       FROM disabled_now dn, updated_delivery ud
       WHERE wd.agent_id = dn.agent_id
         AND wd.id <> ud.id
         AND wd.terminal_reason IS NULL
         AND (wd.claimed_at IS NULL OR wd.lease_expires_at < NOW())
       RETURNING wd.wakeup_id
     ),
     disable_sweep_wakeups AS (
       UPDATE agent_wakeups w
       SET completed_at = NOW(), result = 'webhook_disabled'
       FROM disable_sweep ds
       WHERE w.id = ds.wakeup_id
         AND w.delivery = 'webhook'
         AND w.completed_at IS NULL
       RETURNING w.id
     )${emitted.ctes.length > 0 ? `, ${emitted.ctes.join(", ")}` : ""}
     SELECT ud.outcome FROM updated_delivery ud`,
    [...params, ...emitted.params]
  );
  const row = rows[0] as { outcome?: string } | undefined;
  if (!row?.outcome) return "not_found";
  return row.outcome as RecordWebhookAttemptOutcome;
}
