import { sql } from "@/lib/db";
import type { PreparedEvent } from "@/lib/events/kinds";
import { emitEventCtes, sqlParam } from "@/lib/store/events/statement";

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

/**
 * Write one context file, carrying `memory.context_written` in the SAME statement (M11-2 P1.4).
 *
 * The upsert is unconditional — re-writing identical content still moves `updated_at`, which is the
 * contract the surface has always had — so the event is emitted on every accepted write and gated
 * on the upsert's own `RETURNING` for the reason every Tier-1 producer is: a statement that wrote
 * nothing (a withdrawn agent's foreign key failing the whole thing) emits nothing.
 *
 * The subject is the AGENT, and the path lives in the payload: a context file has no id, its
 * identity is `(agent_id, path)`, and `ON DELETE CASCADE` means the row does not survive its agent.
 */
export async function putContextFile(
  agentId: string,
  path: string,
  content: string,
  events?: readonly PreparedEvent[]
): Promise<void> {
  const params: unknown[] = [agentId, path, content, new Date().toISOString()];
  const emitted = emitEventCtes(events, "written", {
    firstParamIndex: params.length + 1,
    overrides: events?.length ? [{ columnSql: { subject_id: sqlParam(1, "text") } }] : [],
  });
  await sql!(
    `
    WITH written AS (
      INSERT INTO agent_context_files (agent_id, path, content, updated_at)
      VALUES ($1::text, $2::text, $3::text, $4::timestamptz)
      ON CONFLICT (agent_id, path) DO UPDATE SET
        content = EXCLUDED.content,
        updated_at = EXCLUDED.updated_at
      RETURNING agent_id
    )${emitted.ctes.length > 0 ? `, ${emitted.ctes.join(", ")}` : ""}
    SELECT agent_id FROM written
  `,
    [...params, ...emitted.params]
  );
}

/**
 * Delete one context file, carrying `memory.context_deleted` in the same statement.
 *
 * Conditional by nature: deleting a path that is not there matches no row, so it writes nothing and
 * emits nothing — while the surface still answers success, which is what it has always done.
 */
export async function deleteContextFile(
  agentId: string,
  path: string,
  events?: readonly PreparedEvent[]
): Promise<void> {
  const params: unknown[] = [agentId, path];
  const emitted = emitEventCtes(events, "removed", {
    firstParamIndex: params.length + 1,
    overrides: events?.length ? [{ columnSql: { subject_id: sqlParam(1, "text") } }] : [],
  });
  await sql!(
    `
    WITH removed AS (
      DELETE FROM agent_context_files WHERE agent_id = $1::text AND path = $2::text
      RETURNING agent_id
    )${emitted.ctes.length > 0 ? `, ${emitted.ctes.join(", ")}` : ""}
    SELECT agent_id FROM removed
  `,
    [...params, ...emitted.params]
  );
}
