/**
 * ChromaDB HTTP client — per-agent collection; server-side embeddings when none supplied.
 */
import { ChromaClient, IncludeEnum } from "chromadb";
import { chromaCollectionNameForAgent } from "../chroma-collection-name";
import type {
  VectorListAgentInput,
  VectorMemoryProvider,
  VectorQueryInput,
  VectorQueryResult,
  VectorUpsertInput,
} from "../types";

let clientSingleton: ChromaClient | null = null;

function getClient(): ChromaClient {
  if (!clientSingleton) {
    const url = process.env.CHROMA_URL || "http://127.0.0.1:8000";
    const token = process.env.CHROMA_TOKEN?.trim();
    clientSingleton = new ChromaClient({
      path: url,
      ...(token ? { fetchOptions: { headers: { Authorization: `Bearer ${token}` } } } : {}),
    });
  }
  return clientSingleton;
}

function importanceScore(meta: Record<string, unknown> | null | undefined): number {
  if (!meta) return 0;
  const v = meta.importance;
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string") {
    const n = Number(v);
    return Number.isFinite(n) ? n : 0;
  }
  return 0;
}

export function createChromaVectorProvider(): VectorMemoryProvider {
  return {
    async upsert(documents: VectorUpsertInput[]) {
      if (documents.length === 0) return;
      const client = getClient();
      const byAgent = new Map<string, VectorUpsertInput[]>();
      for (const d of documents) {
        const list = byAgent.get(d.agentId) ?? [];
        list.push(d);
        byAgent.set(d.agentId, list);
      }
      for (const [agentId, group] of Array.from(byAgent.entries())) {
        const collection = await client.getOrCreateCollection({
          name: chromaCollectionNameForAgent(agentId),
          metadata: { source: "safemolt", agent_id: agentId },
        });
        const serverEmbed = group.every((d) => !d.embedding?.length);
        if (serverEmbed) {
          await collection.upsert({
            ids: group.map((d) => d.id),
            documents: group.map((d) => d.text),
            metadatas: group.map((d) => flattenMeta(d.agentId, d.metadata)),
          });
        } else {
          await collection.upsert({
            ids: group.map((d) => d.id),
            embeddings: group.map((d) => d.embedding!),
            documents: group.map((d) => d.text),
            metadatas: group.map((d) => flattenMeta(d.agentId, d.metadata)),
          });
        }
      }
    },
    async query(input: VectorQueryInput): Promise<VectorQueryResult[]> {
      const client = getClient();
      const collection = await client.getOrCreateCollection({
        name: chromaCollectionNameForAgent(input.agentId),
        metadata: { source: "safemolt", agent_id: input.agentId },
      });
      const n = input.limit ?? 10;
      const threshold = input.threshold;
      const nResults =
        threshold !== undefined && threshold !== null
          ? Math.min(500, Math.max(n * 10, 50))
          : n;

      const qText = input.queryText?.trim();
      const res =
        qText !== undefined && qText.length > 0
          ? await collection.query({
              queryTexts: qText,
              nResults,
            })
          : await collection.query({
              queryEmbeddings: [input.queryEmbedding!],
              nResults,
            });

      const ids = res.ids[0] ?? [];
      const dists = res.distances?.[0] ?? [];
      const docs = res.documents[0] ?? [];
      const metas = res.metadatas?.[0] ?? [];
      const out: VectorQueryResult[] = [];
      for (let i = 0; i < ids.length; i++) {
        const id = ids[i];
        if (!id) continue;
        const distance = dists[i] ?? 0;
        const score = 1 / (1 + distance);
        if (threshold !== undefined && threshold !== null && score < threshold) {
          continue;
        }
        out.push({
          id,
          text: docs[i] ?? "",
          score,
          metadata: (metas[i] as Record<string, unknown>) ?? {},
        });
        if (out.length >= n) break;
      }
      return out;
    },
    async getByIdsForAgent(agentId: string, ids: string[]): Promise<VectorQueryResult[]> {
      if (ids.length === 0) return [];
      const client = getClient();
      const collection = await client.getOrCreateCollection({
        name: chromaCollectionNameForAgent(agentId),
        metadata: { source: "safemolt", agent_id: agentId },
      });
      const res = await collection.get({
        ids,
        include: [IncludeEnum.Documents, IncludeEnum.Metadatas],
      });
      const gotIds = res.ids ?? [];
      const docs = res.documents ?? [];
      const metas = res.metadatas ?? [];
      const out: VectorQueryResult[] = [];
      for (let i = 0; i < gotIds.length; i++) {
        const id = gotIds[i];
        if (!id) continue;
        const meta = (metas[i] as Record<string, unknown>) ?? {};
        out.push({
          id,
          text: docs[i] ?? "",
          score: 0,
          metadata: meta,
        });
      }
      return out;
    },
    async listAgentRecords(input: VectorListAgentInput): Promise<VectorQueryResult[]> {
      const client = getClient();
      const collection = await client.getOrCreateCollection({
        name: chromaCollectionNameForAgent(input.agentId),
        metadata: { source: "safemolt", agent_id: input.agentId },
      });
      const lim = input.limit ?? 500;
      const fetchCap = input.kind ? Math.min(2000, lim * 25) : lim;
      const res = await collection.get({
        limit: fetchCap,
        include: [IncludeEnum.Documents, IncludeEnum.Metadatas],
      });
      const ids = res.ids ?? [];
      const docs = res.documents ?? [];
      const metas = res.metadatas ?? [];
      const out: VectorQueryResult[] = [];
      for (let i = 0; i < ids.length; i++) {
        const id = ids[i];
        if (!id) continue;
        const meta = (metas[i] as Record<string, unknown>) ?? {};
        if (input.kind && String(meta.kind) !== input.kind) continue;
        out.push({
          id,
          text: docs[i] ?? "",
          score: importanceScore(meta),
          metadata: meta,
        });
        if (!input.kind && out.length >= lim) break;
      }
      if (input.kind) {
        out.sort((a, b) => b.score - a.score || importanceScore(b.metadata) - importanceScore(a.metadata));
        return out.slice(0, lim);
      }
      return out;
    },
    async deleteByIdsForAgent(agentId: string, ids: string[]) {
      if (ids.length === 0) return;
      const client = getClient();
      try {
        const collection = await client.getOrCreateCollection({
          name: chromaCollectionNameForAgent(agentId),
          metadata: { source: "safemolt", agent_id: agentId },
        });
        await collection.delete({ ids });
      } catch {
        /* collection missing */
      }
    },
    async healthCheck() {
      try {
        const client = getClient();
        await client.heartbeat();
        return true;
      } catch {
        return false;
      }
    },
  };
}

/** Chroma metadata values must be string | number | boolean */
function flattenMeta(agentId: string, meta?: Record<string, unknown>): Record<string, string | number | boolean> {
  const out: Record<string, string | number | boolean> = { agent_id: agentId };
  if (!meta) return out;
  for (const [k, v] of Object.entries(meta)) {
    if (k === "agent_id") continue;
    if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") {
      out[k] = v;
    } else if (v != null) {
      out[k] = JSON.stringify(v);
    }
  }
  return out;
}
