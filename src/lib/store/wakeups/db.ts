import { getLoopState } from "@/lib/agent-loop/state";
import { sql } from "@/lib/db";
import { toIsoOrEmpty, toIsoOrNull } from "@/lib/iso-date";

/**
 * M11-2 P3.2 (train a4, lane C) — the wakeup queue's data layer.
 *
 * A row in `agent_wakeups` means "agent X has a reason to check in". Two callers write them and
 * neither lives here: the wakeup-router consumer (drains events and creates wakeups) and the
 * playground deadline sweep (creates-or-re-arms defensively). **Nothing in this deploy CLAIMS or
 * RUNS a wakeup** — the claim CTE, the lease fencing and the budget spend belong to P3.3 — so this
 * module deliberately exposes no claim, no lease and no completion writer. `idx_wakeups_one_inflight`
 * therefore has no observable effect on anything here: nothing this module writes ever sets
 * `claimed_at`.
 *
 * **The domain is kind-agnostic on purpose.** It deals in `agentId` / `reason` (a plain string) /
 * `eventId` (a plain number) / `payload`, never in `EventKind` or `PreparedEvent`, and it emits no
 * events of its own. A wakeup is a nudge derived from history, not a new fact about the world, so
 * there is nothing here for Decision 2's statement renderer or Decision 4's memory preflight to do.
 */

/** How a claimed wakeup will be delivered. Resolved at enqueue time, never re-decided later. */
export type WakeupDelivery = "internal" | "webhook" | "none";

export interface StoredWakeup {
  /** `agent_wakeups.id` (BIGSERIAL), normalized through `Number()` exactly as `StoredEvent.id` is. */
  id: number;
  agentId: string;
  reason: string;
  eventId: number | null;
  payload: Record<string, unknown>;
  delivery: WakeupDelivery;
  dueAt: string;
  claimedAt: string | null;
  claimToken: string | null;
  leaseExpiresAt: string | null;
  completedAt: string | null;
  result: string | null;
}

export interface EnqueueWakeupInput {
  agentId: string;
  reason: string;
  /** `null` => an idle-shaped row, deduped by `idx_wakeups_dedup_idle` rather than by event. */
  eventId: number | null;
  payload: Record<string, unknown>;
  delivery: WakeupDelivery;
  /** Defaults to now. */
  dueAt?: string;
}

export interface EnqueueWakeupResult {
  /** `false` = a dedup index already held this key; nothing was written. */
  created: boolean;
  /** The row, only when `created === true`. */
  wakeup: StoredWakeup | null;
}

export interface CreateOrReArmWakeupInput {
  agentId: string;
  reason: string;
  /** ALWAYS non-null here — this path is event-keyed dedup only. */
  eventId: number;
  payload: Record<string, unknown>;
  delivery: WakeupDelivery;
  dueAt?: string;
}

export interface CreateOrReArmWakeupResult {
  created: boolean;
  reArmed: boolean;
}

/** Page size when a caller states none. Shared with the memory store so the two cannot drift. */
export const DEFAULT_WAKEUP_LIST_LIMIT = 50;

/**
 * The kind `findRoundOpenedEventId` looks for, as a plain string.
 *
 * Deliberately not typed as `EventKind`: this domain never imports the kind union (see the header),
 * and a locator that reads one literal is not a producer of it. One definition, shared with the
 * memory store, for the reason `rate-limit-windows.ts` exists — a literal spelled twice is a
 * divergence Jest cannot see.
 */
export const ROUND_OPENED_KIND = "playground.round_opened";

interface WakeupRow {
  id: number | string;
  agent_id: string;
  reason: string;
  event_id: number | string | null;
  payload: Record<string, unknown> | null;
  delivery: string;
  due_at: unknown;
  claimed_at: unknown;
  claim_token: string | null;
  lease_expires_at: unknown;
  completed_at: unknown;
  result: string | null;
}

