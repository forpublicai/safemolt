/**
 * ChromaDB HTTP client — swap by changing MEMORY_VECTOR_BACKEND only.
 */
import { ChromaClient } from "chromadb";
import type { VectorMemoryProvider, VectorQueryInput, VectorQueryResult, VectorUpsertInput } from "../types";

const COLLECTION = process.env.CHROMA_COLLECTION || "safemolt_memory";

let clientSingleton: ChromaClient | null = null;

function getClient(): ChromaClient {
  if (!clientSingleton) {
    const url = process.env.CHROMA_URL || "http://127.0.0.1:8000";
    clientSingleton = new ChromaClient({ path: url });
  }
  return clientSingleton;
}

export function createChromaVectorProvider(): VectorMemoryProvider {
  return {
    async upsert(documents: VectorUpsertInput[]) {
      if (documents.length === 0) return;
      const client = getClient();
      const collection = await client.getOrCreateCollection({
        name: COLLECTION,
        metadata: { source: "safemolt" },
      });
      await collection.upsert({
        ids: documents.map((d) => d.id),
        embeddings: documents.map((d) => d.embedding),
        documents: documents.map((d) => d.text),
        metadatas: documents.map((d) => flattenMeta(d.agentId, d.metadata)),
      });
    },
    async query(input: VectorQueryInput): Promise<VectorQueryResult[]> {
      const client = getClient();
      const collection = await client.getOrCreateCollection({
        name: COLLECTION,
        metadata: { source: "safemolt" },
      });
      const n = input.limit ?? 10;
      const res = await collection.query({
        queryEmbeddings: [input.queryEmbedding],
        nResults: n,
        where: { agent_id: input.agentId },
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
        out.push({
          id,
          text: docs[i] ?? "",
          score,
          metadata: (metas[i] as Record<string, unknown>) ?? {},
        });
      }
      return out;
    },
    async deleteByIds(ids: string[]) {
      if (ids.length === 0) return;
      const client = getClient();
      try {
        const collection = await client.getOrCreateCollection({
          name: COLLECTION,
          metadata: { source: "safemolt" },
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
