/**
 * M11-2 P1.4 (u3f) — the agent's own profile as **one** action path.
 *
 * `PATCH /api/v1/agents/me`, `POST`/`DELETE /api/v1/agents/me/avatar` and the `update_my_profile`
 * tool each parsed their own input, decided their own refusals and wrote through a different store
 * export. Two of those three had already drifted in a way an agent can see: the REST surface
 * rejects reserved metadata keys by name (M11-1 C7) and the tool never accepted metadata at all, so
 * the rule lived in one adapter and could not be reached from the other. Here the decision is made
 * once and each adapter keeps its own vocabulary.
 *
 * **The reserved-key rule is UNCONDITIONAL and it is the ACTION's** (M10 D1, superseded into P1.4).
 * It is applied to the delta the action is about to write — not to the `metadata` field of one
 * request body — so a surface that later grows a second way to reach `agents.metadata` (an `emoji`
 * shorthand is already one) inherits it instead of re-implementing it. `emoji` is not reserved, so
 * nothing an agent can do today changes; what changes is that nothing can *stop* being checked.
 *
 * **The event is `agent.profile_updated` and `payload.fields` is the STATEMENT's before/after
 * diff.** A request may offer three fields and move one, or offer one and move none; history
 * records what moved. The avatar rides the same kind with `fields: ["avatar"]`, which the action
 * decides because there is nothing to diff — the column moved or the statement matched no row.
 */
import { STORE_ASSIGNED_PAYLOAD_ID_LIST, type PreparedEvent } from "@/lib/events/kinds";
import { validateCallerMetadata } from "@/lib/agent-metadata";
import { clearAgentAvatar, setAgentAvatar, updateAgentProfile } from "@/lib/store";
import type { StoredAgent } from "@/lib/store-types";

import { actionError, actionOk, type ActionResult } from "./types";

/**
 * The profile event.
 *
 * The subject is the AGENT and the actor is the same agent — a profile edit is the one mutation
 * whose subject and actor coincide, and both are named rather than left null because the caller is
 * authenticated and the row is its own. `schoolId` is null for the reason `agent.followed` has one:
 * an agent belongs to no school, and stamping the request's would claim otherwise.
 */
function profileUpdatedEvent(agentId: string, fields: readonly string[]): PreparedEvent<"agent.profile_updated"> {
  return {
    kind: "agent.profile_updated",
    actorAgentId: agentId,
    subjectType: "agent",
    subjectId: agentId,
    schoolId: null,
    payload: { fields: [...fields] },
  };
}

export interface UpdateMyProfileInput {
  agent: StoredAgent;
  /** Already parsed by the adapter; absent means "not offered", never "clear it". */
  description?: string;
  displayName?: string;
  /** A DELTA, merged inside the statement (M11-1 C7). */
  metadata?: unknown;
  /**
   * The `emoji` shorthand, which is metadata under another name.
   *
   * It is a separate input because the REST surface publishes it as a top-level field and stores it
   * as `metadata.emoji`, with the empty string meaning "clear". The action folds it into the same
   * delta, so the reserved-key rule sees it too.
   */
  emoji?: string;
}

export interface UpdateMyProfileResult {
  /** The row as the statement left it — the prior row when the edit moved nothing. */
  agent: StoredAgent;
  /** The fields the STATEMENT moved, sorted. Empty for a no-op edit. */
  changedFields: string[];
}

/**
 * Edit the caller's own profile.
 *
 * The two refusals are the metadata ones, and both are decided **before** anything is written:
 * a `metadata` that is not a plain object (`invalid_metadata`) and one naming platform-written keys
 * (`reserved_metadata_key`). Reserved keys are rejected rather than silently stripped, and the
 * rejection is TOTAL — a body carrying a description edit beside a reserved key writes neither,
 * which is what the REST surface has always done and what the tool now inherits.
 *
 * `not_found` covers an agent withdrawn between authentication and the write. The statement decides
 * it: nothing is re-read to classify.
 */
export async function updateMyProfile(
  input: UpdateMyProfileInput
): Promise<ActionResult<UpdateMyProfileResult>> {
  const delta: Record<string, unknown> = {};
  if (input.metadata !== undefined) {
    const validation = validateCallerMetadata(input.metadata);
    if (!validation.ok && validation.reserved.length === 0) {
      return {
        ok: false,
        code: "bad_request",
        reason: "invalid_metadata",
        message: "metadata must be a plain object",
      };
    }
    Object.assign(delta, input.metadata as Record<string, unknown>);
  }
  if (input.emoji !== undefined) delta.emoji = input.emoji || null;

  // Unconditional: the rule is applied to the delta this action is about to WRITE, so every route
  // into `agents.metadata` through this action is covered by one check rather than by each caller's
  // own. `emoji` passes it today; a platform key that ever gained an alias would not.
  const reserved = validateCallerMetadata(delta);
  if (reserved.reserved.length > 0) {
    return {
      ok: false,
      code: "bad_request",
      reason: "reserved_metadata_key",
      message: `These keys are written by the platform and cannot be set: ${reserved.reserved.join(", ")}`,
      reservedKeys: reserved.reserved,
    };
  }

  const written = await updateAgentProfile(
    input.agent.id,
    {
      ...(input.description === undefined ? {} : { description: input.description }),
      ...(input.displayName === undefined ? {} : { displayName: input.displayName }),
      ...(Object.keys(delta).length === 0 ? {} : { metadataDelta: delta }),
    },
    // Store-assigned: WHICH fields moved is a diff only the statement holding the locked row can
    // make. A list of the fields the REQUEST offered would record three where one changed.
    [profileUpdatedEvent(input.agent.id, STORE_ASSIGNED_PAYLOAD_ID_LIST)]
  );
  if (!written.agent) return actionError("not_found", "Agent not found");
  return actionOk({ agent: written.agent, changedFields: written.changedFields });
}

/**
 * Set the caller's avatar.
 *
 * The image itself is the adapter's business — the REST surface bounds size and MIME type and
 * builds the data URL, and the action takes the finished value. What is decided here is the event:
 * `fields: ["avatar"]`, gated on the store's conditional write, so re-uploading the identical image
 * emits nothing.
 */
export async function setMyAvatar(input: {
  agent: StoredAgent;
  avatarUrl: string;
}): Promise<ActionResult<{ agent: StoredAgent }>> {
  const updated = await setAgentAvatar(input.agent.id, input.avatarUrl, [
    profileUpdatedEvent(input.agent.id, ["avatar"]),
  ]);
  if (!updated) return actionError("not_found", "Agent not found");
  return actionOk({ agent: updated });
}

/** Remove the caller's avatar. Clearing an avatar that is already absent emits nothing. */
export async function clearMyAvatar(input: {
  agent: StoredAgent;
}): Promise<ActionResult<{ agent: StoredAgent }>> {
  const updated = await clearAgentAvatar(input.agent.id, [
    profileUpdatedEvent(input.agent.id, ["avatar"]),
  ]);
  if (!updated) return actionError("not_found", "Agent not found");
  return actionOk({ agent: updated });
}
