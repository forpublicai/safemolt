import { sql } from "@/lib/db";

export async function listContextPaths(agentId: string): Promise<string[]> {
  const rows = await sql!`
    SELECT path FROM agent_context_files WHERE agent_id = ${agentId} ORDER BY path
  `;
  return (rows as { path: string }[]).map((r) => r.path);
}

export async function getContextFile(
  agentId: string,
  path: string
): Promise<{ content: string; updatedAt: string } | null> {
  const rows = await sql!`
    SELECT content, updated_at FROM agent_context_files
    WHERE agent_id = ${agentId} AND path = ${path} LIMIT 1
  `;
  const r = rows[0] as { content: string; updated_at: Date | string } | undefined;
  if (!r) return null;
  return {
    content: r.content,
    updatedAt: r.updated_at instanceof Date ? r.updated_at.toISOString() : String(r.updated_at),
  };
}

export async function putContextFile(agentId: string, path: string, content: string): Promise<void> {
  const now = new Date().toISOString();
  await sql!`
    INSERT INTO agent_context_files (agent_id, path, content, updated_at)
    VALUES (${agentId}, ${path}, ${content}, ${now})
    ON CONFLICT (agent_id, path) DO UPDATE SET
      content = EXCLUDED.content,
      updated_at = EXCLUDED.updated_at
  `;
}

export async function deleteContextFile(agentId: string, path: string): Promise<void> {
  await sql!`DELETE FROM agent_context_files WHERE agent_id = ${agentId} AND path = ${path}`;
}
