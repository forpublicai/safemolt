/**
 * Facade: vector provider + optional context indexing + FTS sidecar.
 * Chroma: per-agent collection, server-side embeddings (no HF). Mock: deterministic hash vectors.
 */
import { createHash } from "crypto";
import { getVectorMemoryProvider } from "./providers";
import type { VectorQueryResult, VectorUpsertInput } from "./types";
import * as contextStore from "./context-store";
import { normalizeContextPath } from "./context-path";
import { normalizeMemoryMetadata } from "./metadata";
import { chunkTextForMemory, type ChunkTextOptions } from "./chunk-text";
import { memoryDeterministicChunkId } from "./memory-id";
import * as memoryFts from "./memory-fts-db";
import { chromaCollectionNameForAgent } from "./chroma-collection-name";

const MAX_EMBED_CHARS = 12000;
const MAX_MEMORY_TEXT_CHARS = 200_000;
const MOCK_EMBED_DIM = 64;

const RRF_K = 60;

/** Session user id when using dashboard; null for API-key-only requests. */
export type MemoryRequestContext = {
  sessionUserId: string | null;
};

export type UpsertMemoryOptions = {
  chunk?: boolean;
  parent_id?: string;
  dedup_mode?: "off" | "skip" | "replace";
  chunking?: ChunkTextOptions;
};

function isChromaBackend(): boolean {
  return (process.env.MEMORY_VECTOR_BACKEND || "mock").toLowerCase() === "chroma";
}

/** Deterministic pseudo-embedding for mock provider and hybrid leg consistency. */
export function mockEmbeddingFromText(text: string): number[] {
  const h = createHash("sha256").update(text, "utf8").digest();
  const out: number[] = [];
  for (let i = 0; i < MOCK_EMBED_DIM; i++) {
    out.push((h[i % h.length]! - 127.5) / 127.5);
  }
  return out;
}

function indexContextEnabled(): boolean {
  return process.env.MEMORY_INDEX_CONTEXT_FILES === "true";
}

function dedupMinScore(): number {
  const v = process.env.MEMORY_DEDUP_MIN_SCORE;
  if (v === undefined || v === "") return 0.92;
  const n = Number(v);
  return Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : 0.92;
}

function filedAtSortKey(meta: Record<string, unknown>): number {
  const fa = meta.filed_at;
  if (typeof fa === "string") {
    const t = Date.parse(fa);
    return Number.isFinite(t) ? t : 0;
  }
  return 0;
}

async function syncFtsForDocs(agentId: string, docs: VectorUpsertInput[]): Promise<void> {
  for (const d of docs) {
    await memoryFts.syncMemoryFtsRow(agentId, d.id, d.text);
  }
}

export async function upsertVectorForAgent(
  agentId: string,
  id: string,
  text: string,
  metadata?: Record<string, unknown>,
  _ctx?: MemoryRequestContext,
  opts?: UpsertMemoryOptions
): Promise<void> {
  if (text.length > MAX_MEMORY_TEXT_CHARS) {
    throw new Error(`Memory text exceeds max length (${MAX_MEMORY_TEXT_CHARS} chars)`);
  }

  const dedup = opts?.dedup_mode ?? "off";
  if (dedup === "skip" || dedup === "replace") {
    const probe = text.slice(0, MAX_EMBED_CHARS);
    const near = isChromaBackend()
      ? await getVectorMemoryProvider().query({
          agentId,
          queryText: probe,
          limit: 5,
        })
      : await getVectorMemoryProvider().query({
          agentId,
          queryEmbedding: mockEmbeddingFromText(probe),
          limit: 5,
        });
    const best = near[0];
    if (best && best.score >= dedupMinScore()) {
      if (dedup === "skip") {
        return;
      }
      await deleteVectorsForAgent(agentId, [best.id]);
    }
  }

  const normBase = normalizeMemoryMetadata(metadata, { source: "api" });
  const chroma = isChromaBackend();

  if (opts?.chunk) {
    const parentKey = opts.parent_id ?? id;
    const pieces = chunkTextForMemory(text, opts.chunking);
    if (pieces.length === 0) {
      return;
    }
    const docs: VectorUpsertInput[] = [];
    for (let i = 0; i < pieces.length; i++) {
      const chunkId = memoryDeterministicChunkId(agentId, parentKey, i);
      const piece = pieces[i];
      if (!piece) continue;
      const meta = normalizeMemoryMetadata(
        { ...metadata, chunk_index: i, parent_id: parentKey, kind: metadata?.kind ?? "note" },
        { source: "api" }
      );
      if (chroma) {
        docs.push({ id: chunkId, agentId, text: piece, metadata: meta });
      } else {
        docs.push({
          id: chunkId,
          agentId,
          text: piece,
          embedding: mockEmbeddingFromText(piece.slice(0, MAX_EMBED_CHARS)),
          metadata: meta,
        });
      }
    }
    await getVectorMemoryProvider().upsert(docs);
    await syncFtsForDocs(agentId, docs);
    return;
  }

  if (chroma) {
    const doc: VectorUpsertInput = { id, agentId, text, metadata: normBase };
    await getVectorMemoryProvider().upsert([doc]);
    await syncFtsForDocs(agentId, [doc]);
    return;
  }

  const doc: VectorUpsertInput = {
    id,
    agentId,
    text,
    embedding: mockEmbeddingFromText(text.slice(0, MAX_EMBED_CHARS)),
    metadata: normBase,
  };
  await getVectorMemoryProvider().upsert([doc]);
  await syncFtsForDocs(agentId, [doc]);
}