/**
 * One mapper for every read, so no reader can drift from another.
 *
 * `id` and `event_id` are BIGINT and arrive as strings from both drivers, so both are normalized
 * through `Number()` here — the same rule `rowToEvent` follows, and for the same reason: callers
 * compare these ids numerically and a string comparison would order `"10" < "9"`. Timestamps arrive
 * as a `Date` or as a string depending on the driver path, which is what `toIsoOrNull` exists for.
 */
export function rowToWakeup(row: unknown): StoredWakeup {
  const r = row as WakeupRow;
  return {
    id: Number(r.id),
    agentId: String(r.agent_id),
    reason: String(r.reason),
    eventId: r.event_id == null ? null : Number(r.event_id),
    payload: r.payload ?? {},
    delivery: String(r.delivery) as WakeupDelivery,
    dueAt: toIsoOrEmpty(r.due_at),
    claimedAt: toIsoOrNull(r.claimed_at),
    claimToken: r.claim_token == null ? null : String(r.claim_token),
    leaseExpiresAt: toIsoOrNull(r.lease_expires_at),
    completedAt: toIsoOrNull(r.completed_at),
    result: r.result == null ? null : String(r.result),
  };
}

/** The INSERT both write paths share, so the column list and the casts have one definition. */
const INSERT_WAKEUP = `
  INSERT INTO agent_wakeups (agent_id, reason, event_id, payload, delivery, due_at)
  VALUES ($1, $2, $3, $4::jsonb, $5, COALESCE($6::timestamptz, NOW()))
  ON CONFLICT DO NOTHING
`;

function insertParams(input: EnqueueWakeupInput | CreateOrReArmWakeupInput): unknown[] {
  return [
    input.agentId,
    input.reason,
    input.eventId,
    JSON.stringify(input.payload ?? {}),
    input.delivery,
    input.dueAt ?? null,
  ];
}

/**
 * Plain insert. Never re-arms — a completed row stays completed.
 *
 * **The bare `ON CONFLICT DO NOTHING` carries no conflict target, and that is deliberate.** Postgres
 * lets a plain `DO NOTHING` absorb a violation of *any* unique or exclusion constraint on the table,
 * and exactly two partial unique indexes can fire here: `idx_wakeups_dedup_event` when `event_id IS
 * NOT NULL`, and `idx_wakeups_dedup_idle` when `event_id IS NULL AND completed_at IS NULL`. Whichever
 * applies to this row is the one that should suppress the insert, and the caller does not have to
 * know which — naming a target would force it to, and would turn the other index's violation into a
 * raised 23505.
 *
 * Note the asymmetry the two indexes encode: the event-keyed one is NOT partial on `completed_at`,
 * so a completed event-keyed row blocks a second insert forever (only a re-arm reuses it), while a
 * completed idle row stops blocking and a fresh idle wakeup may be enqueued again.
 */
export async function enqueueWakeup(input: EnqueueWakeupInput): Promise<EnqueueWakeupResult> {
  const rows = await sql!(`${INSERT_WAKEUP} RETURNING *`, insertParams(input));
  if (rows.length === 0) return { created: false, wakeup: null };
  return { created: true, wakeup: rowToWakeup(rows[0]) };
}

/**
 * Find-or-create-or-re-arm in ONE statement, keyed by the dedup TRIPLE `(agent_id, reason,
 * event_id)` — never by a numeric row id, because the caller does not know one yet.
 *
 * `eventId` is always non-null on this path, so the bare `ON CONFLICT DO NOTHING` in `ins` can only
 * ever match `idx_wakeups_dedup_event`; the idle index cannot apply to a row with an event id.
 *
 * **The two CTEs are mutually exclusive by construction, so this needs no arbiter.** A freshly
 * inserted row has `completed_at IS NULL`, which `rearmed`'s predicate cannot match, so there is no
 * torn state and no deadlock shape for CLAUDE.md's "sibling data-modifying CTEs need an ARBITER"
 * rule to apply to — the only reachable interleaving is the benign one below.
 *
 * **`created: false, reArmed: false` is a LEGITIMATE outcome, not a bug.** Two callers racing this
 * statement for the same triple when no row exists yet — the router and the sweep reacting to one
 * freshly drained `round_opened` — can BOTH answer false/false: the loser's `ins` correctly no-ops
 * against the winner's now-committed row, while its own `rearmed` CTE is evaluated against a
 * statement snapshot taken before that commit and therefore also sees nothing. After both statements
 * complete exactly one row exists — never zero, never two, because the unique index says so — and
 * that is the only invariant a best-effort nudge queue needs. Do NOT add `FOR UPDATE` or any other
 * arbiter to force one caller to "win" and see it: that buys serialization contention for a
 * reporting gap with no correctness payoff. The loser sees the row already in the state it wanted,
 * next pass.
 */
