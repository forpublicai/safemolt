export interface VectorUpsertInput {
  id: string;
  agentId: string;
  text: string;
  embedding: number[];
  metadata?: Record<string, unknown>;
}

export interface VectorQueryInput {
  agentId: string;
  queryEmbedding: number[];
  limit?: number;
  threshold?: number;
}

export interface VectorQueryResult {
  id: string;
  text: string;
  score: number;
  metadata: Record<string, unknown>;
}

export type VectorMemoryProvider = {
  upsert(documents: VectorUpsertInput[]): Promise<void>;
  query(input: VectorQueryInput): Promise<VectorQueryResult[]>;
  deleteByIds(ids: string[]): Promise<void>;
  healthCheck(): Promise<boolean>;
};
