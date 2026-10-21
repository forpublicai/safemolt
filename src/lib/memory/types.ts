export interface VectorUpsertInput {
  id: string;
  agentId: string;
  text: string;
  /** When omitted, the provider embeds `text` (Chroma: HF Inference, all-MiniLM-L6-v2, 384 dims). */
  embedding?: number[];
  metadata?: Record<string, unknown>;
}

export interface VectorQueryInput {
  agentId: string;
  /** Mock / legacy path. */
  queryEmbedding?: number[];
  /** Chroma path — the provider embeds this text (HF Inference) and queries by vector. */
  queryText?: string;
  limit?: number;
  threshold?: number;
}

export interface VectorQueryResult {
  id: string;
  text: string;
  score: number;
  metadata: Record<string, unknown>;
}

/** List stored records for an agent (metadata scan; used for hot / importance recall). */
export type VectorListAgentInput = {
  agentId: string;
  /** Max rows to pull from the store before sorting in app (Chroma get limit). */
  limit?: number;
  /** Optional metadata filter — must match stored `kind` string when set. */
  kind?: string;
  /** Optional metadata filter — must match one of the stored `kind` strings when set. */
  kinds?: readonly string[];
};

export type VectorMemoryProvider = {
  upsert(documents: VectorUpsertInput[]): Promise<void>;
  query(input: VectorQueryInput): Promise<VectorQueryResult[]>;
  /** Return records for tiered “hot” loading (no embedding). */
  listAgentRecords(input: VectorListAgentInput): Promise<VectorQueryResult[]>;
  getByIdsForAgent(agentId: string, ids: string[]): Promise<VectorQueryResult[]>;
  deleteByIdsForAgent(agentId: string, ids: string[]): Promise<void>;
  healthCheck(): Promise<boolean>;
};
