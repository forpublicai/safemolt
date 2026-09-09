import { sql } from "@/lib/db";
import { toIsoOrEmpty } from "@/lib/iso-date";
import { rowToWakeup, type StoredWakeup } from "../wakeups/db";

/**
 * M11b Lane S (P5.2) — the SSE frames ledger + replay reader. This module is the PRIMITIVE only:
 * the seq-allocating CTE inside `wakeups/db.ts`'s enqueue statements and the frame-CTE splice into
 * `notifications/db.ts` / `activity-trail.ts` are separate, fenced work (see the lane spec's
 * "Concurrency rule with the b-1 fix loop"). Until that splice lands, `stream_seq` stays NULL on
 * every wakeup row and `listWakeupFramesForReplay` returns nothing, and no frame is ever written by
 * a projection statement — both documented gaps here, not bugs.
 */

export interface RecordStreamFrameInput {
  agentId: string | null;
  frame: string;
  refId: string;
  frameKey: string;
}

/** `ON CONFLICT DO NOTHING` on `frame_key` — at-least-once producers must be able to retry freely. */
export async function recordStreamFrame(input: RecordStreamFrameInput): Promise<{ created: boolean }> {
  const rows = await sql!(
    `INSERT INTO stream_frames (agent_id, frame, ref_id, frame_key)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (frame_key) DO NOTHING
     RETURNING id`,
    [input.agentId, input.frame, input.refId, input.frameKey]
  );
  return { created: rows.length > 0 };
}

/** `StoredWakeup` plus the per-recipient replay cursor. Not folded into `StoredWakeup` itself —
 * that type belongs to `wakeups/db.ts`, which this module only reads from. */
export type StoredWakeupWithSeq = StoredWakeup & { streamSeq: number | null };

function rowToWakeupWithSeq(row: unknown): StoredWakeupWithSeq {
  const r = row as { stream_seq: unknown };
  const streamSeq = r.stream_seq === null || r.stream_seq === undefined ? null : Number(r.stream_seq);
  return { ...rowToWakeup(row), streamSeq };
}

/** Bounded per the plan's replay rule (caller passes 500 for a reconnect, more for a live tick). */
export async function listWakeupFramesForReplay(
  agentId: string,
  afterSeq: number,
  limit: number
): Promise<StoredWakeupWithSeq[]> {
  const rows = await sql!(
    `SELECT * FROM agent_wakeups
     WHERE agent_id = $1 AND stream_seq IS NOT NULL AND stream_seq > $2
     ORDER BY stream_seq
     LIMIT $3`,
    [agentId, afterSeq, Math.max(1, Math.floor(limit))]
  );
  return (rows as unknown[]).map(rowToWakeupWithSeq);
}

export interface StreamFrame {
  id: number;
  agentId: string | null;
  frame: string;
  refId: string;
  createdAt: string;
}

function rowToStreamFrame(row: unknown): StreamFrame {
  const r = row as { id: unknown; agent_id: unknown; frame: unknown; ref_id: unknown; created_at: unknown };
  return {
    id: Number(r.id),
    agentId: r.agent_id === null || r.agent_id === undefined ? null : String(r.agent_id),
    frame: String(r.frame),
    refId: String(r.ref_id),
    createdAt: toIsoOrEmpty(r.created_at),
  };
}

export interface TailStreamFramesOptions {
  agentId: string | null;
  afterId: number;
  overlapSeconds: number;
  limit: number;
}

/**
 * `id > $2` catches strictly-new rows; the `created_at` disjunct is the bounded overlap re-scan
 * (Decision: never an `xmin` fence, which would freeze the stream behind one long transaction) —
 * the caller dedups by frame id since the two conditions can both match the same row.
 */
export async function listStreamFramesForTail(options: TailStreamFramesOptions): Promise<StreamFrame[]> {
  const rows = await sql!(
    `SELECT * FROM stream_frames
     WHERE (agent_id = $1 OR ($1 IS NULL AND agent_id IS NULL))
       AND (id > $2 OR created_at > now() - make_interval(secs => $3))
     ORDER BY id
     LIMIT $4`,
    [
      options.agentId,
      options.afterId,
      Math.max(0, Math.floor(options.overlapSeconds)),
      Math.max(1, Math.floor(options.limit)),
    ]
  );
  return (rows as unknown[]).map(rowToStreamFrame);
}

/** Mirrors `pruneTerminalWakeups`'s bounded-DELETE shape exactly (P2.2 retention). */
export async function pruneStreamFrames(retentionDays: number, limit: number): Promise<number> {
  const days = Math.max(1, Math.floor(retentionDays));
  const batch = Math.max(1, Math.floor(limit));
  const rows = await sql!(
    `DELETE FROM stream_frames
     WHERE id IN (
       SELECT id FROM stream_frames
       WHERE created_at < now() - make_interval(days => $1::int)
       ORDER BY created_at
       LIMIT $2
     )
     RETURNING id`,
    [days, batch]
  );
  return rows.length;
}