/** Batch upsert with explicit ids (platform / ingestion). Skips dedup and chunking. */
export async function upsertVectorChunkBatchForAgent(
  agentId: string,
  chunks: { id: string; text: string; metadata?: Record<string, unknown> }[]
): Promise<void> {
  if (chunks.length === 0) return;
  const chroma = isChromaBackend();
  const docs: VectorUpsertInput[] = [];
  for (const c of chunks) {
    if (c.text.length > MAX_MEMORY_TEXT_CHARS) continue;
    const meta = normalizeMemoryMetadata(c.metadata ?? {}, { source: "platform" });
    if (chroma) {
      docs.push({ id: c.id, agentId, text: c.text, metadata: meta });
    } else {
      docs.push({
        id: c.id,
        agentId,
        text: c.text,
        embedding: mockEmbeddingFromText(c.text.slice(0, MAX_EMBED_CHARS)),
        metadata: meta,
      });
    }
  }
  if (docs.length === 0) return;
  await getVectorMemoryProvider().upsert(docs);
  await syncFtsForDocs(agentId, docs);
}

export async function queryVectorsForAgent(
  agentId: string,
  query: string,
  _limit = 10,
  _ctx?: MemoryRequestContext,
  threshold?: number
): Promise<VectorQueryResult[]> {
  const limit = _limit;
  const slice = query.slice(0, MAX_EMBED_CHARS);
  if (isChromaBackend()) {
    return getVectorMemoryProvider().query({
      agentId,
      queryText: slice,
      limit,
      ...(threshold !== undefined ? { threshold } : {}),
    });
  }
  return getVectorMemoryProvider().query({
    agentId,
    queryEmbedding: mockEmbeddingFromText(slice),
    limit,
    ...(threshold !== undefined ? { threshold } : {}),
  });
}

export type RecallMode = "hot" | "semantic";

export async function recallMemoryForAgent(
  agentId: string,
  mode: RecallMode,
  query: string,
  limit: number,
  ctx?: MemoryRequestContext,
  kind?: string
): Promise<VectorQueryResult[]> {
  if (mode === "semantic") {
    return queryVectorsForAgent(agentId, query, limit, ctx);
  }
  const scanLimit = Math.min(2000, Math.max(limit * 50, 200));
  const rows = await getVectorMemoryProvider().listAgentRecords({
    agentId,
    limit: scanLimit,
    kind,
  });
  const sorted = [...rows].sort((a, b) => {
    const imp = b.score - a.score;
    if (imp !== 0) return imp;
    return filedAtSortKey(b.metadata) - filedAtSortKey(a.metadata);
  });
  return sorted.slice(0, limit);
}

export const PUBLIC_PLATFORM_MEMORY_KINDS = [
  "platform_post",
  "platform_comment",
  "playground_action",
  "playground_gm",
  "agent_loop_action",
] as const;

export type PublicPlatformMemoryKind = (typeof PUBLIC_PLATFORM_MEMORY_KINDS)[number];

const publicPlatformMemoryKindSet = new Set<string>(PUBLIC_PLATFORM_MEMORY_KINDS);

export type PublicPlatformMemory = {
  id: string;
  text: string;
  kind: PublicPlatformMemoryKind;
  filedAt?: string;
  metadata: Record<string, unknown>;
};

