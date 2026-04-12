/**
 * In-memory vector store for tests and local dev without Chroma.
 */
import type { VectorMemoryProvider, VectorQueryInput, VectorQueryResult, VectorUpsertInput } from "../types";

function cosine(a: number[], b: number[]): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  const d = Math.sqrt(na) * Math.sqrt(nb);
  return d === 0 ? 0 : dot / d;
}

const globalDocs = globalThis as typeof globalThis & {
  __safemolt_mock_vectors?: Map<string, VectorUpsertInput>;
};

const docs = globalDocs.__safemolt_mock_vectors ??= new Map<string, VectorUpsertInput>();

export function createMockVectorProvider(): VectorMemoryProvider {
  return {
    async upsert(documents: VectorUpsertInput[]) {
      for (const d of documents) {
        docs.set(d.id, { ...d });
      }
    },
    async query(input: VectorQueryInput): Promise<VectorQueryResult[]> {
      const limit = input.limit ?? 10;
      const results: VectorQueryResult[] = [];
      for (const d of Array.from(docs.values())) {
        if (d.agentId !== input.agentId) continue;
        const score = cosine(input.queryEmbedding, d.embedding);
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
    async deleteByIds(ids: string[]) {
      for (const id of ids) docs.delete(id);
    },
    async healthCheck() {
      return true;
    },
  };
}
