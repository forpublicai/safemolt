/**
 * M11-2 P1.2 — the follow graph as **one** action path, and P1.4 (u3e) — the agent LIFECYCLE.
 *
 * Registration, the two claim channels, vetting start and vetting completion join the follow graph
 * here because they are the same kind of thing: an agent-visible mutation whose refusals two
 * surfaces were each rendering, and whose write had no event. Every one of them is history-only on
 * every consumer — nothing on the platform reacts to a registration or a claim today — so what the
 * events buy is the audit half of Decision 2 rather than a projection.
 *
 * `POST/DELETE /api/v1/agents/{name}/follow` and the `follow_agent` / `unfollow_agent` tools each
 * resolved the target and rendered their own refusals, and the two surfaces already answered a
 * missing agent differently: the route publishes one 400 covering "no such agent" and "cannot follow
 * yourself", the tool names them apart. Both are legitimate presentations of the same two facts, so
 * the action reports the facts and each adapter keeps its own wording.
 *
 * **The action decides the event; the store executes it** (Decision 2). `agent.followed` rides the
 * `ON CONFLICT DO NOTHING RETURNING` that decides whether the follow is new, so a re-follow emits
 * nothing — and, since P1.2's alignment, refreshes nothing either.
 */
import {
  VETTING_BOOTSTRAP_EVALUATIONS,
  claimAgentForHumanUserWithOutcome as storeClaimAgentForHumanUserWithOutcome,
  completeVetting as storeCompleteVetting,
  createAgent as storeCreateAgent,
  createVettingChallengeIfNotVetted as storeCreateVettingChallengeIfNotVetted,
  followAgent as storeFollowAgent,
  getAgentByName,
  getVettingChallenge,
  setAgentClaimedWithOutcome as storeSetAgentClaimedWithOutcome,
  unfollowAgent as storeUnfollowAgent,
} from "@/lib/store";
import { STORE_ASSIGNED_PAYLOAD_ID, type PreparedEvent } from "@/lib/events/kinds";
import { FOUNDATION_SCHOOL_ID } from "@/lib/school-context";
import type { CompleteVettingOutcome, StoredAgent, VettingChallenge } from "@/lib/store-types";
import { validateHash } from "@/lib/vetting";

import { evaluationCompletedEvent } from "./evaluations";
import { actionError, actionOk, type ActionResult } from "./types";

export interface FollowInput {
  agent: StoredAgent;
  /** The target, as the caller named it. Resolution and its refusal are this action's. */
  targetName: string;
}

/**
 * A follow event carries NO payload: the actor column is the follower and the subject column is the
 * followee, which is the whole of the fact (`EventPayloadMap`). `schoolId` is null because a follow
 * belongs to no school — it crosses them, and stamping the actor's would claim otherwise.
 *
 * **`subject_id` is STORE-ASSIGNED, and that is a correctness rule rather than tidiness.** This
 * action resolves the name once, to tell its two refusals apart; the store resolves it again inside
 * its own call, and that second resolution is the one the locked target, the `following` row, the
 * counter and both projections use. A rename — or a withdrawal followed by a re-registration of the
 * freed name — landing between the two makes them different agents, and an event carrying the id
 * from *this* read would then be permanent history naming an agent the write never touched, and a
 * soak mismatch that no amount of re-consuming could reconcile. So the id in the event is the one
 * the store mutated, filled by the store, exactly as `createPost` fills the id it minted.
 */
function followEvent(kind: "agent.followed" | "agent.unfollowed", followerId: string): PreparedEvent {
  return {
    kind,
    actorAgentId: followerId,
    subjectType: "agent",
    subjectId: STORE_ASSIGNED_PAYLOAD_ID,
    schoolId: null,
    payload: {},
  };
}

/**
 * Follow an agent.
 *
 * The two refusals stay **distinct at this layer** even though the REST surface collapses them: the
 * tool publishes them apart, and an action that had merged them would have forced that surface to
 * re-read the name to tell them back apart.
 *
 * **That read classifies; it does not identify.** The store resolves the name again and its
 * resolution is the authoritative one — it feeds the locked target, the `following` row, the
 * counter, both transitional projections and the event's `subject_id`. This one is used only to
 * choose between two refusal strings, and a rename landing in the window therefore costs at worst a
 * slightly stale refusal rather than an event naming an agent nobody touched.
 *
 * A re-follow is success and writes nothing — the store's `ON CONFLICT DO NOTHING` decides it, and
 * both transitional projections are gated on that decision (P1.2's recorded behavior change: a
 * re-follow no longer bumps the activity trail).
 */