export async function createOrReArmWakeup(
  input: CreateOrReArmWakeupInput
): Promise<CreateOrReArmWakeupResult> {
  const rows = await sql!(
    `
    /* p3.2:create-or-rearm */
    WITH ins AS (
      ${INSERT_WAKEUP}
      RETURNING *
    ),
    rearmed AS (
      UPDATE agent_wakeups
      SET claimed_at = NULL, claim_token = NULL, lease_expires_at = NULL, completed_at = NULL, result = NULL
      WHERE agent_id = $1 AND reason = $2 AND event_id = $3
        AND completed_at IS NOT NULL
        AND result IS DISTINCT FROM 'acted'
        AND (result IS DISTINCT FROM 'budget_exhausted' OR completed_at::date < CURRENT_DATE)
      RETURNING *
    )
    SELECT (SELECT to_jsonb(ins) FROM ins) AS created_row,
           (SELECT to_jsonb(rearmed) FROM rearmed) AS rearmed_row
  `,
    insertParams(input)
  );
  const row = rows[0] as { created_row: unknown; rearmed_row: unknown } | undefined;
  return {
    created: row?.created_row != null,
    reArmed: row?.rearmed_row != null,
  };
}

export interface CreateOrReArmPlaygroundRoundWakeupInput {
  agentId: string;
  /** ALWAYS non-null — this path is event-keyed dedup only, like `createOrReArmWakeup`. */
  eventId: number;
  payload: Record<string, unknown>;
  delivery: WakeupDelivery;
  dueAt?: string;
  /** The session whose round this wakeup is for — the live-state gate's subject. */
  sessionId: string;
  round: number;
}

/**
 * The one reason this gated path arms. A constant, not a parameter: the gate below reads playground
 * tables, so the operation is playground-specific by nature, and both callers (the wakeup-router
 * consumer and the deadline sweep) must spell the reason identically or the dedup triple splits.
 */
export const PLAYGROUND_ROUND_REASON = "playground_round";

/**
 * `createOrReArmWakeup`, but for `playground_round` — with the freshness check INSIDE the statement,
 * under a lock (codex u5-C round 1 MAJOR).
 *
 * Both callers used to pre-read the session (active, `current_round` matches, agent un-acted) and
 * then await other work before inserting. A pre-read that RETURNS competes with the decisive
 * statement and loses (CLAUDE.md): a session advancing to round N+1 in that window let a stale
 * round-N wakeup land beside the legitimate round-N+1 one — two claimable rows for one agent,
 * double budget the moment P3.3's runner exists, because the event-keyed dedup index sees two
 * different event ids.
 *
 * So `live` re-checks the session AND the agent's action at insert time, and takes the session row
 * `FOR SHARE` — never a bare `EXISTS`, which is snapshot-evaluated and never re-checked. The
 * advancement CAS is an `UPDATE` of that same row, so `FOR SHARE` either sees its committed round
 * (and arms nothing) or blocks it until this statement commits (and the CAS then advances a session
 * whose stale-round wakeup was never created). The action `NOT EXISTS` stays unlocked deliberately:
 * a just-acted agent's wakeup is only wasted budget, and `submitAction`'s duplicate-per-round
 * rejection already refuses the turn — the plan frames that check as budget protection, not
 * correctness. Both arms — the insert AND the re-arm — gate on `live`, so a dead round can neither
 * gain a new row nor resurrect a completed one.
 *
 * Lock order is `playground_sessions → agents` (the insert's FK takes `FOR KEY SHARE` on the
 * agent), the same order `submitAction`'s gated insert takes; nothing in the tree takes an agent
 * lock before a session lock, so no cycle is introduced.
 */