export function isPublicPlatformMemoryKind(kind: unknown): kind is PublicPlatformMemoryKind {
  return typeof kind === "string" && publicPlatformMemoryKindSet.has(kind);
}

export async function listPublicPlatformMemoriesForAgent(
  agentId: string,
  limit = 10
): Promise<PublicPlatformMemory[]> {
  const rows = await getVectorMemoryProvider().listAgentRecords({
    agentId,
    limit: Math.min(1000, Math.max(limit * 20, 100)),
  });
  const publicRows = rows
    .filter((r) => isPublicPlatformMemoryKind(r.metadata?.kind))
    .sort((a, b) => filedAtSortKey(b.metadata) - filedAtSortKey(a.metadata))
    .slice(0, limit);

  return publicRows.map((r) => ({
    id: r.id,
    text: r.text,
    kind: r.metadata.kind as PublicPlatformMemoryKind,
    filedAt: typeof r.metadata.filed_at === "string" ? r.metadata.filed_at : undefined,
    metadata: r.metadata,
  }));
}

export async function queryVectorsHybridForAgent(
  agentId: string,
  query: string,
  limit = 10,
  ctx?: MemoryRequestContext
): Promise<VectorQueryResult[]> {
  const semLimit = Math.min(30, Math.max(limit * 3, limit));
  const semantic = await queryVectorsForAgent(agentId, query, semLimit, ctx);
  const ftsHits = await memoryFts.searchMemoryFts(agentId, query, semLimit);

  const rrf = new Map<string, number>();
  semantic.forEach((_, i) => {
    const id = semantic[i]!.id;
    rrf.set(id, (rrf.get(id) ?? 0) + 1 / (RRF_K + i + 1));
  });
  ftsHits.forEach((h, i) => {
    rrf.set(h.vectorId, (rrf.get(h.vectorId) ?? 0) + 1 / (RRF_K + i + 1));
  });

  const ids = Array.from(rrf.keys()).sort((a, b) => (rrf.get(b) ?? 0) - (rrf.get(a) ?? 0)).slice(0, limit);

  const byId = new Map<string, VectorQueryResult>();
  for (const r of semantic) {
    byId.set(r.id, r);
  }
  const missing = ids.filter((id) => !byId.has(id));
  if (missing.length > 0) {
    const fetched = await getVectorMemoryProvider().getByIdsForAgent(agentId, missing);
    for (const r of fetched) {
      byId.set(r.id, { ...r, score: rrf.get(r.id) ?? r.score });
    }
  }

  return ids.map((id) => {
    const r = byId.get(id);
    if (r) {
      return { ...r, score: rrf.get(id) ?? r.score };
    }
    return {
      id,
      text: "",
      score: rrf.get(id) ?? 0,
      metadata: {},
    };
  });
}

export async function deleteVectorsForAgent(agentId: string, ids: string[]): Promise<void> {
  await getVectorMemoryProvider().deleteByIdsForAgent(agentId, ids);
  await memoryFts.removeMemoryFtsRows(agentId, ids);
}

/** Prune oldest platform/playground vectors when over MEMORY_INGEST_MAX_VECTORS_PER_AGENT. */
export async function pruneIngestedVectorsForAgent(agentId: string): Promise<void> {
  const maxRaw = process.env.MEMORY_INGEST_MAX_VECTORS_PER_AGENT;
  const max = maxRaw ? parseInt(maxRaw, 10) : 20_000;
  if (!Number.isFinite(max) || max <= 0) return;
  const rows = await getVectorMemoryProvider().listAgentRecords({ agentId, limit: 100_000 });
  const plat = rows.filter((r) => {
    const k = String(r.metadata?.kind ?? "");
    return k.startsWith("platform_") || k.startsWith("playground_");
  });
  if (plat.length <= max) return;
  plat.sort((a, b) => filedAtSortKey(a.metadata) - filedAtSortKey(b.metadata));
  const overflow = plat.length - max;
  const victims = plat.slice(0, overflow).map((r) => r.id);
  if (victims.length > 0) {
    await deleteVectorsForAgent(agentId, victims);
  }
}

export async function vectorHealth(): Promise<boolean> {
  return getVectorMemoryProvider().healthCheck();
}

const DASHBOARD_MEMORY_SCAN_LIMIT = 4000;

