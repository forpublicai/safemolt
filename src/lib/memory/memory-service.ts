/**
 * Facade: embeddings + vector provider + optional context indexing.
 */
import {
  getEmbedding,
  DEFAULT_EMBEDDING_MODEL,
  type EmbeddingCallOptions,
} from "../playground/embeddings";
import { getVectorMemoryProvider } from "./providers";
import type { VectorQueryResult, VectorUpsertInput } from "./types";
import * as contextStore from "./context-store";
import { normalizeContextPath } from "./context-path";
import { isSponsoredPublicAiAgent } from "./sponsored-public-ai";

const MAX_EMBED_CHARS = 12000;

/** Session user id when using dashboard; null for API-key-only requests. */
export type MemoryRequestContext = {
  sessionUserId: string | null;
};

async function embeddingOptions(
  agentId: string,
  sessionUserId: string | null
): Promise<EmbeddingCallOptions | undefined> {
  if (!sessionUserId) return undefined;
  if (await isSponsoredPublicAiAgent(agentId)) {
    return { sponsoredInference: { userId: sessionUserId, agentId } };
  }
  return undefined;
}

function indexContextEnabled(): boolean {
  return process.env.MEMORY_INDEX_CONTEXT_FILES === "true";
}

export async function upsertVectorForAgent(
  agentId: string,
  id: string,
  text: string,
  metadata?: Record<string, unknown>,
  ctx?: MemoryRequestContext
): Promise<void> {
  const embedding = await getEmbedding(
    text.slice(0, MAX_EMBED_CHARS),
    DEFAULT_EMBEDDING_MODEL,
    await embeddingOptions(agentId, ctx?.sessionUserId ?? null)
  );
  const doc: VectorUpsertInput = {
    id,
    agentId,
    text,
    embedding,
    metadata: { ...metadata, source: "api" },
  };
  await getVectorMemoryProvider().upsert([doc]);
}

export async function queryVectorsForAgent(
  agentId: string,
  query: string,
  limit = 10,
  ctx?: MemoryRequestContext
): Promise<VectorQueryResult[]> {
  const embedding = await getEmbedding(
    query.slice(0, MAX_EMBED_CHARS),
    DEFAULT_EMBEDDING_MODEL,
    await embeddingOptions(agentId, ctx?.sessionUserId ?? null)
  );
  return getVectorMemoryProvider().query({
    agentId,
    queryEmbedding: embedding,
    limit,
  });
}

export async function deleteVectorsByIds(ids: string[]): Promise<void> {
  await getVectorMemoryProvider().deleteByIds(ids);
}

export async function vectorHealth(): Promise<boolean> {
  return getVectorMemoryProvider().healthCheck();
}

export async function putContextAndMaybeIndex(
  agentId: string,
  rawPath: string,
  content: string,
  ctx?: MemoryRequestContext
): Promise<{ path: string } | { error: string }> {
  const path = normalizeContextPath(rawPath);
  if (!path) return { error: "invalid_path" };
  await contextStore.putContextFile(agentId, path, content);
  if (indexContextEnabled()) {
    const id = `ctx_${agentId}_${encodeURIComponent(path)}`;
    try {
      await upsertVectorForAgent(
        agentId,
        id,
        content.slice(0, MAX_EMBED_CHARS),
        {
          kind: "context_file",
          path,
        },
        ctx
      );
    } catch (e) {
      console.error("[memory] context index failed:", e);
    }
  }
  return { path };
}

export async function deleteContextAndIndex(
  agentId: string,
  rawPath: string,
  ctx?: MemoryRequestContext
): Promise<{ ok: boolean; error?: string }> {
  const path = normalizeContextPath(rawPath);
  if (!path) return { ok: false, error: "invalid_path" };
  await contextStore.deleteContextFile(agentId, path);
  if (indexContextEnabled()) {
    const id = `ctx_${agentId}_${encodeURIComponent(path)}`;
    try {
      await deleteVectorsByIds([id]);
    } catch {
      /* ignore */
    }
  }
  return { ok: true };
}
