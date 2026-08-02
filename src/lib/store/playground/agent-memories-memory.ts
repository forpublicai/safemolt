import type { AgentMemory, CreateMemoryInput } from "@/lib/playground/types";
import { playgroundAgentMemories, playgroundSessions } from "../_memory-state";

/**
 * M11-1b D5 — the memory-mode mirror. Keyed `agentId:sessionId`, matching the db's composite
 * primary key: one record per (agent, session), overwritten each round.
 */

function key(agentId: string, sessionId: string): string {
  return `${agentId}:${sessionId}`;
}

export async function storePlaygroundMemory(input: CreateMemoryInput & { id: string }): Promise<AgentMemory> {
  const memory: AgentMemory = {
    id: input.id,
    agentId: input.agentId,
    agentName: input.agentName,
    sessionId: input.sessionId,
    content: input.content,
    embedding: input.embedding,
    importance: input.importance,
    roundCreated: input.roundCreated ?? 0,
    createdAt: new Date().toISOString(),
  };
  playgroundAgentMemories.set(key(input.agentId, input.sessionId), memory);
  return memory;
}

/**
 * The fenced form: the lease check and the write happen in ONE synchronous section, mirroring the
 * db's single lease-gated statement — a lease-expired resolver writes nothing. Like the db side,
 * this is gated on the lease, NOT on the terminal CAS; see the residual noted there.
 */
export async function storePlaygroundMemoryFenced(
  input: CreateMemoryInput & { id: string },
  fence: { sessionId: string; round: number; token: string }
): Promise<boolean> {
  const session = playgroundSessions.get(fence.sessionId);
  const live = Boolean(
    session &&
      session.currentRound === fence.round &&
      session.resolveClaimToken === fence.token &&
      session.resolveClaimExpiresAt &&
      Date.parse(session.resolveClaimExpiresAt) > Date.now()
  );
  if (!live) return false;
  playgroundAgentMemories.set(key(input.agentId, input.sessionId), {
    id: input.id,
    agentId: input.agentId,
    agentName: input.agentName,
    sessionId: input.sessionId,
    content: input.content,
    embedding: input.embedding,
    importance: input.importance,
    roundCreated: input.roundCreated ?? 0,
    createdAt: new Date().toISOString(),
  });
  return true;
}

export async function getPlaygroundMemoryForAgent(sessionId: string, agentId: string): Promise<AgentMemory | null> {
  return playgroundAgentMemories.get(key(agentId, sessionId)) ?? null;
}

export async function listPlaygroundMemoriesForSession(sessionId: string): Promise<AgentMemory[]> {
  return Array.from(playgroundAgentMemories.values())
    .filter((m) => m.sessionId === sessionId)
    .sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt));
}

export async function clearPlaygroundMemoriesForSession(sessionId: string): Promise<number> {
  let removed = 0;
  for (const [k, m] of playgroundAgentMemories) {
    if (m.sessionId === sessionId) {
      playgroundAgentMemories.delete(k);
      removed += 1;
    }
  }
  return removed;
}

/** No FK cascade here (M11-1b D5): memory-mode agent deletion must sweep explicitly. */
export async function clearPlaygroundMemoriesForAgent(agentId: string): Promise<number> {
  let removed = 0;
  for (const [k, m] of playgroundAgentMemories) {
    if (m.agentId === agentId) {
      playgroundAgentMemories.delete(k);
      removed += 1;
    }
  }
  return removed;
}
