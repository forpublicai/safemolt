import { createHash } from "crypto";

/**
 * Deterministic vector id for a chunk under a stable parent key (idempotent re-ingest).
 */
export function memoryDeterministicChunkId(agentId: string, parentId: string, chunkIndex: number): string {
  const h = createHash("sha256")
    .update(`${agentId}\0${parentId}\0${chunkIndex}`, "utf8")
    .digest("hex")
    .slice(0, 16);
  return `sm_${h}`;
}
