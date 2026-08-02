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

/**
 * M11-1b D5 — the memory upsert gated on a **live resolution lease**, in one statement.
 *
 * What this DOES guarantee: a resolver whose lease has lapsed or been reclaimed writes nothing,
 * which is the defect that motivated moving the derived writes later. The lease check and the
 * upsert are one statement, so they cannot be split by a concurrent reclaim.
 *
 * What this does NOT guarantee, stated plainly because an earlier revision of this comment claimed
 * otherwise: it is **not** coupled to the terminal CAS. `applyPlaygroundResolution` is a separate
 * auto-commit statement that runs after this one, so a lease that lapses in the gap leaves this
 * round's memory written for a round that never advanced. The window is narrow and self-healing —
 * the reclaimer re-resolves the same round and overwrites the same (agent, session) row — but it
 * is real, and it is recorded as a residual under D5 in ai/PLAN_M11_1B.md. Closing it needs the
 * CAS and the upserts folded into one statement; that is a follow-up change, not this one.
 *
 * @returns whether the lease admitted the write.
 */
export async function storePlaygroundMemoryFenced(
    input: CreateMemoryInput & { id: string },
    fence: { sessionId: string; round: number; token: string }
): Promise<boolean> {
    const createdAt = new Date().toISOString();
    const rows = await sql!`
    WITH winner AS (
      SELECT id FROM playground_sessions
      WHERE id = ${fence.sessionId}
        AND current_round = ${fence.round}
        AND resolve_claim_token = ${fence.token}
        AND resolve_claim_expires_at > NOW()
    )
    INSERT INTO playground_agent_memories
      (id, agent_id, agent_name, session_id, content, importance, round_created, embedding, created_at)
    SELECT
      ${input.id}, ${input.agentId}, ${input.agentName}, ${input.sessionId}, ${input.content},
      ${input.importance}, ${input.roundCreated ?? null},
      ${input.embedding ? JSON.stringify(input.embedding) : null}::jsonb, ${createdAt}
    FROM winner
    ON CONFLICT (agent_id, session_id) DO UPDATE SET
      id = EXCLUDED.id,
      agent_name = EXCLUDED.agent_name,
      content = EXCLUDED.content,
      importance = EXCLUDED.importance,
      round_created = EXCLUDED.round_created,
      embedding = EXCLUDED.embedding,
      created_at = EXCLUDED.created_at
    RETURNING agent_id
  `;
    return rows.length > 0;
}

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
