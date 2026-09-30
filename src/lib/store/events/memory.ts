import type { PreparedEvent } from "@/lib/events/kinds";
import type { StoredEvent } from "@/lib/store-types";

import { EVENT_LOG_CAP, eventLog } from "../_memory-state";
import { DEFAULT_EVENT_LIST_LIMIT, type EmittedEvent } from "./db";
import { dispatchAppendedEvent } from "./memory-dispatch";
import { validatePreparedEvent } from "./statement";

/**
 * M11-2 u1 — memory-mode event log (the pinned Jest / no-DB path).
 *
 * Decision-4 discipline, and it is the whole point of this file's shape: it is split into a
 * **preflight that throws** (`prepareEventBatch`) and an **append that cannot** (`appendPreparedBatch`).
 * Every check lives in the first half — the kind, the JSON normalization of each payload, and the
 * idempotency key against both the log and the batch itself — so a caller runs it before its
 * mutation and is left with a batch that only pushes. There is then no `await` between a caller's
 * mutation and the append, and no way for the append to fail after the mutation has landed.
 *
 * That second property is the one a kind-only check did not give, and Postgres is the standard it is
 * held to: there the event insert rides the mutation's own statement, so a 23505 on `idx_events_idem`
 * rolls the mutation back with it. Memory mode has no transaction, so it reaches the same end state
 * by refusing the whole batch before anything is written.
 *
 * Drain machinery does not exist here (Decision 6): memory mode has no worker and no cron, so the
 * consumers run in-process off the append below, through `memory-dispatch.ts`.
 */

/**
 * Round-trip a payload through JSON, exactly as the db path does.
 *
 * `structuredClone` would also detach the caller's object, but it preserves things Postgres cannot
 * store: a `Date` stays a `Date`, a `Map` survives, `undefined` members survive. The db store
 * serializes with `JSON.stringify` and reads JSONB back, so a JSON round-trip is the only clone
 * that makes memory mode answer what Postgres would have answered — which is the whole reason the
 * memory store exists. It also throws on a cyclic payload, and it runs BEFORE any mutation.
 */
function normalizePayload(payload: unknown): Record<string, unknown> {
  return JSON.parse(JSON.stringify(payload ?? {})) as Record<string, unknown>;
}

/** Readers hand out copies: a caller that mutated what it read would rewrite recorded history. */
function cloneEvent(event: StoredEvent): StoredEvent {
  return { ...event, payload: normalizePayload(event.payload) };
}

/**
 * The memory-mode stand-in for `idx_events_idem`.
 *
 * A producer that stamps a deterministic `idem_key` — a playground action, a consumer activation
 * fence — relies on the second write being REFUSED. In db mode the partial unique index refuses it
 * with 23505; without this check memory mode appended a second copy and a retry that is idempotent
 * in production silently duplicated in Jest, which is precisely the divergence the memory store
 * exists to avoid. NULL keys are unconstrained on both sides.
 *
 * The error carries the same `code` the driver reports, because callers that tolerate a duplicate
 * do so by inspecting it. Uniqueness holds over the retained window only — the log is capped, so a
 * key whose event has aged out is free again, which db-mode retention also eventually allows.
 */
function assertIdemKeyFree(idemKey: string | null | undefined): void {
  if (idemKey == null) return;
  if (!eventLog.rows.some((event) => event.idemKey === idemKey)) return;
  throw duplicateIdemKeyError();
}

/** One shape for both duplicate sources — against the log, and within one batch. */
function duplicateIdemKeyError(): Error & { code: string } {
  const error = new Error(
    `duplicate key value violates unique constraint "idx_events_idem"`
  ) as Error & { code: string };
  error.code = "23505";
  return error;
}

/**
 * One event, fully validated and normalized — **with nothing left that can throw**.
 *
 * The split below exists so that this type can: a value of it has already had its kind checked, its
 * payload round-tripped through JSON, and its idempotency key cleared against the log and against
 * its own batch. Appending it is an id increment and an array push.
 */
interface PreflightedEvent {
  readonly source: PreparedEvent;
  readonly payload: Record<string, unknown>;
}

/** A whole batch, preflighted together. Opaque: only `appendPreparedBatch` consumes one. */
export interface PreparedEventBatch {
  readonly events: readonly PreflightedEvent[];
}

/**
 * The half of the preflight that a mutation which may REFUSE must still run — and run FIRST.
 *
 * Postgres validates the kind and serializes every payload while it renders the statement, so both
 * throw whether or not the mutation goes on to match a row. Uniqueness is the opposite: the event
 * insert is gated on the decisive CTE, so a refused mutation inserts no event and raises no 23505.
 * A memory store that ran the whole preflight up front therefore threw where Postgres answered
 * "refused" — a cooldown-refused retry carrying the same `idem_key` is the ordinary case, and it is a
 * `null` in db mode and was a 23505 here.
 *
 * So the order every memory mutation follows is: **validate here → decide eligibility → return the
 * refusal → `prepareEventBatch` → mutate and append**. This is deliberately cheap and repeatable;
 * `prepareEventBatch` re-runs it on the path that does write.
 */
