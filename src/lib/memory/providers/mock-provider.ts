/**
 * In-memory vector store for tests and local dev without Chroma.
 * Nested map per agent so the same logical id can exist for different agents (mirrors per-collection Chroma).
 */
import type {
  VectorListAgentInput,
  VectorMemoryProvider,
  VectorQueryInput,
  VectorQueryResult,
  VectorUpsertInput,
} from "../types";

function cosine(a: number[], b: number[]): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    dot += a[i]! * b[i]!;
    na += a[i]! * a[i]!;
    nb += b[i]! * b[i]!;
  }
  const d = Math.sqrt(na) * Math.sqrt(nb);
  return d === 0 ? 0 : dot / d;
}

function importanceScore(meta: Record<string, unknown> | undefined): number {
  if (!meta) return 0;
  const v = meta.importance;
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string") {
    const n = Number(v);
    return Number.isFinite(n) ? n : 0;
  }
  return 0;
}

function filedAtSortKey(meta: Record<string, unknown>): number {
  const fa = meta.filed_at;
  if (typeof fa === "string") {
    const t = Date.parse(fa);
    return Number.isFinite(t) ? t : 0;
  }
  return 0;
}

const globalBuckets = globalThis as typeof globalThis & {
  __safemolt_mock_vector_buckets?: Map<string, Map<string, VectorUpsertInput>>;
};

const byAgent = globalBuckets.__safemolt_mock_vector_buckets ??= new Map<string, Map<string, VectorUpsertInput>>();

function bucket(agentId: string): Map<string, VectorUpsertInput> {
  let m = byAgent.get(agentId);
  if (!m) {
    m = new Map();
    byAgent.set(agentId, m);
  }
  return m;
}

export function createMockVectorProvider(): VectorMemoryProvider {
  return {
    async upsert(documents: VectorUpsertInput[]) {
      for (const d of documents) {
        const emb =
          d.embedding && d.embedding.length > 0
            ? d.embedding
            : new Array(64).fill(0).map((_, i) => (d.text.charCodeAt(i % d.text.length) % 256) / 256 - 0.5);
        bucket(d.agentId).set(d.id, { ...d, embedding: emb });
      }
    },
    async query(input: VectorQueryInput): Promise<VectorQueryResult[]> {
      const limit = input.limit ?? 10;
      const b = bucket(input.agentId);
      const qEmb = input.queryEmbedding;
      if (!qEmb || qEmb.length === 0) {
        return [];
      }
      const results: VectorQueryResult[] = [];
      for (const d of Array.from(b.values())) {
        const score = cosine(qEmb, d.embedding ?? []);
        if (score < (input.threshold ?? -1)) continue;
        results.push({
          id: d.id,
          text: d.text,
          score,
          metadata: d.metadata ?? {},
        });
      }
      results.sort((a, b) => b.score - a.score);
      return results.slice(0, limit);
    },
    async getByIdsForAgent(agentId: string, ids: string[]): Promise<VectorQueryResult[]> {
      const b = bucket(agentId);
      const out: VectorQueryResult[] = [];
      for (const id of ids) {
        const d = b.get(id);
        if (d) {
          out.push({
            id: d.id,
            text: d.text,
            score: 0,
            metadata: d.metadata ?? {},
          });
        }
      }
      return out;
    },
    async listAgentRecords(input: VectorListAgentInput): Promise<VectorQueryResult[]> {
      const lim = input.limit ?? 500;
      const b = bucket(input.agentId);
      const rows: VectorQueryResult[] = [];
      for (const d of Array.from(b.values())) {
        const meta = d.metadata ?? {};
        if (input.kind && String(meta.kind) !== input.kind) continue;
        rows.push({
          id: d.id,
          text: d.text,
          score: importanceScore(meta),
          metadata: meta,
        });
      }
      rows.sort((a, b) => {
        const d = b.score - a.score;
        if (d !== 0) return d;
        return filedAtSortKey(b.metadata) - filedAtSortKey(a.metadata);
      });
      return rows.slice(0, lim);
    },
    async deleteByIdsForAgent(agentId: string, ids: string[]) {
      const b = bucket(agentId);
      for (const id of ids) {
        b.delete(id);
      }
    },
    async healthCheck() {
      return true;
    },
  };
}