export async function followAgent(input: FollowInput): Promise<ActionResult<{ targetName: string }>> {
  const target = await getAgentByName(input.targetName);
  if (!target) return actionError("not_found", `Agent "@${input.targetName}" not found`);
  if (target.id === input.agent.id) return actionError("bad_request", "Cannot follow yourself");

  const followed = await storeFollowAgent(input.agent.id, input.targetName, [
    followEvent("agent.followed", input.agent.id),
  ]);
  // The store refuses when the target vanished between the lookup and its own resolution, and when
  // its resolution turns out to be the caller (a rename into the caller's own name). Both are the
  // same answer a name that never existed gets.
  if (!followed) return actionError("not_found", `Agent "@${input.targetName}" not found`);
  return actionOk({ targetName: input.targetName });
}

/**
 * Unfollow an agent.
 *
 * **Deliberately no "does this name exist?" pre-check** (M11-1 C16). One refusal covers "no such
 * agent" and "you were not following it", on both surfaces, so that unfollowing cannot be used to
 * test whether a name exists; an action that distinguished them would reopen that oracle for
 * whichever adapter chose to publish the difference.
 *
 * There is no name resolution here at all: the store resolves once, and the event's `subject_id` is
 * store-assigned from that resolution.
 */
export async function unfollowAgent(input: FollowInput): Promise<ActionResult<{ targetName: string }>> {
  const removed = await storeUnfollowAgent(input.agent.id, input.targetName, [
    followEvent("agent.unfollowed", input.agent.id),
  ]);
  if (!removed) return actionError("not_following", "Not following");
  return actionOk({ targetName: input.targetName });
}

// ===========================================================================
// M11-2 P1.4 (u3e) — agent lifecycle: registration, claim, vetting
// ===========================================================================

/**
 * The lifecycle events, in one place.
 *
 * All five are history-only on every consumer, and their subjects live in the COLUMNS: the agent is
 * the subject, and `actor_agent_id` is NULL wherever no *agent* acted. That last part is not tidiness
 * — registration is unauthenticated and a claim is performed by a human, so naming the subject as
 * its own actor would assert an authentication that never happened.
 */
function lifecycleEvent(
  kind: "agent.registered" | "agent.registration_expired" | "agent.vetting_started" | "agent.vetted",
  options: { agentId?: string; actorAgentId?: string | null } = {}
): PreparedEvent {
  return {
    kind,
    actorAgentId: options.actorAgentId ?? null,
    subjectType: "agent",
    // Store-assigned when the store mints (registration) or resolves (the release) the id itself.
    subjectId: options.agentId ?? STORE_ASSIGNED_PAYLOAD_ID,
    // An agent belongs to no school: it crosses them, and stamping one would claim otherwise. The
    // rule `agent.followed` already follows.
    schoolId: null,
    payload: {},
  };
}

/** The claim event. `channel` is the discriminator history would otherwise lose. */
function claimedEvent(channel: "cognito" | "x", agentId?: string): PreparedEvent {
  return {
    kind: "agent.claimed",
    // A HUMAN claimed it. `actor_agent_id` names agents only, and the human's id is deliberately
    // absent from the payload: it is personal data, and `user_agents` already records the link.
    actorAgentId: null,
    subjectType: "agent",
    subjectId: agentId ?? STORE_ASSIGNED_PAYLOAD_ID,
    schoolId: null,
    payload: { channel },
  };
}

/**
 * P6.1's name grammar, opened here as a **warning window** (M11-2 P1.4).
 *
 * Registration accepts any nonempty trimmed string today, so existing names may hold spaces,
 * punctuation or a single character — and those names are unmentionable once P6.1's `@` grammar
 * lands. M11a therefore *announces* rather than enforces: a nonconforming name still registers, and
 * the response carries a machine-readable deprecation the caller can act on before M11b starts
 * rejecting it (Decision 11 — never an immediate break).
 */
export const AGENT_NAME_GRAMMAR = /^[a-zA-Z0-9_-]{2,64}$/;

/** One machine-readable deprecation notice. `meta.deprecations` is a list of these. */
export interface DeprecationNotice {
  field: string;
  replacement_grammar: string;
  enforce_after: string;
}

export function nameGrammarDeprecations(name: string): DeprecationNotice[] {
  if (AGENT_NAME_GRAMMAR.test(name)) return [];
  return [
    {
      field: "name",
      replacement_grammar: "^[a-zA-Z0-9_-]{2,64}$",
      enforce_after: "M11b",
    },
  ];
}

