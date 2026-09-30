/**
 * M11b Lane D (P6.3) — direct messages as an action path, matching P1.2/P1.4's shape for
 * comments and follows: resolve the target by name, apply the domain rules, write, classify.
 *
 * **Vetted agents only, both sides.** DMs are a private trust surface, unlike posts/comments/
 * follows, so this action adds a check none of its templates needed.
 */
import { checkCommentRateLimit, getAgentByName, listDmMessages, markDmRead as storeMarkDmRead, sendDm as storeSendDm, setDmBlock as storeSetDmBlock } from "@/lib/store";
import { STORE_ASSIGNED_PAYLOAD_ID, type PreparedEvent } from "@/lib/events/kinds";
import type { ExecutionGuard } from "@/lib/store/execution-guard";
import type { StoredAgent, StoredDmMessage } from "@/lib/store-types";

import { actionError, actionOk, type ActionResult } from "./types";

/**
 * Resolve a counterpart by id, scoped to a conversation that already has history with the caller
 * (so an id cannot be used to probe for one that never existed), or by name. ID first (round 5,
 * F4): a live agent can register a name equal to a withdrawn participant's id, and a name-first
 * lookup would then hand the caller's retained thread to that unrelated survivor.
 */
export async function resolveDmCounterpart(callerId: string, nameOrId: string): Promise<string | null> {
  const priorMessages = await listDmMessages(callerId, nameOrId, { limit: 1 });
  if (priorMessages.length > 0) return nameOrId;
  const byName = await getAgentByName(nameOrId);
  return byName ? byName.id : null;
}

/**
 * `forbidden` with a `reason` — `ActionRefusalMeasurements` carries no `reason` field, so `actionError`
 * cannot express it; this is the "less code" option the spec allows over extending that parameter.
 */
function forbiddenWithReason<T>(message: string, reason: string): ActionResult<T> {
  return { ok: false, code: "forbidden", message, reason };
}

/** Shared refusal for every store guard sentinel below (codex round 3, F1). */
function guardRefusal<T>(): ActionResult<T> {
  return actionError("execution_guard_failed", "Execution guard failed: autonomy disabled or claim superseded");
}

/** The rate-limit refusal, built the same way `actions/comments.ts`'s does — DMs share the comment quota. */
function dmRateLimitRefusal<T>(rate: Awaited<ReturnType<typeof checkCommentRateLimit>>): ActionResult<T> {
  return actionError("rate_limited", "DM cooldown", {
    retryAfterSeconds: rate.retryAfterSeconds,
    dailyRemaining: rate.dailyRemaining,
  });
}

export interface SendDmInput {
  agent: StoredAgent;
  recipientName: string;
  content: string;
  /** M11-2 P3.3: populated ONLY by `agent-pulse/runner.ts` (codex round 2, F1). */
  executionGuard?: ExecutionGuard;
}

/**
 * Send a DM: validate content, resolve the recipient, require both sides vetted, write.
 *
 * `dm_blocked` has no dedicated `ActionErrorCode` (CLAUDE.md's minimal-surface rule) — it is
 * `forbidden` with `.reason = "dm_blocked"` attached post-hoc, since `actionError`'s measured-fields
 * parameter does not carry `reason` and this is the only caller that needs it.
 */
export async function sendDm(input: SendDmInput): Promise<ActionResult<{ message: StoredDmMessage }>> {
  const content = input.content.trim();
  if (content.length < 1 || content.length > 4000) {
    return actionError("bad_request", "Message must be 1-4000 characters");
  }

  const recipient = await getAgentByName(input.recipientName);
  if (!recipient) return actionError("not_found", `Agent "@${input.recipientName}" not found`);
  if (recipient.id === input.agent.id) return actionError("bad_request", "Cannot DM yourself");

  if (!input.agent.isVetted || !recipient.isVetted) {
    return actionError("vetting_required", "Both agents must be vetted to exchange direct messages");
  }

  const outcome = await storeSendDm(
    { senderId: input.agent.id, recipientId: recipient.id, content },
    [
      {
        kind: "dm.sent",
        actorAgentId: input.agent.id,
        subjectType: "dm_message",
        // Store-assigned: the message id (and the conversation id/seq the payload merge overrides)
        // are minted inside the store, after this event was decided.
        subjectId: STORE_ASSIGNED_PAYLOAD_ID,
        secondarySubjectId: recipient.id,
        schoolId: null,
        payload: {
          conversation_id: STORE_ASSIGNED_PAYLOAD_ID,
          message_id: STORE_ASSIGNED_PAYLOAD_ID,
          // Overwritten by the store's payload merge (`dms/db.ts`'s `sqlColumn("inserted.seq")`);
          // a numeric placeholder so this satisfies `EventPayloadMap['dm.sent'].seq: number`.
          seq: 0,
          recipient_agent_id: recipient.id,
        },
      } satisfies PreparedEvent<"dm.sent">,
    ],
    input.executionGuard
  );

  // M11-2 P3.3: checked first, matching `createComment` (codex round 2, F1).
  if (outcome.outcome === "execution_guard_failed") {
    return guardRefusal();
  }
  // The sender withdrew between the action's lookup and the store's write — the same missing-actor
  // refusal in both stores, answering 404 rather than a stray 429/500 (codex round 2, F4).
  if (outcome.outcome === "sender_gone") {
    return actionError("not_found", `Agent "@${input.agent.name}" not found`);
  }
  if (outcome.outcome === "blocked") {
    return forbiddenWithReason("This agent has blocked you, or you have blocked them", "dm_blocked");
  }
  if (outcome.outcome === "rate_limited") {
    return dmRateLimitRefusal(await checkCommentRateLimit(input.agent.id));
  }
  return actionOk({ message: outcome.message! });
}

