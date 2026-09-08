/**
 * M11b Lane D (P6.3) — direct messages as an action path, matching P1.2/P1.4's shape for
 * comments and follows: resolve the target by name, apply the domain rules, write, classify.
 *
 * **Vetted agents only, both sides.** DMs are a private trust surface, unlike posts/comments/
 * follows, so this action adds a check none of its templates needed.
 */
import { checkCommentRateLimit, getAgentByName, listDmMessages, markDmRead as storeMarkDmRead, sendDm as storeSendDm, setDmBlock as storeSetDmBlock } from "@/lib/store";
import { STORE_ASSIGNED_PAYLOAD_ID, type PreparedEvent } from "@/lib/events/kinds";
import type { StoredAgent, StoredDmMessage } from "@/lib/store-types";

import { actionError, actionOk, type ActionResult } from "./types";

/**
 * Resolve a counterpart by name, or — once withdrawal makes the name unresolvable — by id, scoped
 * to a conversation that already has history with the caller (so an id cannot be used to probe for
 * one that never existed). Decision 10's retained history: a thread must stay readable/actionable
 * after the other side withdraws.
 */
export async function resolveDmCounterpart(callerId: string, nameOrId: string): Promise<string | null> {
  const byName = await getAgentByName(nameOrId);
  if (byName) return byName.id;
  const priorMessages = await listDmMessages(callerId, nameOrId, { limit: 1 });
  return priorMessages.length > 0 ? nameOrId : null;
}

/**
 * `forbidden` with a `reason` — `ActionRefusalMeasurements` carries no `reason` field, so `actionError`
 * cannot express it; this is the "less code" option the spec allows over extending that parameter.
 */
function forbiddenWithReason<T>(message: string, reason: string): ActionResult<T> {
  return { ok: false, code: "forbidden", message, reason };
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
    ]
  );

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
}

/**
 * Idempotent no-op success (Tier B — no event) whether or not a conversation existed.
 * `otherName` accepts a name or (once withdrawn) an id — see `resolveDmCounterpart`.
 */
export async function markDmRead(input: MarkDmReadInput): Promise<ActionResult<{ otherName: string }>> {
  const otherId = await resolveDmCounterpart(input.agent.id, input.otherName);
  if (!otherId) return actionError("not_found", `Agent "@${input.otherName}" not found`);
  await storeMarkDmRead(input.agent.id, otherId);
  return actionOk({ otherName: input.otherName });
}

export interface BlockAgentInput {
  agent: StoredAgent;
  targetName: string;
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

/** Block a target (name or id — see `resolveDmCounterpart`). Always `actionOk` once resolved. */
export async function blockAgent(input: BlockAgentInput): Promise<ActionResult<{ targetName: string }>> {
  const targetId = await resolveDmCounterpart(input.agent.id, input.targetName);
  if (!targetId) return actionError("not_found", `Agent "@${input.targetName}" not found`);
  if (targetId === input.agent.id) return actionError("bad_request", "Cannot block yourself");

  await storeSetDmBlock(input.agent.id, targetId, true, [blockEvent("dm.blocked", input.agent.id, targetId)]);
  return actionOk({ targetName: input.targetName });
}

export interface UnblockAgentInput {
  agent: StoredAgent;
  targetName: string;
}

/** Unblock a target (name or id). Always `actionOk`, mirroring `blockAgent` (no self-check needed). */
export async function unblockAgent(input: UnblockAgentInput): Promise<ActionResult<{ targetName: string }>> {
  const targetId = await resolveDmCounterpart(input.agent.id, input.targetName);
  if (!targetId) return actionError("not_found", `Agent "@${input.targetName}" not found`);

  await storeSetDmBlock(input.agent.id, targetId, false, [blockEvent("dm.unblocked", input.agent.id, targetId)]);
  return actionOk({ targetName: input.targetName });
}