export interface RegisterAgentInput {
  /** Already trimmed and non-empty — the adapter owns the parse, this owns the decision. */
  name: string;
  description: string;
}

export interface RegisterAgentResult {
  apiKey: string;
  claimUrl: string;
  verificationCode: string;
  id: string;
  name: string;
  /** Empty unless the name is outside P6.1's grammar. */
  deprecations: DeprecationNotice[];
}

/**
 * Register an agent, releasing a stale unclaimed name in the SAME transaction.
 *
 * **The release and the insert are one batch now, and the release's swallow is gone with it**
 * (recorded behavior change). They used to be two independently committed statements with the
 * delete's errors logged and ignored: a delete that failed left the name held and the insert then
 * failed on the unique index anyway, while a delete that succeeded and an insert that failed
 * destroyed a pristine registration for nothing. One transaction makes both outcomes atomic, and a
 * cleanup failure now fails the registration loudly rather than half-applying.
 *
 * The duplicate-name refusal stays the store's 23505 — the case-folded unique index (M11-1 C5) is
 * what decides it, and a pre-read could only disagree with the index under concurrency.
 */
export async function registerAgent(
  input: RegisterAgentInput
): Promise<ActionResult<RegisterAgentResult>> {
  try {
    const created = await storeCreateAgent(input.name, input.description, {
      releaseStaleName: true,
      events: {
        registered: [lifecycleEvent("agent.registered")],
        registrationExpired: [lifecycleEvent("agent.registration_expired")],
      },
    });
    return actionOk({
      apiKey: created.apiKey,
      claimUrl: created.claimUrl,
      verificationCode: created.verificationCode,
      id: created.id,
      name: created.name,
      deprecations: nameGrammarDeprecations(input.name),
    });
  } catch (error) {
    if (!isUniqueViolation(error)) throw error;
    return actionError("already_exists", "A bot with this name already exists. Choose a different name.");
  }
}

/** Both stores report a name collision as Postgres does, so one check covers them. */
function isUniqueViolation(error: unknown): boolean {
  return Boolean(
    error && typeof error === "object" && "code" in error && (error as { code: string }).code === "23505"
  );
}

export interface ClaimAgentWithCognitoInput {
  claimToken: string;
  humanUserId: string;
  /** The display name to record as owner, already privacy-filtered by the adapter. */
  owner?: string;
}

/**
 * Claim an agent for a signed-in human (the Cognito channel).
 *
 * The claim and the ownership row are ONE statement in the store (M11-1 C6), so a losing claimant
 * writes no `user_agents` row and a failure leaves the agent unclaimed and retryable rather than
 * claimed-but-unowned. `agent.claimed` rides that statement, and its `subject_id` comes from the
 * row the statement itself resolved from the token — never from the adapter's pre-read, which a
 * re-issued token could have made stale.
 */
export async function claimAgentWithCognito(
  input: ClaimAgentWithCognitoInput
): Promise<ActionResult<{ agent: StoredAgent }>> {
  const claimed = await storeClaimAgentForHumanUserWithOutcome(
    input.claimToken,
    input.humanUserId,
    input.owner,
    [claimedEvent("cognito")]
  );
  if (!claimed.claimed) {
    return actionError(claimed.agentExists ? "already_claimed" : "not_found", claimed.agentExists ? "This agent has already been claimed" : "Invalid claim ID");
  }
  return actionOk({ agent: claimed.agent! });
}

export interface ClaimAgentWithXInput {
  /** Resolved by the adapter from the claim token, because the external check needs the row first. */
  agentId: string;
  owner: string;
  xFollowerCount?: number;
}

/**
 * Claim an agent through the X verification tweet — the repo's second live claim channel.
 *
 * Conditional on the agent still being unclaimed, so a Cognito claim landing while the Twitter
 * search was in flight makes this one lose cleanly instead of overwriting the owner. The external
 * verification stays outside: it is a network call, and nothing about it belongs in a transaction.
 */
export async function claimAgentWithX(
  input: ClaimAgentWithXInput
): Promise<ActionResult<{ agentId: string }>> {
  const claimed = await storeSetAgentClaimedWithOutcome(input.agentId, input.owner, input.xFollowerCount, [
    claimedEvent("x", input.agentId),
  ]);
  if (!claimed.claimed) return actionError(claimed.agentExists ? "already_claimed" : "not_found", claimed.agentExists ? "This agent has already been claimed" : "Agent not found");
  return actionOk({ agentId: input.agentId });
}

/**
 * Start vetting: mint a durable challenge.
 *
 * The conditional insert is the decision. A stale caller object cannot create a challenge after the
 * agent becomes vetted between authentication and this call.
 */
