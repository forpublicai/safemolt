import type { AgentMemory, CreateMemoryInput, ResolutionMemory } from "@/lib/playground/types";
import { playgroundAgentMemories } from "../_memory-state";

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
 * The **synchronous** row writer, used by the terminal resolution CAS (M11-1b D5 atomic follow-up).
 *
 * It is deliberately not `async`: the session update and every participant's memory must land in
 * one synchronous section, or a concurrent promise can observe an advanced session whose round has
 * no memories — the memory-mode shape of the db's single-statement coupling. `await` inside a
 * memory-store function is not atomic (Locked decision 4).
 */
export function writePlaygroundMemoryRecord(input: ResolutionMemory): void {
  playgroundAgentMemories.set(key(input.agentId, input.sessionId), {
    id: input.id,
    agentId: input.agentId,
    agentName: input.agentName,
    sessionId: input.sessionId,
    content: input.content,
    embedding: input.embedding,
    importance: input.importance,
    roundCreated: input.roundCreated ?? 0,
    createdAt: input.createdAt,
  });
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
