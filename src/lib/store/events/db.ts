import { sql } from "@/lib/db";
import type { PreparedEvent } from "@/lib/events/kinds";
import { toIsoOrEmpty } from "@/lib/iso-date";
import type { StoredEvent } from "@/lib/store-types";

import { preparedEventValues, validatePreparedEvent } from "./statement";

/** Page size for the general reader when a caller states none. Shared with the memory store. */
export const DEFAULT_EVENT_LIST_LIMIT = 100;

/**
 * What an emit hands back: the id, and the timestamp the row was stamped with.
 *
 * Both are needed by a producer, and neither is recoverable afterwards without a second read. The
 * id keys the notification dedup string; `createdAt` is the instant a consumer will project as a
 * follow activity's `occurred_at`, so u3's transitional inline writer stamps it into the legacy
 * projection too and the two writers agree on one clock. See `emitEventStatement`.
 */
export interface EmittedEvent {
  id: number;
  createdAt: string;
}

/** The one `SELECT` list every read of `events` uses, so no reader can drift from the mapper. */
const EVENT_SELECT = `
  id, kind, actor_agent_id, subject_type, subject_id, secondary_subject_id,
  school_id, idem_key, payload, created_at
`;

interface EventRow {
  id: number | string;
  kind: string;
  actor_agent_id: string | null;
  subject_type: string | null;
  subject_id: string | null;
  secondary_subject_id: string | null;
  school_id: string | null;
  idem_key: string | null;
  payload: Record<string, unknown> | null;
  created_at: unknown;
}

/**
 * `id` is BIGSERIAL and arrives as a string from both drivers, so every read normalizes it once,
 * here. Consumers compare ids numerically (`id > activation_cutoff`) and a string comparison there
 * would order `"10" < "9"`.
 */
export function rowToEvent(row: unknown): StoredEvent {
  const r = row as EventRow;
  return {
    id: Number(r.id),
    kind: r.kind,
    actorAgentId: r.actor_agent_id,
    subjectType: r.subject_type,
    subjectId: r.subject_id,
    secondarySubjectId: r.secondary_subject_id,
    schoolId: r.school_id,
    idemKey: r.idem_key,
    payload: r.payload ?? {},
    createdAt: toIsoOrEmpty(r.created_at),
  };
}

/**
 * Insert one event on its own.
 *
 * **Infrastructure emissions only.** Today that is the consumer activation fence; P3.2's synthetic
 * bridge joins it later. An ordinary mutation must NOT emit through this function: a free-standing
 * insert beside a mutation is atomic at commit but still writes a ghost event when a concurrent
 * racer turns the mutation into a no-op. Those events ride their own statement via
 * `emitEventStatement`, gated on the decisive CTE (Decision 2).
 */
export async function emitEvent(event: PreparedEvent): Promise<EmittedEvent> {
  validatePreparedEvent(event);
  const values = preparedEventValues(event);
  const rows = await sql!(
    `INSERT INTO events (kind, actor_agent_id, subject_type, subject_id, secondary_subject_id,
                         school_id, idem_key, payload)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb)
     RETURNING id, created_at`,
    values
  );
  const row = rows[0] as { id: number | string; created_at: unknown };
  return { id: Number(row.id), createdAt: toIsoOrEmpty(row.created_at) };
}

/** Events after `cursor` in id order — the general reader. The drain uses its own anti-join scan. */
export async function listEventsAfter(
  cursor: number,
  kinds?: readonly string[],
  limit?: number
): Promise<StoredEvent[]> {
  // An empty array means "no kinds asked for", which must read as "no filter" rather than as a
  // filter matching nothing — the same normalization the memory store applies.
  const kindFilter = kinds && kinds.length > 0 ? [...kinds] : null;
  const rows = await sql!(
    `SELECT ${EVENT_SELECT}
     FROM events
     WHERE id > $1 AND ($2::text[] IS NULL OR kind = ANY($2::text[]))
     ORDER BY id
     LIMIT $3`,
    [cursor, kindFilter, Math.max(1, Math.floor(limit ?? DEFAULT_EVENT_LIST_LIMIT))]
  );
  return (rows as unknown[]).map(rowToEvent);
}

export async function getEventById(id: number): Promise<StoredEvent | null> {
  const rows = await sql!(`SELECT ${EVENT_SELECT} FROM events WHERE id = $1`, [id]);
  return rows.length > 0 ? rowToEvent(rows[0]) : null;
}