export async function startVetting(input: {
  agent: StoredAgent;
}): Promise<ActionResult<{ challenge: VettingChallenge; alreadyVetted: boolean }>> {
  const outcome = await storeCreateVettingChallengeIfNotVetted(input.agent.id, [
    lifecycleEvent("agent.vetting_started", {
      agentId: input.agent.id,
      actorAgentId: input.agent.id,
    }),
  ]);
  if (!outcome.agentExists) return actionError("not_found", "Agent not found");
  if (outcome.alreadyVetted) return actionOk({ alreadyVetted: true, challenge: undefined as never });
  if (!outcome.challenge) return actionError("bad_request", "Failed to create vetting challenge");
  return actionOk({ challenge: outcome.challenge, alreadyVetted: false });
}

export interface CompleteVettingInput {
  agent: StoredAgent;
  challengeId: string;
  hash: string;
  identityMd: string;
}

/**
 * Complete vetting — the C14 batch, now carrying its events.
 *
 * **The batch's shape, lock order and consume-LAST rule are untouched** (M11-1 C14). What the action
 * adds is the event set: `agent.vetted` on the flip, and per bootstrap evaluation an
 * `evaluation.registered` gated on the fresh-registration arm plus an `evaluation.completed` gated
 * on the result. An agent that pre-registered reuses its row and emits no registration event; an
 * agent that already passed a bootstrap evaluation writes nothing for it and emits neither.
 *
 * The refusal classification stays with the adapter: `unavailable` covers a consumed challenge, an
 * expired one, a mismatched one and a lost race, and the route already re-reads to tell them apart
 * (including the lost-response retry, which must answer idempotent success rather than 410).
 */
export async function completeVetting(
  input: CompleteVettingInput
): Promise<ActionResult<CompleteVettingOutcome>> {
  const bootstrap: Record<
    string,
    { registered?: readonly PreparedEvent[]; completed?: readonly PreparedEvent[] }
  > = {};
  for (const evaluationId of VETTING_BOOTSTRAP_EVALUATIONS) {
    bootstrap[evaluationId] = {
      registered: [
        {
          kind: "evaluation.registered",
          actorAgentId: input.agent.id,
          subjectType: "evaluation_registration",
          // Store-assigned: the bootstrap registration's id is minted inside the batch, and which
          // arm produced it — a fresh insert or a reused active row — is only knowable there.
          subjectId: STORE_ASSIGNED_PAYLOAD_ID,
          schoolId: FOUNDATION_SCHOOL_ID,
          payload: { evaluation_id: evaluationId },
        },
      ],
      completed: [
        evaluationCompletedEvent({
          agentId: input.agent.id,
          // Store-assigned for the same reason, through the shared builder.
          registrationId: STORE_ASSIGNED_PAYLOAD_ID,
          evaluationId,
          passed: true,
          schoolId: FOUNDATION_SCHOOL_ID,
        }),
      ],
    };
  }

  const challenge = await getVettingChallenge(input.challengeId);
  if (challenge?.agentId === input.agent.id && challenge.consumed &&
      (input.hash === undefined || !validateHash(input.hash, challenge.expectedHash))) {
    return { ok: false, code: "bad_request", reason: "consumed_challenge", message: "Start a new vetting challenge" };
  }
  if (challenge && challenge.agentId === input.agent.id &&
      (input.hash === undefined || !validateHash(input.hash, challenge.expectedHash))) {
    return { ok: false, code: "bad_request", reason: "invalid_hash", message: "The submitted hash does not match." };
  }
  const outcome = await storeCompleteVetting(input.agent.id, input.challengeId, input.identityMd, {
    vetted: [
      lifecycleEvent("agent.vetted", { agentId: input.agent.id, actorAgentId: input.agent.id }),
    ],
    bootstrap,
  });
  if (outcome.outcome === "completed") return actionOk(outcome);
  if (outcome.reason === "already_vetted") return actionOk({ outcome: "completed", bootstrap: [] });
  const refusal = outcome.reason === "not_found"
    ? { code: "not_found" as const, reason: "challenge_not_found", message: "Invalid challenge ID" }
    : outcome.reason === "mismatch"
      ? { code: "forbidden" as const, reason: "challenge_mismatch", message: "This challenge was not issued to your agent" }
      : outcome.reason === "expired"
        ? { code: "bad_request" as const, reason: "expired_challenge", message: "The 15-second window has passed. Start a new vetting challenge." }
        : { code: "bad_request" as const, reason: "consumed_challenge", message: "Start a new vetting challenge" };
  return { ok: false, ...refusal };
}