export async function createOrReArmPlaygroundRoundWakeup(
  input: CreateOrReArmPlaygroundRoundWakeupInput
): Promise<CreateOrReArmWakeupResult> {
  const rows = await sql!(
    `
    /* p3.2:playground-round-arm */
    WITH live AS (
      SELECT s.id FROM playground_sessions s
      WHERE s.id = $7 AND s.status = 'active' AND s.current_round = $8
        AND NOT EXISTS (
          SELECT 1 FROM playground_actions a
          WHERE a.session_id = s.id AND a.agent_id = $1 AND a.round = $8
        )
      FOR SHARE OF s
    ),
    ins AS (
      INSERT INTO agent_wakeups (agent_id, reason, event_id, payload, delivery, due_at)
      SELECT $1, $2, $3, $4::jsonb, $5, COALESCE($6::timestamptz, NOW())
      FROM live
      ON CONFLICT DO NOTHING
      RETURNING *
    ),
    rearmed AS (
      UPDATE agent_wakeups
      SET claimed_at = NULL, claim_token = NULL, lease_expires_at = NULL, completed_at = NULL, result = NULL
      WHERE agent_id = $1 AND reason = $2 AND event_id = $3
        AND EXISTS (SELECT 1 FROM live)
        AND completed_at IS NOT NULL
        AND result IS DISTINCT FROM 'acted'
        AND (result IS DISTINCT FROM 'budget_exhausted' OR completed_at::date < CURRENT_DATE)
      RETURNING *
    )
    SELECT (SELECT to_jsonb(ins) FROM ins) AS created_row,
           (SELECT to_jsonb(rearmed) FROM rearmed) AS rearmed_row
  `,
    [
      ...insertParams({
        agentId: input.agentId,
        reason: PLAYGROUND_ROUND_REASON,
        eventId: input.eventId,
        payload: input.payload,
        delivery: input.delivery,
        dueAt: input.dueAt,
      }),
      input.sessionId,
      input.round,
    ]
  );
  const row = rows[0] as { created_row: unknown; rearmed_row: unknown } | undefined;
  return {
    created: row?.created_row != null,
    reArmed: row?.rearmed_row != null,
  };
}

/**
 * The NORMATIVE re-arm predicate, standalone, by a KNOWN numeric id.
 *
 * For a caller that already holds the row — a future runner will; nothing in THIS lane does. The
 * predicate is `ai/PLAN_M11_2.md` P3.2's normative text verbatim: **do not add, remove or reorder a
 * clause.** Each one is load-bearing:
 *  - `completed_at IS NOT NULL` — a live claim, even a lease-expired one housekeeping has not
 *    abandoned yet, is never touched;
 *  - `result IS DISTINCT FROM 'acted'` — an agent that actually acted does not get a second turn;
 *  - `result IS DISTINCT FROM 'budget_exhausted' OR completed_at::date < CURRENT_DATE` — a wakeup
 *    refused for budget is re-armable tomorrow, when the daily bucket rolls over, and not before.
 *
 * Clearing `claim_token` is what makes abandonment final for a superseded runner: its own renewal
 * (`… WHERE claim_token = $token AND completed_at IS NULL`) fails from that moment on.
 */
export async function reArmWakeupById(id: number): Promise<boolean> {
  const rows = await sql!(
    `
    UPDATE agent_wakeups
    SET claimed_at = NULL, claim_token = NULL, lease_expires_at = NULL, completed_at = NULL, result = NULL
    WHERE id = $1 AND completed_at IS NOT NULL AND result IS DISTINCT FROM 'acted'
      AND (result IS DISTINCT FROM 'budget_exhausted' OR completed_at::date < CURRENT_DATE)
    RETURNING id
  `,
    [id]
  );
  return rows.length > 0;
}