export function validatePreparedEvents(events: readonly PreparedEvent[] | undefined): void {
  for (const event of events ?? []) {
    validatePreparedEvent(event);
    // The payload's serializability is part of what Postgres checks before it sends anything, so a
    // cyclic payload must throw here rather than survive as far as the uniqueness check.
    normalizePayload(event.payload);
  }
}

/**
 * **The preflight. Run it BEFORE the mutation, over the COMPLETE batch** (Decision 4).
 *
 * Decision 4's memory-mode discipline is "all throwing work happens before the mutation, and the
 * mutation plus the event append then execute with no `await` between them". Checking only the kind
 * up front does not satisfy it: the payload normalization and the idempotency check can throw too,
 * and they used to run *inside* the append — so a duplicate `idem_key`, a duplicate inside one batch,
 * or a payload JSON cannot represent left the mutation applied and its events missing. Postgres does
 * the opposite: the event insert rides the mutation's own statement, so a 23505 rolls the mutation
 * back with it. Memory mode has to refuse the whole thing before anything is written, and that is
 * what this does.
 *
 * The batch is checked as a UNIT. Two events in one call carrying the same `idem_key` conflict even
 * though neither conflicts with the log, because the second would be refused only after the first had
 * already been appended — which is the same half-applied state, reached from inside.
 *
 * @throws before any state is touched. The batch it returns cannot fail to append.
 */
export function prepareEventBatch(events: readonly PreparedEvent[] | undefined): PreparedEventBatch {
  const preflighted: PreflightedEvent[] = [];
  const batchIdemKeys = new Set<string>();
  for (const event of events ?? []) {
    validatePreparedEvent(event);
    if (event.idemKey != null) {
      if (batchIdemKeys.has(event.idemKey)) throw duplicateIdemKeyError();
      batchIdemKeys.add(event.idemKey);
    }
    assertIdemKeyFree(event.idemKey);
    // Normalized HERE and kept, so the append serializes nothing: a cyclic or otherwise
    // unserializable payload is refused while the caller has still written nothing.
    preflighted.push({ source: event, payload: normalizePayload(event.payload) });
  }
  return { events: preflighted };
}

/**
 * Append a preflighted batch. **Cannot throw**, and runs in the same synchronous section as the
 * mutation it belongs to (Decision 4: no `await` between them).
 *
 * The in-process consumer dispatcher hangs here, so every prepared-event write — through an action or
 * through a domain service — reaches the consumers, which is what keeps Jest's projections identical
 * to Postgres's. It stays SYNCHRONOUS and hands its caller the dispatch promise rather than awaiting
 * it; returning the promise rather than dropping it is what forces every caller to decide, and
 * `emitEvent` awaits so the notification and activity projections are visible on return.
 */
export function appendPreparedBatch(batch: PreparedEventBatch): {
  stored: StoredEvent[];
  dispatched: Promise<void>;
} {
  const stored: StoredEvent[] = [];
  const dispatches: Promise<void>[] = [];
  for (const event of batch.events) {
    const row: StoredEvent = {
      id: eventLog.nextId++,
      kind: event.source.kind,
      actorAgentId: event.source.actorAgentId ?? null,
      subjectType: event.source.subjectType ?? null,
      subjectId: event.source.subjectId ?? null,
      secondarySubjectId: event.source.secondarySubjectId ?? null,
      schoolId: event.source.schoolId ?? null,
      idemKey: event.source.idemKey ?? null,
      payload: event.payload,
      createdAt: new Date().toISOString(),
    };
    eventLog.rows.push(row);
    while (eventLog.rows.length > EVENT_LOG_CAP) eventLog.rows.shift();
    stored.push(row);
    // Started here, in the same microtask as the push, and never awaited here. The dispatcher itself
    // cannot reject (see `memory-dispatch.ts`), so the promises are safe to await or to hold.
    dispatches.push(dispatchAppendedEvent(row));
  }
  return { stored, dispatched: Promise.all(dispatches).then(() => undefined) };
}

export async function emitEvent(event: PreparedEvent): Promise<EmittedEvent> {
  // Preflight, then append with nothing in between — the same discipline every store caller follows,
  // written out for the single-event case.
  const { stored, dispatched } = appendPreparedBatch(prepareEventBatch([event]));
  // Awaited: Decision 6 requires the notification and activity projections to be visible when the
  // emitting store call resolves. Memory ingest is not awaited — the dispatcher schedules it on its
  // own background path, so this wait is bounded by the two projection consumers.
  await dispatched;
  return { id: stored[0].id, createdAt: stored[0].createdAt };
}

export async function listEventsAfter(
  cursor: number,
  kinds?: readonly string[],
  limit?: number
): Promise<StoredEvent[]> {
  // Empty means "no filter", matching the db store: a filter matching nothing would be a different
  // answer, and callers pass a possibly-empty kind list.
  const kindFilter = kinds && kinds.length > 0 ? new Set<string>(kinds) : null;
  const cap = Math.max(1, Math.floor(limit ?? DEFAULT_EVENT_LIST_LIMIT));
  return eventLog.rows
    .filter((event) => event.id > cursor && (!kindFilter || kindFilter.has(event.kind)))
    .slice(0, cap)
    .map(cloneEvent);
}

export async function getEventById(id: number): Promise<StoredEvent | null> {
  const found = eventLog.rows.find((event) => event.id === id);
  return found ? cloneEvent(found) : null;
}
