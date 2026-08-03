import { sql } from "@/lib/db";
import type { AgentMemory, CreateMemoryInput, MemoryImportance } from "@/lib/playground/types";

/**
 * M11-1b D5 — durable playground episodic memories (db side).
 *
 * Semantics are today's, preserved exactly: ONE record per (agent, session), overwritten each
 * round. The composite primary key is what makes the upsert express that directly rather than
 * through a delete-then-insert pair.
 */

function rowToMemory(r: Record<string, unknown>): AgentMemory {
    return {
        id: r.id as string,
        agentId: r.agent_id as string,
        agentName: r.agent_name as string,
        sessionId: r.session_id as string,
        content: r.content as string,
        embedding: (r.embedding as number[] | null) ?? undefined,
        importance: r.importance as MemoryImportance,
        roundCreated: r.round_created != null ? Number(r.round_created) : 0,
        createdAt: r.created_at instanceof Date ? r.created_at.toISOString() : String(r.created_at),
    };
}

export async function storePlaygroundMemory(input: CreateMemoryInput & { id: string }): Promise<AgentMemory> {
    const createdAt = new Date().toISOString();
    const rows = await sql!`
    INSERT INTO playground_agent_memories
      (id, agent_id, agent_name, session_id, content, importance, round_created, embedding, created_at)
    VALUES (
      ${input.id}, ${input.agentId}, ${input.agentName}, ${input.sessionId}, ${input.content},
      ${input.importance}, ${input.roundCreated ?? null},
      ${input.embedding ? JSON.stringify(input.embedding) : null}::jsonb, ${createdAt}
    )
    ON CONFLICT (agent_id, session_id) DO UPDATE SET
      id = EXCLUDED.id,
      agent_name = EXCLUDED.agent_name,
      content = EXCLUDED.content,
      importance = EXCLUDED.importance,
      round_created = EXCLUDED.round_created,
      embedding = EXCLUDED.embedding,
      created_at = EXCLUDED.created_at
    RETURNING *
  `;
    return rowToMemory(rows[0] as Record<string, unknown>);
}

/*
 * There was a `storePlaygroundMemoryFenced` here, gated on the live resolution *lease*. It is gone,
 * not lost: the D5 atomic follow-up moved the round's memories into `applyPlaygroundResolution`'s
 * terminal CAS (`store/playground/db.ts`), whose predicate is strictly stronger — it carries the
 * lease token and expiry AND the status and round the lease was taken for. Keeping a second,
 * weaker writer would only invite a caller to pick it.
 */

export async function getPlaygroundMemoryForAgent(sessionId: string, agentId: string): Promise<AgentMemory | null> {
    const rows = await sql!`
    SELECT * FROM playground_agent_memories WHERE session_id = ${sessionId} AND agent_id = ${agentId} LIMIT 1
  `;
    const r = rows[0] as Record<string, unknown> | undefined;
    return r ? rowToMemory(r) : null;
}

export async function listPlaygroundMemoriesForSession(sessionId: string): Promise<AgentMemory[]> {
    const rows = await sql!`
    SELECT * FROM playground_agent_memories WHERE session_id = ${sessionId} ORDER BY created_at ASC
  `;
    return (rows as Record<string, unknown>[]).map(rowToMemory);
}

/**
 * Explicit cleanup for a session. The FK cascade covers session *deletion*, but since M11-1 C3
 * cancellation is a status TRANSITION — nothing is deleted — so the transition must drive this
 * itself, in both stores.
 */
export async function clearPlaygroundMemoriesForSession(sessionId: string): Promise<number> {
    const rows = await sql!`DELETE FROM playground_agent_memories WHERE session_id = ${sessionId} RETURNING agent_id`;
    return rows.length;
}

/** Agent deletion cascades in db mode; this exists so the shared delete helper reads the same in
 *  both stores and so a caller can sweep explicitly when it needs to. */
export async function clearPlaygroundMemoriesForAgent(agentId: string): Promise<number> {
    const rows = await sql!`DELETE FROM playground_agent_memories WHERE agent_id = ${agentId} RETURNING agent_id`;
    return rows.length;
}
