import type { PreparedEvent } from "@/lib/events/kinds";
import { agents } from "@/lib/store/_memory-state";
import { appendPreparedBatch, prepareEventBatch, validatePreparedEvents } from "@/lib/store/events/memory";

const globalCtx = globalThis as typeof globalThis & {
  __safemolt_context_files?: Map<string, Map<string, { content: string; updatedAt: string }>>;
};

const root =
  globalCtx.__safemolt_context_files ??=
  new Map<string, Map<string, { content: string; updatedAt: string }>>();

export async function listContextPaths(agentId: string): Promise<string[]> {
  const m = root.get(agentId);
  if (!m) return [];
  return Array.from(m.keys()).sort();
}

export async function getContextFile(
  agentId: string,
  path: string
): Promise<{ content: string; updatedAt: string } | null> {
  return root.get(agentId)?.get(path) ?? null;
}

/**
 * The memory twin of the context write, with its event.
 *
 * **The agent is checked, and that is parity with a constraint rather than caution**:
 * `agent_context_files.agent_id REFERENCES agents(id)` makes Postgres refuse this insert outright
 * for an agent withdrawn between authentication and the write (23503, nothing written, nothing
 * emitted). Memory has no constraint to trip, so it raises the same error shape — otherwise one
 * store would file a context file for an agent the other says does not exist.
 *
 * Preflight, mutate, append, with no `await` in between (Decision 4).
 */
export async function putContextFile(
  agentId: string,
  path: string,
  content: string,
  events?: readonly PreparedEvent[]
): Promise<void> {
  const batch = prepareEventBatch(events);
  if (!agents.has(agentId)) throw contextFileForeignKeyError(agentId);
  let m = root.get(agentId);
  if (!m) {
    m = new Map();
    root.set(agentId, m);
  }
  const updatedAt = new Date().toISOString();
  m.set(path, { content, updatedAt });
  await appendPreparedBatch(batch).dispatched;
}

/**
 * The memory twin of the context delete.
 *
 * No agent check: the db side's `DELETE` names no foreign key, so a withdrawn agent's stale path is
 * still removed there and still emits. The MISSING-path case is what gates the event, in both
 * stores — a delete that matched nothing writes nothing and emits nothing.
 */
export async function deleteContextFile(
  agentId: string,
  path: string,
  events?: readonly PreparedEvent[]
): Promise<void> {
  const files = root.get(agentId);
  if (!files?.has(path)) {
    // Preflight anyway: the db side renders and validates its events before it learns the delete
    // matched nothing, so an unknown kind must be refused here too.
    validatePreparedEvents(events);
    return;
  }
  const batch = prepareEventBatch(events);
  files.delete(path);
  await appendPreparedBatch(batch).dispatched;
}

function contextFileForeignKeyError(agentId: string): Error & { code: string; constraint: string } {
  const error = new Error(`agent ${agentId} does not exist`) as Error & { code: string; constraint: string };
  error.code = "23503";
  error.constraint = "agent_context_files_agent_id_fkey";
  return error;
}
