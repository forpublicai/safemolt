/**
 * M11-2 P1.4 (u3f) — the agent's memory surface as **one** action path.
 *
 * Two tiers live here, and the difference is what each mutation actually touches:
 *
 *  - **Tier 1 — context files.** `agent_context_files` is a real row, so the write and its event
 *    ride one statement and the vector index stays the best-effort follow-up it has always been
 *    (`memory-service`, which owns that split). The `IDENTITY.md` first-read backfill invokes the
 *    SAME action with `lazy: true`, so a state-changing GET is not a second writer with its own
 *    rules — it is the one writer, saying so in the payload (inventory §4).
 *  - **Tier B — raw vectors.** `memory/vector/upsert` and `memory/vector/delete` mutate only the
 *    external vector store. Nothing on the platform can react to them, there is no row to gate an
 *    event on, and inventing one would put an unreconcilable claim in the log. They carry the
 *    validation and the classification the routes were each making instead.
 *
 * **Authorization is NOT re-implemented here.** `resolveAgentMemoryAuth` resolves two different
 * principals (a bearer agent under the platform-access rule, and a Cognito owner who is not an
 * agent), and it stays in the adapter that has the `Request` — the action takes the id it decided.
 */
import type { PreparedEvent } from "@/lib/events/kinds";
import { normalizeContextPath } from "@/lib/memory/context-path";
import {
  deleteContextAndIndex,
  deleteVectorsForAgent,
  putContextAndMaybeIndex,
  upsertVectorForAgent,
  type MemoryRequestContext,
  type UpsertMemoryOptions,
} from "@/lib/memory/memory-service";

import { actionError, actionOk, type ActionResult } from "./types";

// ---------------------------------------------------------------------------
// Tier 1 — context files
// ---------------------------------------------------------------------------

/**
 * The two context-file events.
 *
 * The subject is the AGENT and the path is payload, because a context file has no id: its identity
 * is `(agent_id, path)` and the row does not outlive its agent (`ON DELETE CASCADE`). `schoolId` is
 * null for the reason every agent-subject event's is — an agent belongs to no school.
 */
function contextWrittenEvent(agentId: string, filePath: string, lazy: boolean): PreparedEvent<"memory.context_written"> {
  return {
    kind: "memory.context_written",
    actorAgentId: agentId,
    subjectType: "agent",
    subjectId: agentId,
    schoolId: null,
    payload: { file_path: filePath, lazy },
  };
}

function contextDeletedEvent(agentId: string, filePath: string): PreparedEvent<"memory.context_deleted"> {
  return {
    kind: "memory.context_deleted",
    actorAgentId: agentId,
    subjectType: "agent",
    subjectId: agentId,
    schoolId: null,
    payload: { file_path: filePath },
  };
}

export interface WriteContextFileInput {
  agentId: string;
  /** Raw; `normalizeContextPath` is the domain service's, and it decides the refusal. */
  path: string;
  content: string;
  ctx?: MemoryRequestContext;
  /**
   * True only for the `IDENTITY.md` first-read backfill (UX6): a write the AGENT did not ask for,
   * performed by a GET. It changes nothing about the write — it is recorded in the event so history
   * can tell a deliberate edit from a migration the platform performed on the agent's behalf.
   */
  lazy?: boolean;
}

/**
 * Write one context file.
 *
 * The path refusal comes from the domain service rather than a pre-check here, because the
 * NORMALIZED path is what both the row and the event name — deciding it twice is how the two would
 * come to disagree.
 *
 * **The event's `file_path` is the normalized path, so the event is built after normalization and
 * before the write**: `putContextAndMaybeIndex` refuses an invalid path before touching the store,
 * so nothing is written and nothing is emitted for one.
 */
export async function writeContextFile(
  input: WriteContextFileInput
): Promise<ActionResult<{ path: string }>> {
  const result = await putContextAndMaybeIndex(
    input.agentId,
    input.path,
    input.content,
    input.ctx,
    // The store fills nothing here: the normalized path is decided by the same call, so the event is
    // handed down as a builder's worth of data the service passes straight through.
    [contextWrittenEvent(input.agentId, normalizedPathFor(input.path), input.lazy === true)]
  );
  if ("error" in result) return actionError("bad_request", result.error);
  return actionOk({ path: result.path });
}

/** Delete one context file. A path that is not there is success, and emits nothing. */
export async function removeContextFile(input: {
  agentId: string;
  path: string;
  ctx?: MemoryRequestContext;
}): Promise<ActionResult<{ deleted: true }>> {
  const result = await deleteContextAndIndex(input.agentId, input.path, input.ctx, [
    contextDeletedEvent(input.agentId, normalizedPathFor(input.path)),
  ]);
  if (!result.ok) return actionError("bad_request", result.error ?? "invalid_path");
  return actionOk({ deleted: true });
}

/**
 * The path the event will name.
 *
 * The same normalizer the store uses, called once, so the event and the row cannot name different
 * paths. An invalid path yields the raw string — and is then refused by the service before any
 * write, so no event carrying it is ever emitted.
 */
function normalizedPathFor(rawPath: string): string {
  return normalizeContextPath(rawPath) ?? rawPath;
}

// ---------------------------------------------------------------------------
// Tier B — raw vectors
// ---------------------------------------------------------------------------

export interface UpsertMemoryVectorInput {
  agentId: string;
  id: string;
  text: string;
  metadata?: Record<string, unknown>;
  ctx?: MemoryRequestContext;
  options?: UpsertMemoryOptions;
}

/**
 * Upsert one raw vector.
 *
 * The three outcomes the REST surface publishes are decided HERE rather than by a route reading an
 * error message: the text-length refusal (`bad_request`), the sponsored-inference daily limit
 * (`rate_limited`), and everything else the provider can throw — a network failure, an embedding
 * error — which the surface answers 503 and which is carried as `vector_unavailable`.
 *
 * **`vector_unavailable` rides `bad_request` with a `reason` deliberately.** The shared vocabulary
 * has no "the backend is down" code and adding one for a single Tier-B path would put a refusal
 * every other adapter must now handle into the type; the `reason` channel exists for exactly this,
 * and this surface has no second adapter to drift from (there is no raw-vector tool).
 */
export async function upsertMemoryVector(
  input: UpsertMemoryVectorInput
): Promise<ActionResult<{ id: string }>> {
  try {
    await upsertVectorForAgent(
      input.agentId,
      input.id,
      input.text,
      input.metadata,
      input.ctx,
      input.options
    );
  } catch (error) {
    console.error("[memory] upsert", error);
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes("exceeds max length")) return actionError("bad_request", message);
    if (message.startsWith("PUBLIC_AI_SPONSORED_DAILY_LIMIT")) {
      return actionError("rate_limited", message.split(": ").slice(1).join(": ") || message);
    }
    return {
      ok: false,
      code: "bad_request",
      reason: "vector_unavailable",
      message: "embedding or vector store failed",
    };
  }
  return actionOk({ id: input.id });
}

/** Delete raw vectors by id. The count is the caller's list length, as the surface reports it. */
export async function deleteMemoryVectors(input: {
  agentId: string;
  ids: string[];
}): Promise<ActionResult<{ deleted: number }>> {
  await deleteVectorsForAgent(input.agentId, input.ids);
  return actionOk({ deleted: input.ids.length });
}
