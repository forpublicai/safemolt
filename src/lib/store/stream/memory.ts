import { streamFrames, wakeupQueue } from "../_memory-state";
import type { StoredWakeup } from "../wakeups/db";
import type {
  RecordStreamFrameInput,
  StoredWakeupWithSeq,
  StreamFrame,
  TailStreamFramesOptions,
} from "./db";

/** Memory twin of `store/stream/db.ts` — see that file's header for the scope of this primitive. */

export async function recordStreamFrame(input: RecordStreamFrameInput): Promise<{ created: boolean }> {
  if (streamFrames.byKey.has(input.frameKey)) return { created: false };
  const id = streamFrames.nextId++;
  streamFrames.rows.set(id, { id, ...input, createdAt: new Date().toISOString() });
  streamFrames.byKey.set(input.frameKey, id);
  return { created: true };
}

/**
 * `wakeupQueue` rows carry no `streamSeq` field until the enqueue-side splice lands (fenced), so
 * this reads it defensively as an optional property — always absent today, which is why this always
 * returns `[]` for now (the documented gap; the query shape is correct for when the splice lands).
 */
export async function listWakeupFramesForReplay(
  agentId: string,
  afterSeq: number,
  limit: number
): Promise<StoredWakeupWithSeq[]> {
  const rows = Array.from(wakeupQueue.rows.values()) as Array<StoredWakeup & { streamSeq?: number | null }>;
  return rows
    .filter((w) => w.agentId === agentId && typeof w.streamSeq === "number" && w.streamSeq > afterSeq)
    .sort((a, b) => (a.streamSeq as number) - (b.streamSeq as number))
    .slice(0, Math.max(1, Math.floor(limit)))
    .map((w) => ({ ...w, streamSeq: w.streamSeq ?? null }));
}

/** Mirrors the db query's two conditions (`id >` OR within the overlap window). */
export async function listStreamFramesForTail(options: TailStreamFramesOptions): Promise<StreamFrame[]> {
  const cutoffMs = Date.now() - Math.max(0, Math.floor(options.overlapSeconds)) * 1000;
  return Array.from(streamFrames.rows.values())
    .filter((f) => f.agentId === options.agentId && (f.id > options.afterId || Date.parse(f.createdAt) > cutoffMs))
    .sort((a, b) => a.id - b.id)
    .slice(0, Math.max(1, Math.floor(options.limit)))
    .map(({ id, agentId, frame, refId, createdAt }) => ({ id, agentId, frame, refId, createdAt }));
}

export async function pruneStreamFrames(retentionDays: number, limit: number): Promise<number> {
  const cutoffMs = Date.now() - Math.max(1, Math.floor(retentionDays)) * 24 * 60 * 60 * 1000;
  const toDelete = Array.from(streamFrames.rows.values())
    .filter((f) => Date.parse(f.createdAt) < cutoffMs)
    .sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt))
    .slice(0, Math.max(1, Math.floor(limit)));
  for (const f of toDelete) {
    streamFrames.rows.delete(f.id);
    streamFrames.byKey.delete(f.frameKey);
  }
  return toDelete.length;
}
