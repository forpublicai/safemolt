import { eventLog, playgroundActions, playgroundSessions, wakeupQueue } from "../_memory-state";
import {
  PLAYGROUND_ROUND_REASON,
  ROUND_OPENED_KIND,
  normalizeListLimit,
  type CreateOrReArmPlaygroundRoundWakeupInput,
  type CreateOrReArmWakeupInput,
  type CreateOrReArmWakeupResult,
  type EnqueueWakeupInput,
  type EnqueueWakeupResult,
  type StoredWakeup,
} from "./db";

/**
 * M11-2 P3.2 — the memory-mode wakeup queue (the pinned Jest / no-DB path).
 *
 * Semantically identical to `db.ts`, which means reproducing the three partial unique indexes and
 * the normative re-arm predicate rather than approximating them. Each function below is ONE
 * synchronous section — no `await` between the check and the write — so two interleaved callers
 * cannot both pass a dedup check, the same guarantee the unique index gives in db mode. There is
 * nothing to `await` here regardless: this domain issues no events, so it needs none of Decision 4's
 * `prepareEventBatch` discipline.
 *
 * The list cap, the kind literal and the limit normalizer are IMPORTED from `db.ts` rather than
 * respelled, for the reason `rate-limit-windows.ts` exists: a constant defined twice is a divergence
 * only production can see. The import is inert in a no-DB run — `@/lib/db` tolerates a missing
 * connection string, and nothing in this file touches `sql`.
 *
 * Deliberately absent, exactly as in db mode: any writer of `claimed_at`, `claim_token`,
 * `lease_expires_at`, `completed_at` or `result`. Claiming, leasing and completion are P3.3. A test
 * that needs a completed row seeds one directly through `wakeupQueue`, which is honest about the
 * fact that no production code here can produce that state yet.
 */

/**
 * Round-trip a payload through JSON, exactly as the db path does.
 *
 * `structuredClone` would preserve things JSONB cannot store — a `Date` would stay a `Date`, a `Map`
 * would survive, `undefined` members would survive — so memory mode would answer things Postgres
 * never could. The db store serializes with `JSON.stringify` and reads JSONB back; a JSON round-trip
 * is the only clone that agrees with it. It also throws on a cyclic payload, before anything is
 * written.
 */
function normalizePayload(payload: unknown): Record<string, unknown> {
  return JSON.parse(JSON.stringify(payload ?? {})) as Record<string, unknown>;
}

/** Readers hand out copies: a caller that mutated what it read would rewrite stored state. */
function cloneWakeup(row: StoredWakeup): StoredWakeup {
  return { ...row, payload: normalizePayload(row.payload) };
}

/**
 * The timestamp Postgres would have stored.
 *
 * A supplied `due_at` is parsed and re-rendered rather than kept verbatim, because `timestamptz`
 * normalizes an offset and a reader gets ISO text back either way. An unparseable value throws
 * (`RangeError`), which is the closest memory mode gets to Postgres refusing the cast.
 */
function timestamp(value: string | undefined): string {
  return value === undefined ? new Date().toISOString() : new Date(value).toISOString();
}

/**
 * The calendar day of an ISO instant, for the budget clause's `completed_at::date < CURRENT_DATE`.
 *
 * Postgres evaluates BOTH sides of that comparison in the session time zone, and this repo's
 * databases run UTC (as does every other "today" in the memory store — `commentCountToday` slices
 * the same way). Comparing the two date strings lexicographically is exact: `YYYY-MM-DD` sorts as
 * dates do.
 */
function utcDay(iso: string): string {
  return new Date(iso).toISOString().slice(0, 10);
}

/** Every row currently in the queue, in insertion order (ids ascend, so id order is the same). */
function rows(): StoredWakeup[] {
  return Array.from(wakeupQueue.rows.values());
}

/**
 * The memory twin of the two enqueue-dedup indexes — the ONLY place either predicate is spelled.
 *
 * `idx_wakeups_dedup_event` is `UNIQUE (agent_id, reason, event_id) WHERE event_id IS NOT NULL`: not
 * partial on `completed_at`, so a COMPLETED row still blocks a second insert forever, and only the
 * re-arm UPDATE (which reuses that same row) ever frees the key.
 *
 * `idx_wakeups_dedup_idle` is `UNIQUE (agent_id, reason) WHERE event_id IS NULL AND completed_at IS
 * NULL`: once an idle row completes it stops blocking, and a NEW idle row for that agent+reason may
 * be created. Mirroring the index's own partial predicate is what makes that true here too.
 */
function conflictingRow(
  agentId: string,
  reason: string,
  eventId: number | null
): StoredWakeup | undefined {
  if (eventId !== null) {
    return rows().find(
      (row) => row.agentId === agentId && row.reason === reason && row.eventId === eventId
    );
  }
  return rows().find(
    (row) =>
      row.agentId === agentId &&
      row.reason === reason &&
      row.eventId === null &&
      row.completedAt === null
  );
}