export interface MarkDmReadInput {
  agent: StoredAgent;
  otherName: string;
  /** M11-2 P3.3: populated ONLY by `agent-pulse/runner.ts` (codex round 2, F1). */
  executionGuard?: ExecutionGuard;
}

/**
 * Idempotent no-op success (Tier B — no event) whether or not a conversation existed.
 * `otherName` accepts a name or (once withdrawn) an id — see `resolveDmCounterpart`. A failed guard
 * now propagates as a distinct refusal (codex round 3, F1), rather than reading as a silent no-op.
 */
export async function markDmRead(input: MarkDmReadInput): Promise<ActionResult<{ otherName: string }>> {
  const otherId = await resolveDmCounterpart(input.agent.id, input.otherName);
  if (!otherId) return actionError("not_found", `Agent "@${input.otherName}" not found`);
  const outcome = await storeMarkDmRead(input.agent.id, otherId, input.executionGuard);
  if (outcome === "execution_guard_failed") return guardRefusal();
  return actionOk({ otherName: input.otherName });
}

export interface BlockAgentInput {
  agent: StoredAgent;
  targetName: string;
  /** M11-2 P3.3: populated ONLY by `agent-pulse/runner.ts` (codex round 2, F1). */
  executionGuard?: ExecutionGuard;
}

function blockEvent(kind: "dm.blocked" | "dm.unblocked", blockerId: string, targetId: string): PreparedEvent {
  return {
    kind,
    actorAgentId: blockerId,
    subjectType: "dm_conversation",
    subjectId: STORE_ASSIGNED_PAYLOAD_ID,
    secondarySubjectId: targetId,
    schoolId: null,
    payload: { conversation_id: STORE_ASSIGNED_PAYLOAD_ID, target_agent_id: targetId },
  };
}

/**
 * Block a target (name or id — see `resolveDmCounterpart`). A failed guard is now a distinct
 * refusal (codex round 3, F1), never the same `actionOk` an already-blocked no-op would answer.
 */
export async function blockAgent(input: BlockAgentInput): Promise<ActionResult<{ targetName: string }>> {
  const targetId = await resolveDmCounterpart(input.agent.id, input.targetName);
  if (!targetId) return actionError("not_found", `Agent "@${input.targetName}" not found`);
  if (targetId === input.agent.id) return actionError("bad_request", "Cannot block yourself");

  const outcome = await storeSetDmBlock(
    input.agent.id,
    targetId,
    true,
    [blockEvent("dm.blocked", input.agent.id, targetId)],
    input.executionGuard
  );
  if (outcome === "execution_guard_failed") return guardRefusal();
  return actionOk({ targetName: input.targetName });
}

export interface UnblockAgentInput {
  agent: StoredAgent;
  targetName: string;
  /** M11-2 P3.3: populated ONLY by `agent-pulse/runner.ts` (codex round 2, F1). */
  executionGuard?: ExecutionGuard;
}

/** Unblock a target (name or id), mirroring `blockAgent`'s guard handling (no self-check needed). */
export async function unblockAgent(input: UnblockAgentInput): Promise<ActionResult<{ targetName: string }>> {
  const targetId = await resolveDmCounterpart(input.agent.id, input.targetName);
  if (!targetId) return actionError("not_found", `Agent "@${input.targetName}" not found`);

  const outcome = await storeSetDmBlock(
    input.agent.id,
    targetId,
    false,
    [blockEvent("dm.unblocked", input.agent.id, targetId)],
    input.executionGuard
  );
  if (outcome === "execution_guard_failed") return guardRefusal();
  return actionOk({ targetName: input.targetName });
}
