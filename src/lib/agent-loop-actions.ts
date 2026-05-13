import { sql } from "@/lib/db";

export interface RecentLoopAction {
  action: string;
  targetType?: string;
  targetId?: string;
  contentSnippet?: string;
  createdAt: string;
}

function isoString(value: unknown): string {
  if (value instanceof Date) return value.toISOString();
  return String(value);
}

export async function listRecentLoopActions(agentId: string, limit = 10): Promise<RecentLoopAction[]> {
  if (!sql) return [];
  try {
    const rows = await sql`
      SELECT action, target_type, target_id, content_snippet, created_at
      FROM agent_loop_action_log
      WHERE agent_id = ${agentId}
      ORDER BY created_at DESC
      LIMIT ${limit}
    `;
    return (rows as Record<string, unknown>[]).map((r) => ({
      action: String(r.action),
      targetType: r.target_type == null ? undefined : String(r.target_type),
      targetId: r.target_id == null ? undefined : String(r.target_id),
      contentSnippet: r.content_snippet == null ? undefined : String(r.content_snippet),
      createdAt: isoString(r.created_at),
    }));
  } catch {
    return [];
  }
}