/**
 * The normative re-arm predicate, evaluated against one row.
 *
 * Written clause-for-clause against `ai/PLAN_M11_2.md` P3.2's SQL, so the two stores refuse and
 * admit the same rows. `IS DISTINCT FROM` is null-safe — `NULL IS DISTINCT FROM 'acted'` is true —
 * which `!==` reproduces exactly for a `string | null`.
 */
function reArmable(row: StoredWakeup): boolean {
  if (row.completedAt === null) return false;
  if (row.result === "acted") return false;
  if (row.result === "budget_exhausted" && utcDay(row.completedAt) >= utcDay(new Date().toISOString())) {
    return false;
  }
  return true;
}

/**
 * Append one row. The id counter is the memory twin of BIGSERIAL: it only ever climbs.
 *
 * The payload arrives ALREADY normalized, and is not re-normalized here: both callers normalize
 * before their dedup check, because the db store serializes the payload before it sends anything —
 * so a cyclic payload must throw even on the call a dedup index would have suppressed.
 */
function insertRow(
  input: EnqueueWakeupInput | CreateOrReArmWakeupInput,
  payload: Record<string, unknown>
): StoredWakeup {
  const row: StoredWakeup = {
    id: wakeupQueue.nextId++,
    agentId: input.agentId,
    reason: input.reason,
    eventId: input.eventId,
    payload,
    delivery: input.delivery,
    dueAt: timestamp(input.dueAt),
    claimedAt: null,
    claimToken: null,
    leaseExpiresAt: null,
    completedAt: null,
    result: null,
  };
  wakeupQueue.rows.set(row.id, row);
  return row;
}

/** See `db.ts`: a plain insert that never re-arms, deduped by whichever index applies. */
export async function enqueueWakeup(input: EnqueueWakeupInput): Promise<EnqueueWakeupResult> {
  // Normalized FIRST, so a cyclic payload throws with nothing written — the db store serializes
  // before it sends, so it refuses the same input the same way, dedup or no dedup.
  const payload = normalizePayload(input.payload);
  if (conflictingRow(input.agentId, input.reason, input.eventId)) {
    return { created: false, wakeup: null };
  }
  return { created: true, wakeup: cloneWakeup(insertRow(input, payload)) };
}

/**
 * See `db.ts`: find-or-create-or-re-arm, keyed by the `(agentId, reason, eventId)` triple.
 *
 * The db statement's three reachable outcomes, in one synchronous section:
 *  - no row ⇒ the insert lands (`created`);
 *  - a row that the predicate admits ⇒ the same row is re-armed in place (`reArmed`);
 *  - a row the predicate refuses — still pending or claimed, completed `acted`, or completed
 *    `budget_exhausted` today ⇒ neither, and nothing is written.
 *
 * The false/false RACE outcome db mode also has is unreachable here by construction: there is no
 * snapshot, and no `await` splits the check from the write.
 */
export async function createOrReArmWakeup(
  input: CreateOrReArmWakeupInput
): Promise<CreateOrReArmWakeupResult> {
  const payload = normalizePayload(input.payload);
  const existing = conflictingRow(input.agentId, input.reason, input.eventId);
  if (!existing) {
    insertRow(input, payload);
    return { created: true, reArmed: false };
  }
  if (!reArmable(existing)) return { created: false, reArmed: false };
  clearClaimAndCompletion(existing);
  return { created: false, reArmed: true };
}

/**
 * The memory twin of the db statement's `live` CTE (codex u5-C round 1 MAJOR): the session is
 * active on THIS round and the agent has not acted in it.
 *
 * Read from the shared `_memory-state` registry — the sanctioned cross-domain path (the comments
 * twin reads `posts` the same way) — and evaluated in the same synchronous section as the write, so
 * no advancement can land between the check and the insert. The db side gets that guarantee from
 * `FOR SHARE` on the session row; memory gets it from the section having no `await`.
 */
function playgroundRoundIsFresh(sessionId: string, agentId: string, round: number): boolean {
  const session = playgroundSessions.get(sessionId);
  if (!session || session.status !== "active" || session.currentRound !== round) return false;
  for (const action of playgroundActions.values()) {
    if (action.sessionId === sessionId && action.agentId === agentId && action.round === round) {
      return false;
    }
  }
  return true;
}

/**
 * See `db.ts`: `createOrReArmWakeup` for `playground_round`, with the freshness gate evaluated in
 * the SAME synchronous section as the write. Both arms — insert and re-arm — refuse when the round
 * is no longer live, so a dead round can neither gain a new row nor resurrect a completed one.
 */
