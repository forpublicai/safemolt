/**
 * ChromaDB HTTP client — per-agent collection. SafeMolt computes every vector (chroma-embeddings.ts)
 * and always sends `embeddings` / `queryEmbeddings`. Chroma never embeds: the chromadb JS client
 * would do it on our side with DefaultEmbeddingFunction, downloading a 90 MB model from Hugging Face.
 */
import { ChromaClient, IncludeEnum, type Collection, type IEmbeddingFunction } from "chromadb";
import { chromaCollectionNameForAgent } from "../chroma-collection-name";
import { assertChromaEmbedding, embedTextsForChroma } from "../chroma-embeddings";
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

/**
 * Given to every collection so the client's DefaultEmbeddingFunction is never constructed, and a
 * call that reaches Chroma without vectors fails here instead of downloading a model.
 */
export const refuseChromaEmbedding: IEmbeddingFunction = {
  async generate() {
    throw new Error(
      "SafeMolt computes memory embeddings; Chroma must not embed. Pass embeddings / queryEmbeddings."
    );
  },
};

function collectionForAgent(client: ChromaClient, agentId: string): Promise<Collection> {
  return client.getOrCreateCollection({
    name: chromaCollectionNameForAgent(agentId),
    metadata: { source: "safemolt", agent_id: agentId },
    embeddingFunction: refuseChromaEmbedding,
  });
}

/** Supplied vectors are kept; the rest are embedded in one batch. */
async function embeddingsFor(group: VectorUpsertInput[]): Promise<number[][]> {
  const computed = await embedTextsForChroma(
    group.filter((d) => !d.embedding?.length).map((d) => d.text)
  );
  let next = 0;
  return group.map((d) => {
    const vec = d.embedding?.length ? d.embedding : computed[next++];
    assertChromaEmbedding(vec);
    return vec;
  });
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
        const embeddings = await embeddingsFor(group);
        const collection = await collectionForAgent(client, agentId);
        await collection.upsert({
          ids: group.map((d) => d.id),
          embeddings,
          documents: group.map((d) => d.text),
          metadatas: group.map((d) => flattenMeta(d.agentId, d.metadata)),
        });
      }
    },
    async query(input: VectorQueryInput): Promise<VectorQueryResult[]> {
      const qText = input.queryText?.trim();
      const queryEmbedding = qText ? (await embedTextsForChroma([qText]))[0] : input.queryEmbedding;
      if (!queryEmbedding?.length) return [];
      assertChromaEmbedding(queryEmbedding);

      const client = getClient();
      const collection = await collectionForAgent(client, input.agentId);
      const n = input.limit ?? 10;
      const threshold = input.threshold;
      const nResults =
        threshold !== undefined && threshold !== null
          ? Math.min(500, Math.max(n * 10, 50))
          : n;

      const res = await collection.query({
        queryEmbeddings: [queryEmbedding],
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
      const collection = await collectionForAgent(client, agentId);
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
      const collection = await collectionForAgent(client, input.agentId);
      const lim = input.limit ?? 500;
      const kinds = input.kinds?.filter(Boolean);
      const where =
        input.kind ? { kind: input.kind } :
        kinds && kinds.length > 0 ? { kind: { $in: kinds } } :
        undefined;
      const res = await collection.get({
        limit: lim,
        ...(where ? { where } : {}),
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
        if (kinds && kinds.length > 0 && !kinds.includes(String(meta.kind))) continue;
        out.push({
          id,
          text: docs[i] ?? "",
          score: importanceScore(meta),
          metadata: meta,
        });
        if (!input.kind && out.length >= lim) break;
      }
      if (input.kind || (kinds && kinds.length > 0)) {
        out.sort((a, b) => b.score - a.score || importanceScore(b.metadata) - importanceScore(a.metadata));
        return out.slice(0, lim);
      }
      return out;
    },
    async deleteByIdsForAgent(agentId: string, ids: string[]) {
      if (ids.length === 0) return;
      const client = getClient();
      try {
        const collection = await collectionForAgent(client, agentId);
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