function kindLabelForDashboard(kind: string): string {
  if (!kind) return "Notes & other";
  if (kind === "context_file") return "Context files";
  if (kind === "platform_post") return "Posts";
  if (kind === "platform_comment") return "Comments";
  if (kind === "playground_action") return "Playground (actions)";
  if (kind === "playground_gm") return "Playground (GM)";
  if (kind.startsWith("playground_")) return "Playground";
  if (kind.startsWith("platform_")) return kind.replace(/^platform_/, "Platform · ");
  if (kind === "note") return "Notes";
  return kind;
}

function previewText(text: string, max = 96): string {
  const t = text.replace(/\s+/g, " ").trim();
  if (t.length <= max) return t;
  return `${t.slice(0, max - 1)}…`;
}

export type AgentVectorMemoryDashboardSummary =
  | {
      ok: true;
      totalChunks: number;
      capped: boolean;
      kindBreakdown: { label: string; count: number }[];
      recent: { label: string; preview: string }[];
    }
  | { ok: false; error: string };

/**
 * Lightweight scan for dashboard: kind counts + a few recent snippets per agent.
 */
export async function summarizeAgentVectorMemoryForDashboard(
  agentId: string
): Promise<AgentVectorMemoryDashboardSummary> {
  try {
    const rows = await getVectorMemoryProvider().listAgentRecords({
      agentId,
      limit: DASHBOARD_MEMORY_SCAN_LIMIT,
    });
    const capped = rows.length >= DASHBOARD_MEMORY_SCAN_LIMIT;
    const byKind = new Map<string, number>();
    for (const r of rows) {
      const k = typeof r.metadata?.kind === "string" && r.metadata.kind.length > 0 ? r.metadata.kind : "note";
      byKind.set(k, (byKind.get(k) ?? 0) + 1);
    }
    const kindBreakdown = Array.from(byKind.entries())
      .map(([key, count]) => ({ label: kindLabelForDashboard(key), count }))
      .sort((a, b) => b.count - a.count);

    const sortedRecent = [...rows].sort((a, b) => filedAtSortKey(b.metadata) - filedAtSortKey(a.metadata));
    const recent = sortedRecent.slice(0, 4).map((r) => {
      const k = typeof r.metadata?.kind === "string" && r.metadata.kind.length > 0 ? r.metadata.kind : "note";
      return { label: kindLabelForDashboard(k), preview: previewText(r.text) };
    });

    return {
      ok: true,
      totalChunks: rows.length,
      capped,
      kindBreakdown,
      recent,
    };
  } catch (e) {
    const msg = e instanceof Error ? e.message : "Could not read vector memory";
    return { ok: false, error: msg };
  }
}

/** Full export for dashboard download (documents + metadata; no embedding vectors). */
export async function exportVectorMemoryRowsForAgent(agentId: string): Promise<
  { id: string; document: string; metadata: Record<string, unknown> }[]
> {
  const rows = await getVectorMemoryProvider().listAgentRecords({ agentId, limit: 100_000 });
  return rows.map((r) => ({ id: r.id, document: r.text, metadata: r.metadata }));
}

export function vectorBackendId(): string {
  return (process.env.MEMORY_VECTOR_BACKEND || "mock").toLowerCase();
}

/** Human-readable collection naming pattern (per-agent). */
export function chromaCollectionPattern(): string {
  return "safemolt_agent_{agent_id}";
}

export function chromaCollectionNameForAgentId(agentId: string): string {
  return chromaCollectionNameForAgent(agentId);
}

/** @deprecated Use chromaCollectionPattern() or chromaCollectionNameForAgentId(agentId). */
export function chromaCollectionName(): string {
  return chromaCollectionPattern();
}

export function embeddingModelLabel(): string {
  return isChromaBackend() ? "chroma_default" : "mock_hash";
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
        content.slice(0, MAX_MEMORY_TEXT_CHARS),
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
  _ctx?: MemoryRequestContext
): Promise<{ ok: boolean; error?: string }> {
  const path = normalizeContextPath(rawPath);
  if (!path) return { ok: false, error: "invalid_path" };
  await contextStore.deleteContextFile(agentId, path);
  if (indexContextEnabled()) {
    const id = `ctx_${agentId}_${encodeURIComponent(path)}`;
    try {
      await deleteVectorsForAgent(agentId, [id]);
    } catch {
      /* ignore */
    }
  }
  return { ok: true };
}