export async function createOrReArmPlaygroundRoundWakeup(
  input: CreateOrReArmPlaygroundRoundWakeupInput
): Promise<CreateOrReArmWakeupResult> {
  // Normalized FIRST: a cyclic payload throws with nothing written, gate or no gate — the db store
  // serializes before it sends anything.
  const payload = normalizePayload(input.payload);
  if (!playgroundRoundIsFresh(input.sessionId, input.agentId, input.round)) {
    return { created: false, reArmed: false };
  }
  const asBase: CreateOrReArmWakeupInput = {
    agentId: input.agentId,
    reason: PLAYGROUND_ROUND_REASON,
    eventId: input.eventId,
    payload,
    delivery: input.delivery,
    dueAt: input.dueAt,
  };
  const existing = conflictingRow(asBase.agentId, asBase.reason, asBase.eventId);
  if (!existing) {
    insertRow(asBase, payload);
    return { created: true, reArmed: false };
  }
  if (!reArmable(existing)) return { created: false, reArmed: false };
  clearClaimAndCompletion(existing);
  return { created: false, reArmed: true };
}

/** The re-arm UPDATE's SET list, in one place, so both re-arm paths clear the same five columns. */
function clearClaimAndCompletion(row: StoredWakeup): void {
  row.claimedAt = null;
  row.claimToken = null;
  row.leaseExpiresAt = null;
  row.completedAt = null;
  row.result = null;
}

/** See `db.ts`: the normative predicate, by a known numeric id. */
export async function reArmWakeupById(id: number): Promise<boolean> {
  const row = wakeupQueue.rows.get(id);
  if (!row || !reArmable(row)) return false;
  clearClaimAndCompletion(row);
  return true;
}

export async function getWakeupByAgentReasonEvent(
  agentId: string,
  reason: string,
  eventId: number
): Promise<StoredWakeup | null> {
  const found = rows().find(
    (row) => row.agentId === agentId && row.reason === reason && row.eventId === eventId
  );
  return found ? cloneWakeup(found) : null;
}

/** See `db.ts`: newest first by id, because a sweep's `due_at` values tie. */
export async function listWakeupsForAgent(
  agentId: string,
  options?: { reason?: string; limit?: number }
): Promise<StoredWakeup[]> {
  return rows()
    .filter((row) => row.agentId === agentId)
    .filter((row) => options?.reason === undefined || row.reason === options.reason)
    .sort((a, b) => b.id - a.id)
    .slice(0, normalizeListLimit(options?.limit))
    .map(cloneWakeup);
}

/**
 * See `db.ts`: the `playground.round_opened` event id for `(sessionId, round)`, newest first.
 *
 * Scans `eventLog.rows` from `@/lib/store/_memory-state` — a READ-ONLY use of another domain's
 * memory state, which is the shared substrate every memory module reads directly. Nothing from
 * `@/lib/store/events/*` is imported: this is a read of a log, not participation in the event
 * machinery, and reaching into that domain's modules would put a layering edge where none belongs.
 *
 * `payload.round === round` is strict equality on numbers, which is exactly what the db store's
 * `payload->'round' = to_jsonb($3::int)` compares — the log's payloads have already been JSON
 * round-tripped, so an integer there is a number here.
 */
export async function findRoundOpenedEventId(sessionId: string, round: number): Promise<number | null> {
  if (!Number.isInteger(round)) return null;
  for (let i = eventLog.rows.length - 1; i >= 0; i -= 1) {
    const event = eventLog.rows[i];
    if (event.kind !== ROUND_OPENED_KIND) continue;
    if (event.subjectId !== sessionId) continue;
    const payloadRound = (event.payload as { round?: unknown }).round;
    if (typeof payloadRound !== "number" || payloadRound !== round) continue;
    return event.id;
  }
  return null;
}

/**
 * Memory mode resolves `"internal"` for EVERY agent id, unconditionally — a deliberate, recorded
 * scope decision, not an oversight or a TODO.
 *
 * `agent_loop_state` has no memory-mode store anywhere in this codebase, and `src/lib/agent-loop.ts`
 * — which would own one if it existed — is a different lane's exclusive fence for this milestone, so
 * this module may neither touch it nor import from it. Nothing in this lane's scope reads this value
 * for a decision yet either: the claim/runner that would actually branch on `delivery` is P3.3, and
 * it is explicitly deferred. So there is nothing here for a memory twin to be faithful TO, and
 * inventing one would be inventing state. When P3.3 or P5.1 gives memory mode a loop-state twin,
 * this function is where it lands.
 */
export async function resolveWakeupDelivery(agentId: string): Promise<"internal" | null> {
  // The parameter stays declared — `pickStore` requires both implementations to take the same
  // arguments, and the db twin reads it. This mode deliberately does not.
  void agentId;
  return "internal";
}