export async function getWakeupByAgentReasonEvent(
  agentId: string,
  reason: string,
  eventId: number
): Promise<StoredWakeup | null> {
  const rows = await sql!(
    `SELECT * FROM agent_wakeups
     WHERE agent_id = $1 AND reason = $2 AND event_id = $3
     LIMIT 1`,
    [agentId, reason, eventId]
  );
  return rows.length > 0 ? rowToWakeup(rows[0]) : null;
}

/**
 * One agent's wakeups, newest first.
 *
 * Ordered by `id`, not by `due_at`: a sweep arms a whole round's participants from one `NOW()`, so
 * `due_at` ties are the ordinary case and an order that can tie makes a limited read
 * nondeterministic. This is a diagnostic/adjacent-caller read, not the runner's scan — the runner's
 * scan is `idx_wakeups_due` and belongs to P3.3.
 */
export async function listWakeupsForAgent(
  agentId: string,
  options?: { reason?: string; limit?: number }
): Promise<StoredWakeup[]> {
  const rows = await sql!(
    `SELECT * FROM agent_wakeups
     WHERE agent_id = $1 AND ($2::text IS NULL OR reason = $2::text)
     ORDER BY id DESC
     LIMIT $3`,
    [agentId, options?.reason ?? null, normalizeListLimit(options?.limit)]
  );
  return (rows as unknown[]).map(rowToWakeup);
}

/** Shared by both stores: a limit is at least 1, an integer, and defaults to the page size. */
export function normalizeListLimit(limit: number | undefined): number {
  return Math.max(1, Math.floor(limit ?? DEFAULT_WAKEUP_LIST_LIMIT));
}

/**
 * The `playground.round_opened` event id for `(sessionId, round)` — real or reconstructed — newest
 * first.
 *
 * There should only ever be one per (session, round): the producers' gating and the rollout bridge's
 * `idem_key` both say so. "Newest first, limit 1" is the defensive read against a history that
 * nonetheless holds two.
 *
 * A plain `SELECT` with no lock: `events` is an append-only log and this is a read. The session id
 * is matched on the `subject_id` COLUMN — the payload's `session_id` copy exists so a consumer can
 * re-verify the two agree (the `requireCorrelation` pattern), and re-verifying it here would refuse
 * to locate an otherwise valid event whose payload copy is absent. The round has no column of its
 * own and must be read out of the payload.
 */
export async function findRoundOpenedEventId(sessionId: string, round: number): Promise<number | null> {
  // `payload.round` is a jsonb NUMBER and every producer writes an integer, so a non-integer cannot
  // match anything. Answered here rather than by casting to `int` in SQL, which ROUNDS — `2.7::int`
  // would silently look up round 3, and the memory store would answer something else.
  if (!Number.isInteger(round)) return null;
  const rows = await sql!(
    `SELECT id FROM events
     WHERE kind = $1 AND subject_id = $2 AND payload->'round' = to_jsonb($3::int)
     ORDER BY id DESC
     LIMIT 1`,
    [ROUND_OPENED_KIND, sessionId, round]
  );
  return rows.length > 0 ? Number((rows[0] as { id: number | string }).id) : null;
}

/**
 * Delivery resolution — the pre-P5 rule, in ONE place.
 *
 * Both callers of this lane (the wakeup-router consumer and the playground deadline sweep) apply it
 * instead of each inventing their own: loop-enabled ⇒ `internal`; a missing row or `enabled = false`
 * ⇒ `null`, and **the caller must not create a wakeup for that agent at all**. Webhook delivery
 * (P5.1) joins this function later; until then `webhook` and `none` are storable values that nothing
 * resolves.
 */
export async function resolveWakeupDelivery(agentId: string): Promise<"internal" | null> {
  const state = await getLoopState(agentId);
  return state?.enabled === true ? "internal" : null;
}
