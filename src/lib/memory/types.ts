export interface VectorUpsertInput {
  id: string;
  agentId: string;
  text: string;
  /** When omitted (Chroma path), the server embeds from `documents`. */
  embedding?: number[];
  metadata?: Record<string, unknown>;
}

export interface VectorQueryInput {
  agentId: string;
  /** Mock / legacy path. */
  queryEmbedding?: number[];
  /** Chroma path — server-side embedding from query text. */
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
