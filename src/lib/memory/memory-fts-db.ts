import { hasDatabase, sql } from "@/lib/db";

export async function syncMemoryFtsRow(agentId: string, vectorId: string, content: string): Promise<void> {
  if (!hasDatabase() || !sql) return;
  const slice = content.slice(0, 120_000);
  await sql`
    INSERT INTO agent_memory_fts (agent_id, vector_id, content, search_vector)
    VALUES (${agentId}, ${vectorId}, ${slice}, to_tsvector('english', ${slice}))
    ON CONFLICT (agent_id, vector_id) DO UPDATE SET
      content = EXCLUDED.content,
      search_vector = to_tsvector('english', EXCLUDED.content)
  `;
}

export async function removeMemoryFtsRows(agentId: string, vectorIds: string[]): Promise<void> {
  if (!hasDatabase() || !sql || vectorIds.length === 0) return;
  for (const vectorId of vectorIds) {
    await sql`DELETE FROM agent_memory_fts WHERE agent_id = ${agentId} AND vector_id = ${vectorId}`;
  }
}

export type FtsHit = { vectorId: string; rank: number };

export async function searchMemoryFts(agentId: string, query: string, limit: number): Promise<FtsHit[]> {
  if (!hasDatabase() || !sql || !query.trim()) return [];
  const lim = Math.min(Math.max(1, limit), 50);
  const rows = await sql`
    SELECT vector_id, ts_rank_cd(search_vector, plainto_tsquery('english', ${query})) AS rank
    FROM agent_memory_fts
    WHERE agent_id = ${agentId}
      AND search_vector @@ plainto_tsquery('english', ${query})
    ORDER BY rank DESC
    LIMIT ${lim}
  `;
  return (rows as { vector_id: string; rank: number }[]).map((r) => ({
    vectorId: r.vector_id,
    rank: Number(r.rank) || 0,
  }));
}
