/**
 * Periodic reconciliation: process posts/comments after watermark, idempotent upserts.
 */
import type { StoredComment, StoredPost } from "@/lib/store-types";
import {
  getMemoryIngestWatermark,
  getPost,
  listCommentsCreatedAfter,
  listPostsCreatedAfter,
  setMemoryIngestWatermark,
} from "@/lib/store";
import { ingestCommentForAudience, ingestPostForAudience } from "@/lib/memory/platform-ingest";

type Timed = { at: string; kind: "post" | "comment"; post?: StoredPost; comment?: StoredComment };

function maxIso(a: string, b: string): string {
  return Date.parse(a) >= Date.parse(b) ? a : b;
}

export async function runMemoryReconciliationBatch(): Promise<{ processed: number; watermark: string }> {
  const wm = await getMemoryIngestWatermark();
  const limit = Math.min(500, parseInt(process.env.MEMORY_INGEST_BATCH_SIZE || "300", 10) || 300);
  const posts = await listPostsCreatedAfter(wm, limit);
  const comments = await listCommentsCreatedAfter(wm, limit);
  const events: Timed[] = [
    ...posts.map((p) => ({ at: p.createdAt, kind: "post" as const, post: p })),
    ...comments.map((c) => ({ at: c.createdAt, kind: "comment" as const, comment: c })),
  ].sort((x, y) => Date.parse(x.at) - Date.parse(y.at));

  let processed = 0;
  const cap = Math.min(500, events.length);

  for (let i = 0; i < cap; i++) {
    const e = events[i];
    if (!e) continue;
    if (e.kind === "post" && e.post) {
      await ingestPostForAudience(e.post);
      processed++;
    } else if (e.kind === "comment" && e.comment) {
      const post = await getPost(e.comment.postId);
      if (post) {
        await ingestCommentForAudience(e.comment, post);
        processed++;
      }
    }
  }

  let newWatermark = wm;
  if (cap > 0) {
    const last = events[cap - 1];
    if (last) newWatermark = maxIso(wm, last.at);
    await setMemoryIngestWatermark(newWatermark);
  }

  return { processed, watermark: newWatermark };
}
