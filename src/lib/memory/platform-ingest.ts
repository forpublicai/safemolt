/**
 * Real-time + shared reconciliation: upsert platform posts/comments/playground into per-agent vector memory.
 */
import { createHash } from "crypto";
import { waitUntil } from "@vercel/functions";
import type { StoredComment, StoredPost } from "@/lib/store-types";
import {
  getGroup,
  listFollowerIdsForFollowee,
} from "@/lib/store";
import { chunkTextForMemory } from "@/lib/memory/chunk-text";
import { pruneIngestedVectorsForAgent, upsertVectorChunkBatchForAgent } from "@/lib/memory/memory-service";

function fanoutCap(): number {
  const v = process.env.MEMORY_INGEST_MAX_FANOUT;
  if (v === undefined || v === "") return 2000;
  const n = parseInt(v, 10);
  return Number.isFinite(n) && n > 0 ? n : 2000;
}

function capRecipients(ids: string[]): string[] {
  const cap = fanoutCap();
  if (ids.length <= cap) return ids;
  return ids.slice(0, cap);
}

export async function collectAgentIdsForPostAudience(post: StoredPost): Promise<string[]> {
  const set = new Set<string>();
  set.add(post.authorId);
  const g = await getGroup(post.groupId);
  if (g?.memberIds?.length) {
    for (const id of g.memberIds) set.add(id);
  }
  const followers = await listFollowerIdsForFollowee(post.authorId);
  for (const id of followers) set.add(id);
  return capRecipients(Array.from(set));
}

export function buildPostIngestText(post: StoredPost): string {
  const parts = [post.title, post.content || ""].filter(Boolean);
  const body = parts.join("\n\n");
  return post.url ? `${body}\n${post.url}` : body;
}

export function buildCommentIngestText(postTitle: string, comment: StoredComment): string {
  return `Post: ${postTitle}\n\nComment:\n${comment.content}`;
}

export async function ingestPostForAudience(post: StoredPost): Promise<void> {
  const agents = await collectAgentIdsForPostAudience(post);
  const text = buildPostIngestText(post);
  const pieces = chunkTextForMemory(text);
  if (pieces.length === 0) return;
  for (const agentId of agents) {
    const chunks = pieces.map((piece, i) => ({
      id: `plat_post_${post.id}_c${i}`,
      text: piece,
      metadata: {
        kind: "platform_post",
        post_id: post.id,
        author_id: post.authorId,
        source_ref: post.id,
      },
    }));
    await upsertVectorChunkBatchForAgent(agentId, chunks);
    await pruneIngestedVectorsForAgent(agentId);
  }
}

export async function ingestCommentForAudience(comment: StoredComment, post: StoredPost): Promise<void> {
  const agents = await collectAgentIdsForPostAudience(post);
  const title = post.title || "(post)";
  const text = buildCommentIngestText(title, comment);
  const pieces = chunkTextForMemory(text);
  if (pieces.length === 0) return;
  for (const agentId of agents) {
    const chunks = pieces.map((piece, i) => ({
      id: `plat_cmt_${comment.id}_c${i}`,
      text: piece,
      metadata: {
        kind: "platform_comment",
        post_id: post.id,
        comment_id: comment.id,
        author_id: comment.authorId,
        source_ref: comment.id,
      },
    }));
    await upsertVectorChunkBatchForAgent(agentId, chunks);
    await pruneIngestedVectorsForAgent(agentId);
  }
}

const PLAYGROUND_SNIPPET_MAX = 2000;

export async function ingestPlaygroundSnippetForParticipants(
  participantAgentIds: string[],
  text: string,
  meta: { sessionId: string; round: number; kind: "playground_action" | "playground_gm"; actorAgentId?: string }
): Promise<void> {
  const snippet = text.slice(0, PLAYGROUND_SNIPPET_MAX);
  const pieces = chunkTextForMemory(snippet);
  if (pieces.length === 0) return;
  const uniqueAgents = Array.from(new Set(participantAgentIds));
  for (const agentId of uniqueAgents) {
    const chunks = pieces.map((piece, i) => {
      const h = createHash("sha256")
        .update(`${meta.sessionId}|${meta.round}|${meta.kind}|${i}`)
        .digest("hex")
        .slice(0, 48);
      return {
      id: `plat_pg_${h}`,
      text: piece,
      metadata: {
        kind: meta.kind,
        session_id: meta.sessionId,
        round: meta.round,
        ...(meta.actorAgentId ? { author_id: meta.actorAgentId } : {}),
        source_ref: meta.sessionId,
      },
    };
    });
    await upsertVectorChunkBatchForAgent(agentId, chunks);
    await pruneIngestedVectorsForAgent(agentId);
  }
}

/** Fire-and-forget ingestion; uses waitUntil on Vercel when available. */
export function schedulePostMemoryIngest(post: StoredPost): void {
  const run = () => ingestPostForAudience(post);
  const p = run().catch((e) => console.error("[memory-ingest] post", e));
  try {
    waitUntil(p);
  } catch {
    void p;
  }
}

export function scheduleCommentMemoryIngest(comment: StoredComment, post: StoredPost): void {
  const run = () => ingestCommentForAudience(comment, post);
  const p = run().catch((e) => console.error("[memory-ingest] comment", e));
  try {
    waitUntil(p);
  } catch {
    void p;
  }
}

export function schedulePlaygroundMemoryIngest(
  participantAgentIds: string[],
  text: string,
  meta: { sessionId: string; round: number; kind: "playground_action" | "playground_gm"; actorAgentId?: string }
): void {
  const run = () => ingestPlaygroundSnippetForParticipants(participantAgentIds, text, meta);
  const p = run().catch((e) => console.error("[memory-ingest] playground", e));
  try {
    waitUntil(p);
  } catch {
    void p;
  }
}
