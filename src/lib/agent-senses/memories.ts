/**
 * The agent's own recent memories (hot recall).
 *
 * Promoted from the inline `recallMemoryForAgent(...).catch(() => [])` in `tickAgent`. The query
 * string is the loop's, kept in `constants.ts` so both this library and any later caller ask the
 * memory service the same question.
 */

import { recallMemoryForAgent } from "@/lib/memory/memory-service";
import { DEFAULT_MEMORIES_LIMIT, MEMORY_RECALL_QUERY } from "./constants";
import type { MemoriesSection } from "./types";

export interface GatherMemoriesOptions {
  limit?: number;
}

export async function gatherMemories(
  agentId: string,
  opts: GatherMemoriesOptions = {}
): Promise<MemoriesSection> {
  try {
    const results = await recallMemoryForAgent(
      agentId,
      "hot",
      MEMORY_RECALL_QUERY,
      opts.limit ?? DEFAULT_MEMORIES_LIMIT
    );
    return { items: results.map((r) => ({ text: r.text })), degraded: false };
  } catch (e) {
    console.error("[agent-senses] gatherMemories failed:", e);
    return { items: [], degraded: true };
  }
}
