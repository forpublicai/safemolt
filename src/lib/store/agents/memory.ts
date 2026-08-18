import type { AgentClaimOutcome, CompleteVettingOutcome, DeleteAgentResult, StoredAgent, VettingChallenge, VettingChallengeStartOutcome } from "@/lib/store-types";
import type { CompleteVettingEvents, CreateAgentOptions } from "./db";
import { pickRandomAgentEmoji } from "@/lib/agent-emoji";
import { generateChallengeValues, generateNonce, computeExpectedHash, getChallengeExpiry } from "@/lib/vetting";
import { activityEvents, agents, apiKeyToAgentId, assertAgentOwnsNoGroups, claimTokenToAgentId, commentCountToday, comments, certificationJobs, evaluationMessages, evaluationRegistrations, evaluationResults, evaluationSessionParticipants, evaluationSessions, following, forgetActivityProjection, forgetGroupMembershipsFor, generateChallengeId, generateId, lastCommentAt, lastPostAt, playgroundAgentMemories, posts, vettingChallenges } from "../_memory-state";
import { DISABLED_CREDENTIAL_PREFIX, generateAgentApiKey, generateClaimToken, generateVerificationCode } from "@/lib/credentials";
import { recordEvaluationResultActivityEvent, recordFollowActivityEvent } from "../activity/events";
import { updateAgentPointsFromEvaluationsSync } from "../evaluations/memory";
// A constant, not runtime coupling: the db module executes nothing at import time.
import { VETTING_BOOTSTRAP_EVALUATIONS } from "./db";
// The memory half of the crossing the db store makes inside one statement (M11-1 C6): claiming an
// agent and recording its human owner are one operation, so this module writes both.
import { getHumanUserById, linkUserToAgentSync, listLinkedAgentsForUser, ownsAgentSync, unlinkUserFromAgent } from "@/lib/human-users-memory";
import { createFollowNotificationIdempotent, forgetNotificationsForRecipient } from "../notifications/memory";
import type { PreparedEvent } from "@/lib/events/kinds";
import { appendPreparedBatch, prepareEventBatch, validatePreparedEvents } from "../events/memory";

export async function createAgent(
  name: string,
  description: string,
  options?: CreateAgentOptions
) {
  // Preflight both event groups before any stale cleanup. The DB path can roll back both
  // statements; memory must not yield between cleanup and the uniqueness check.
  const prepared = options?.events?.registered ?? [];
  validatePreparedEvents(prepared);
  const expiredTemplate = options?.events?.registrationExpired?.[0];
  if (expiredTemplate) validatePreparedEvents([expiredTemplate]);
  const cutoffTime = Date.now() - nameReleaseHours() * 60 * 60 * 1000;
  const released = options?.releaseStaleName
    ? Array.from(agents.values()).filter((agent) =>
        agent.name.toLowerCase() === name.toLowerCase() && !agent.isClaimed && !agent.isVetted &&
        !agent.lastActiveAt && new Date(agent.createdAt).getTime() < cutoffTime)
    : [];
  assertStaleReleaseHasNoForeignKeys(released);
  // M11-1 C5: case-insensitive uniqueness, mirroring the db store's unique lower(name) index.
  // Same error contract as Postgres (code 23505) so the register route's existing handler
  // classifies both stores' rejections identically. Check and insert stay in one synchronous
  // section — no `await` between them, so concurrent registrations cannot both pass the check.
  const folded = name.toLowerCase();
  for (const existing of agents.values()) {
    if (released.some((agent) => agent.id === existing.id)) continue;
    if (existing.name.toLowerCase() === folded) {
      const err = new Error(`agent name '${name}' collides case-insensitively`) as Error & { code: string };
      err.code = "23505";
      throw err;
    }
  }
  const id = generateId("agent");
  const apiKey = generateAgentApiKey();
  const claimToken = generateClaimToken();
  const verificationCode = generateVerificationCode();
  const agent: StoredAgent = {
    id,
    name,
    description,
    apiKey,
    points: 0,
    // M11-1C — not cosmetic. The db store has column defaults; this literal has none, and an
    // omitted field is `undefined`, so the first `+ 1` would produce `NaN` and silently destroy the
    // agent's karma in every no-DB run and in Jest.
    votePoints: 0,
    evaluationPoints: 0,
    legacyUnattributedPoints: 0,
    followerCount: 0,
    isClaimed: false,
    createdAt: new Date().toISOString(),
    claimToken,
    verificationCode,
    metadata: { emoji: pickRandomAgentEmoji() },
  };
  // Store-assigned subject, positionally on the primary event: the db statement writes
  // `sqlParam(1)` — the id it minted — into `subject_id`.
  const expiredEvents = options?.events?.registrationExpired ?? [];
  const expiredBatch = released.flatMap((agent) =>
    expiredEvents.map((event, index) => index === 0 ? { ...event, subjectId: agent.id } : event)
  );
  const batch = prepareEventBatch([
    ...expiredBatch,
    ...prepared.map((event, index) => (index === 0 ? { ...event, subjectId: id } : event)),
  ]);
  agents.set(id, agent);
  apiKeyToAgentId.set(apiKey, id);
  claimTokenToAgentId.set(claimToken, id);
  for (const agent of released) {
    agents.delete(agent.id);
    apiKeyToAgentId.delete(agent.apiKey);
    if (agent.claimToken) claimTokenToAgentId.delete(agent.claimToken);
  }
  appendPreparedBatch(batch);
  return {
    ...agent,
    claimUrl: `${process.env.NEXT_PUBLIC_APP_URL || "https://safemolt.com"}/claim/${claimToken}`,
    verificationCode,
  };
}

export async function getAgentById(id: string) {
  return agents.get(id) ?? null;
}

/**
 * Returns every matching agent once. Output order is storage-defined, so callers
 * must build an id-indexed map instead of relying on input order.
 */
export async function getAgentsByIds(ids: string[]) {
  const idSet = new Set(ids.filter(Boolean));
  if (idSet.size === 0) return [];
  return Array.from(agents.values()).filter((agent) => idSet.has(agent.id));
}

export async function getAgentByName(name: string) {
  const list = Array.from(agents.values());
  return list.find((a) => a.name.toLowerCase() === name.toLowerCase()) ?? null;
}

export async function getAgentByClaimToken(claimToken: string) {
  // A disabled_-prefixed claim token never resolves (M11-1 C19), mirroring the db store and
  // getAgentFromRequest — a claim token is a credential.
  if (claimToken.startsWith(DISABLED_CREDENTIAL_PREFIX)) return null;
  const id = claimTokenToAgentId.get(claimToken);
  return id ? agents.get(id) ?? null : null;
}

const DEFAULT_NAME_RELEASE_HOURS = 1;

/** Validated before use: `parseInt` yields NaN for a malformed value (M11-1 C4). */
function nameReleaseHours(): number {
  // Strict: `Number.parseInt` would accept "24hours" as 24 and silently truncate "1.5" to 1.
  // A window nobody meant to configure is worse than the documented default.
  const raw = (process.env.AGENT_NAME_RELEASE_HOURS || "").trim();
  if (!/^\d+$/.test(raw)) return DEFAULT_NAME_RELEASE_HOURS;
  const parsed = Number(raw);
  // `^\d+$` alone is not "a number": a long enough digit string converts to `Infinity`. Here that
  // produced a `-Infinity` cutoff, so the cleanup silently released nothing — the two stores failed
  // the same input in opposite directions, which is exactly the parity this chunk exists to hold.
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : DEFAULT_NAME_RELEASE_HOURS;
}

/**
 * Release a name held by a *pristine* unclaimed registration past the release window.
 *
 * Mirrors the db predicate exactly (M11-1 C4). Note this side has no equivalent of the db's
 * swallowed 42883, so the identity-destruction primitive **is** live here — memory mode is Jest
 * and no-DB development, which is also where a naive test would be written.
 */
export async function cleanupStaleUnclaimedAgent(name: string) {
  try {
    await releaseStaleNameForRegistration(name);
  } catch (e) {
    // Log but don't fail provisioning if cleanup fails — the standalone export keeps the swallow
    // for its one remaining caller, exactly as the db twin does.
    console.error(`[cleanupStaleUnclaimedAgent] Failed to cleanup ${name}:`, e);
  }
}

/**
 * The release itself, shared by the standalone export and by `createAgent`'s batched form.
 *
 * ONE event per released row, mirroring the db fragment's `rowSource` — a shared template with the
 * row's own id substituted in, which is what `sqlColumn("released.id")` renders there.
 */
async function releaseStaleNameForRegistration(
  name: string,
  events?: readonly PreparedEvent[]
): Promise<void> {
  validatePreparedEvents(events);
  const cutoffTime = Date.now() - nameReleaseHours() * 60 * 60 * 1000;
  const released: StoredAgent[] = [];
  for (const agent of Array.from(agents.values())) {
    if (
      agent.name.toLowerCase() === name.toLowerCase() &&
      !agent.isClaimed &&
      !agent.isVetted &&
      !agent.lastActiveAt &&
      new Date(agent.createdAt).getTime() < cutoffTime) {
      released.push(agent);
    }
  }
  if (released.length === 0) return;
  assertStaleReleaseHasNoForeignKeys(released);
  const batch = prepareEventBatch(
    released.flatMap((agent) =>
      (events ?? []).map((event, index) => index === 0 ? { ...event, subjectId: agent.id } : event)
    )
  );
  for (const agent of released) {
    agents.delete(agent.id);
    apiKeyToAgentId.delete(agent.apiKey);
    if (agent.claimToken) claimTokenToAgentId.delete(agent.claimToken);
  }
  await appendPreparedBatch(batch).dispatched;
}

/** PostgreSQL cannot release a stale agent while any non-cascading FK points at it. */
function assertStaleReleaseHasNoForeignKeys(released: readonly StoredAgent[]): void {
  const releasedIds = new Set(released.map((agent) => agent.id));
  for (const [followerId, followees] of following) {
    if (releasedIds.has(followerId) || Array.from(followees).some((id) => releasedIds.has(id))) {
      const error = new Error("stale agent is referenced by following") as Error & { code: string; constraint: string };
      error.code = "23503";
      error.constraint = "following_followee_id_fkey";
      throw error;
    }
  }
}

/**
 * Authenticate by api key and stamp `last_active_at` in one synchronous section.
 *
 * "Already atomic by construction" would be wrong here, and it is worth stating why: lookup and
 * touch used to be two separate async functions invoked as two awaits, and **every `await` yields
 * the event loop** — so a cleanup scheduled in between runs before the touch and reproduces the
 * exact first-authentication deletion race the db side closes with one statement. There is no
 * `await` between the read and the map write below, which is what makes this equivalent.
 */
export async function authenticateAndTouchByApiKey(
  apiKey: string,
  staleAfterMs = 5 * 60 * 1000
): Promise<StoredAgent | null> {
  const id = apiKeyToAgentId.get(apiKey);
  if (!id) return null;
  const agent = agents.get(id);
  if (!agent) return null;

  const last = agent.lastActiveAt ? Date.parse(agent.lastActiveAt) : 0;
  if (!Number.isFinite(last) || Date.now() - last >= staleAfterMs) {
    const touched = { ...agent, lastActiveAt: new Date().toISOString() };
    agents.set(id, touched);
    return touched;
  }
  return agent;
}

/** Conditional, and reports whether this caller won — see the db store (M11-1 C6). */
export async function setAgentClaimed(
  id: string,
  owner?: string,
  xFollowerCount?: number,
  events?: readonly PreparedEvent[]
): Promise<boolean> {
  validatePreparedEvents(events);
  const a = agents.get(id);
  if (!a || a.isClaimed) return false;
  const batch = prepareEventBatch(events);
  agents.set(id, {
    ...a,
    isClaimed: true,
    owner: owner ?? a.owner,
    ...(xFollowerCount !== undefined && { xFollowerCount }),
  });
  await appendPreparedBatch(batch).dispatched;
  return true;
}

export async function setAgentClaimedWithOutcome(
  id: string,
  owner?: string,
  xFollowerCount?: number,
  events?: readonly PreparedEvent[]
): Promise<AgentClaimOutcome<StoredAgent>> {
  validatePreparedEvents(events);
  const agent = agents.get(id);
  if (!agent) return { agentExists: false, claimed: false };
  if (agent.isClaimed) return { agentExists: true, claimed: false };
  const batch = prepareEventBatch(events);
  const nextAgent = Object.assign({}, agent, { isClaimed: true, owner: owner ?? agent.owner },
    xFollowerCount !== undefined ? { xFollowerCount } : {}) as StoredAgent;
  agents.set(id, nextAgent);
  try {
    await appendPreparedBatch(batch).dispatched;
  } catch (error) {
    agents.set(id, Object.assign({}, agent));
    throw error;
  }
  return { agentExists: true, claimed: true, agent: nextAgent };
}

/**
 * Memory-mode counterpart of the db store's single claim statement (M11-1 C6).
 *
 * Two properties have to match the db path, not just one:
 *
 *  - **One winner.** The claim check and the agent mutation are a single synchronous section, so a
 *    concurrent claim cannot pass the same check. Every `await` yields the event loop, and
 *    splitting them is exactly the race the db store had.
 *  - **All or nothing.** In db mode a nonexistent `humanUserId` violates the `user_agents →
 *    human_users` foreign key and rolls the whole statement back, leaving the agent unclaimed and
 *    retryable. The memory `linkUserToAgent` has no such constraint — it happily records a link for
 *    a user that does not exist — so memory would have *committed a claim db mode refuses*. That is
 *    reachable rather than theoretical: failed Cognito provisioning yields an `err_<sub>` id
 *    (`src/auth.ts`). The user is therefore validated **before** the mutation, which is also the
 *    memory-store discipline this milestone follows: throwing work first, then a mutation that
 *    cannot throw.
 */
export async function claimAgentForHumanUser(
  claimToken: string,
  humanUserId: string,
  owner?: string,
  events?: readonly PreparedEvent[]
): Promise<StoredAgent | null> {
  // The decisive claim carries the same disabled-credential guard as the lookup and as db mode
  // (M11-1 C19; review round 2, m6): the store-level invariant must hold for a direct caller,
  // not only for callers that happen to pre-read through getAgentByClaimToken.
  if (claimToken.startsWith(DISABLED_CREDENTIAL_PREFIX)) return null;
  validatePreparedEvents(events);
  const human = await getHumanUserById(humanUserId);
  const priorLinks = await listLinkedAgentsForUser(humanUserId);
  // **Re-resolved by TOKEN after the await, and the subject comes from THAT resolution.** The human
  // lookup above yields the event loop, so the id read before it is stale when this resumes; the db
  // statement resolves the token inside itself and its `sqlColumn("claimed.id")` names the row it
  // actually claimed. Reading the map again is the memory twin of that.
  return (await claimAgentForHumanUserAfterLookup(claimToken, humanUserId, owner, events, priorLinks.find((link) => link.agent.id === claimTokenToAgentId.get(claimToken))?.linkRole, Boolean(human))).agent ?? null;
}

async function claimAgentForHumanUserAfterLookup(
  claimToken: string,
  humanUserId: string,
  owner?: string,
  events?: readonly PreparedEvent[],
  priorRole?: string,
  humanExists = true,
): Promise<AgentClaimOutcome<StoredAgent>> {
  const resolvedId = claimTokenToAgentId.get(claimToken);
  if (!resolvedId) return { agentExists: false, claimed: false };
  const agent = agents.get(resolvedId);
  if (!agent) return { agentExists: false, claimed: false };
  if (agent.isClaimed) return { agentExists: true, claimed: false };
  if (!humanExists) throw new Error(`claimAgentForHumanUser: unknown human user ${humanUserId}`);
  const batch = prepareEventBatch((events ?? []).map((event, index) =>
    index === 0 ? { ...event, subjectId: resolvedId } : event
  ));
  const claimed: StoredAgent = { ...agent, isClaimed: true, owner: owner ?? agent.owner };
  agents.set(resolvedId, claimed);
  linkUserToAgentSync(humanUserId, resolvedId, "owner");
  const { dispatched } = appendPreparedBatch(batch);
  try {
    await dispatched;
  } catch (error) {
    agents.set(resolvedId, { ...agent });
    await unlinkUserFromAgent(humanUserId, resolvedId);
    if (priorRole !== undefined) linkUserToAgentSync(humanUserId, resolvedId, priorRole);
    throw error;
  }
  return { agentExists: true, claimed: true, agent: claimed };
}

export async function claimAgentForHumanUserWithOutcome(
  claimToken: string,
  humanUserId: string,
  owner?: string,
  events?: readonly PreparedEvent[]
): Promise<AgentClaimOutcome<StoredAgent>> {
  if (claimToken.startsWith(DISABLED_CREDENTIAL_PREFIX)) return { agentExists: false, claimed: false };
  validatePreparedEvents(events);
  const human = await getHumanUserById(humanUserId);
  const priorLinks = await listLinkedAgentsForUser(humanUserId);
  const resolvedId = claimTokenToAgentId.get(claimToken);
  return claimAgentForHumanUserAfterLookup(claimToken, humanUserId, owner, events, priorLinks.find((link) => link.agent.id === resolvedId)?.linkRole, Boolean(human));
}

export async function setAgentUnclaimed(id: string) {
  const a = agents.get(id);
  if (a) agents.set(id, { ...a, isClaimed: false, owner: undefined });
}

/** Best-effort removal for in-memory store (tests / no DB). */
export async function deleteAgent(agentId: string): Promise<DeleteAgentResult> {
  const a = agents.get(agentId);
  if (!a) return { ok: false, reason: "not_found" };
  try {
    assertAgentIsNotRecordedProctor(agentId);
    // **Refused before anything is swept**, mirroring `groups.owner_id REFERENCES agents(id)` — a
    // foreign key with NO cascade, so Postgres answers `DELETE FROM agents` with `23503` rather
    // than leaving a group whose owner does not exist. Skipping the owner's own membership was only
    // half the rule: the agent row still went, and `groups.ownerId` was left dangling. It raises
    // rather than returning, so the `catch` below renders it as the `foreign_key` refusal it
    // already renders every other raised constraint as.
    assertAgentOwnsNoGroups(agentId);
    for (const [pid, p] of Array.from(posts.entries())) {
      if (p.authorId === agentId) posts.delete(pid);
    }
    for (const [cid, c] of Array.from(comments.entries())) {
      if (c.authorId === agentId) comments.delete(cid);
    }
    following.delete(agentId);
    for (const [fid, set] of Array.from(following.entries())) {
      if (set.has(agentId)) {
        const next = new Set(set);
        next.delete(agentId);
        following.set(fid, next);
      }
    }
    // Canonical GROUP MEMBERSHIP, mirroring `group_members.agent_id … ON DELETE CASCADE`
    // (M11-2 P1.3). Without it a withdrawn agent stayed a member for `isGroupMember`, the member
    // count, the member listing and `listFeed`, while Postgres had already removed the row. The
    // helper carries the two exceptions the db schema imposes — the legacy snapshot and owners.
    forgetGroupMembershipsFor(agentId);
    lastPostAt.delete(agentId);
    lastCommentAt.delete(agentId);
    commentCountToday.delete(agentId);
    apiKeyToAgentId.delete(a.apiKey);
    if (a.claimToken) claimTokenToAgentId.delete(a.claimToken);
    // The db side cascades these via FK (M11-1 C14, M11-1b D5); memory must sweep explicitly.
    deleteChallengesForAgent(agentId);
    deletePlaygroundMemoriesForAgent(agentId);
    // The withdrawn agent's FOLLOW projections, mirroring the db batch's own cleanup elements. A
    // `follow:{follower}:{followee}` trail row survived its followee's withdrawal forever, still
    // describing an agent that no longer exists — and M11-2's activity consumer locks the followee
    // and skips when it is gone, so the legacy row and the consumer would disagree permanently.
    // Only the FOLLOWEE side: a withdrawn FOLLOWER's row stays, because the consumer still writes
    // it, falling back to the raw id exactly as the inline writer always has.
    for (const item of Array.from(activityEvents.values())) {
      if (item.kind !== "follow") continue;
      if ((item.metadata as { followee_id?: string } | undefined)?.followee_id !== agentId) continue;
      forgetActivityProjection("follow", item.id);
    }
    deleteEvaluationMemoryForAgent(agentId);
    // The withdrawn agent's INBOX, mirroring `notifications.agent_id … ON DELETE CASCADE`. Only the
    // recipient side cascades in Postgres — `actor` and `metadata` are JSONB and reference nothing —
    // so a notification about this agent held by somebody else stays, on both sides. The sweep goes
    // through the notifications module because it owns the dedup-key sidecar, which has to die with
    // the rows or a replayed event would be refused here and admitted in Postgres.
    forgetNotificationsForRecipient(agentId);
    agents.delete(agentId);
    return { ok: true };
  } catch {
    return { ok: false, reason: "foreign_key" };
  }
}

export async function listAgents(sort: "recent" | "points" | "followers" = "recent") {
  let list = Array.from(agents.values());
  if (sort === "followers") list = list.filter((a) => a.isClaimed);
  if (sort === "points") list.sort((a, b) => b.points - a.points);
  else if (sort === "followers") list.sort((a, b) => (b.xFollowerCount ?? 0) - (a.xFollowerCount ?? 0));
  else list.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
  return list;
}

export async function countAgents(){
  return agents.size;
}

/**
 * The memory twin of the follow statements' `subject_id` override: the store's OWN resolution.
 *
 * Positional, on the primary event only, for the reason `substitutePrimaryEvent` gives in
 * `posts/memory.ts` — the db side applies `overrides[0]` and leaves every later event alone.
 */
function withFollowSubject(events: readonly PreparedEvent[], followeeId: string): PreparedEvent[] {
  return events.map((event, index) => (index === 0 ? { ...event, subjectId: followeeId } : event));
}

/**
 * Follow an agent — the memory twin of the db store's single statement (M11-2 P1.2).
 *
 * **Both transitional projections are gated on FIRST INSERTION now**, which for the activity row is
 * a recorded behavior change: a re-follow no longer refreshes the trail. The db store makes the same
 * change, and P1.2's follow-alignment paragraph is why — a re-follow emits no event, so a legacy
 * writer that kept refreshing would log a false payload mismatch on every duplicate in the soak.
 */
export async function followAgent(
  followerId: string,
  followeeName: string,
  events?: readonly PreparedEvent[]
) {
  // The one authoritative resolution — see the db twin. The event's `subject_id` is filled from it.
  const followee = await getAgentByName(followeeName);
  if (!followee || followee.id === followerId) return false;
  const prepared = withFollowSubject(events ?? [], followee.id);
  // Kind and payload here, which is where the db store renders — it resolves the name and refuses a
  // self-follow before building its statement, so validating ahead of that would throw where
  // Postgres answers `false`.
  validatePreparedEvents(prepared);
  // ---- One synchronous section from here down. The `await` above is the ONLY one, and it is
  // exactly where the eligibility read goes stale (Decision 4). ----
  //
  // **Re-validated after the await, and this is the db store's locked target.** `agents` is a live
  // map: a withdrawal committing while the resolution's continuation waited its turn would leave
  // this call adding a dangling `following` edge to an agent that no longer exists and appending
  // `agent.followed` for it, while `agents.get` came up empty and the counter and both projections
  // were silently skipped — a write with no subject and an event with no write. Postgres refuses the
  // same race correctly: `target AS (SELECT id FROM agents WHERE id = $2 FOR KEY SHARE)` matches
  // nothing and the gated insert writes nothing.
  //
  // **By ID, never by name.** The db statement locks the id it resolved, so an agent that merely
  // RENAMED itself in the window is still followed there; re-checking the name here would refuse
  // where Postgres proceeds. The case that must refuse — withdrawal, including a withdrawal whose
  // freed name a new agent then took — is exactly "this id is gone".
  // **BOTH ids**, not just the followee. The follower is the actor, and a caller that withdrew
  // during the resolution would otherwise leave a `following` edge and an `agent.followed` event
  // owned by an agent that no longer exists. Postgres refuses the same race through
  // `following.follower_id REFERENCES agents(id)`.
  if (!agents.has(followee.id) || !agents.has(followerId)) return false;
  // Inspected, NOT installed: an agent with no follows must not acquire an empty set as a side
  // effect of a call that then refuses, or of a `prepareEventBatch` that throws. The set is created
  // in the mutate section below, where every check has already passed.
  const existing = following.get(followerId);
  // A duplicate follow writes nothing and emits nothing — the memory twin of `ON CONFLICT DO
  // NOTHING RETURNING` matching no row. Returned before the uniqueness preflight, because the db
  // event insert is gated on that same insert and raises no 23505 for a refused retry.
  if (existing?.has(followee.id)) return true;
  const batch = prepareEventBatch(prepared);
  // The synchronous section: the row, the counter and the append, with no `await` between them.
  const set = existing ?? new Set<string>();
  if (!existing) following.set(followerId, set);
  set.add(followee.id);
  const a = agents.get(followee.id);
  if (a) agents.set(followee.id, { ...a, followerCount: a.followerCount + 1 });
  const { stored, dispatched } = appendPreparedBatch(batch);
  const sourceEventId = stored[0]?.id;
  // The event's own `created_at`: the activity consumer projects it into `occurred_at` for this
  // kind, because a follow carries no timestamp anywhere else.
  const createdAt = stored[0]?.createdAt ?? new Date().toISOString();
  void recordFollowActivityEvent(
    {
      followerId,
      followeeId: followee.id,
      // The LIVE row's names, not the pre-await resolution: the db statement labels from the row
      // it locked, so a rename landing in the resolve window must read the same on both sides.
      followeeName: (a ?? followee).name,
      followeeDisplayName: (a ?? followee).displayName,
      createdAt,
    },
    { sourceEventId }
  );
  // Through the consumer's own idempotent writer, carrying Decision 6's key. **P2.1 removes this.**
  void createFollowNotificationIdempotent({
    dedupKey: sourceEventId === undefined ? null : `new_follower:${followee.id}:${sourceEventId}`,
    recipientAgentId: followee.id,
    actorAgentId: followerId,
    createdAt,
  });
  await dispatched;
  return true;
}

export async function unfollowAgent(
  followerId: string,
  followeeName: string,
  events?: readonly PreparedEvent[]
) {
  // The one authoritative resolution — see `followAgent`.
  const followee = await getAgentByName(followeeName);
  if (!followee) return false;
  const prepared = withFollowSubject(events ?? [], followee.id);
  validatePreparedEvents(prepared);
  // One synchronous section from here down; the membership check below is what goes stale across the
  // await, and it is re-read here rather than carried. A withdrawal in the window removes the edge
  // (`deleteAgent` sweeps both directions), so this answers `false` exactly as the db `DELETE …
  // RETURNING` does when the row is already gone.
  const set = following.get(followerId);
  if (!set || !set.has(followee.id)) return false;
  const batch = prepareEventBatch(prepared);
  set.delete(followee.id);
  const a = agents.get(followee.id);
  if (a) agents.set(followee.id, { ...a, followerCount: Math.max(0, a.followerCount - 1) });
  const { dispatched } = appendPreparedBatch(batch);
  await dispatched;
  return true;
}

export async function isFollowing(followerId: string, followeeName: string) {
  const followee = await getAgentByName(followeeName);
  if (!followee) return false;
  return following.get(followerId)?.has(followee.id) ?? false;
}

export async function getFollowingCount(agentId: string) {
  return following.get(agentId)?.size ?? 0;
}

/** `metadata` is deliberately absent — see the db implementation (M11-1 C7). */
export async function updateAgent(agentId: string, updates: {
  name?: string;
  description?: string;
  displayName?: string;
  lastActiveAt?: string;
}) {
  const a = agents.get(agentId);
  if (!a) return null;
  if (updates.name !== undefined) {
    const trimmed = updates.name.trim();
    if (trimmed) {
      const clash = Array.from(agents.values()).find(
        (x) => x.id !== agentId && x.name.toLowerCase() === trimmed.toLowerCase()
      );
      if (clash) return null;
    }
  }
  const next = { ...a };
  if (updates.name !== undefined) {
    const trimmed = updates.name.trim();
    if (trimmed) next.name = trimmed;
  }
  if (updates.description !== undefined) next.description = updates.description;
  if (updates.displayName !== undefined) next.displayName = updates.displayName.trim() || undefined;
  if (updates.lastActiveAt !== undefined) next.lastActiveAt = updates.lastActiveAt;
  agents.set(agentId, next);
  return next;
}

/**
 * Merge a metadata delta in one synchronous section.
 *
 * Mirrors the db `COALESCE(metadata,'{}') || $delta` (M11-1 C7): the read and the write are not
 * separated by an `await`, so a concurrent platform credential write cannot be reverted by a
 * stale copy — which is the race the whole-object sink used to allow on both sides.
 */
export async function mergeAgentMetadata(agentId: string, delta: Record<string, unknown>) {
  const a = agents.get(agentId);
  if (!a) return null;
  const next = {
    ...a,
    metadata: { ...(a.metadata ?? {}), ...delta },
  };
  agents.set(agentId, next);
  return next;
}

/**
 * Canonical JSON, so a metadata comparison agrees with `jsonb`'s.
 *
 * Postgres compares `jsonb` structurally and key-order-independently, so `{"a":1,"b":2}` and
 * `{"b":2,"a":1}` are the SAME value there. A bare `JSON.stringify` disagrees, and the disagreement
 * shows up exactly where it matters: a delta that reorders a nested object would be "no change" in
 * the db store and "changed" here — one store emitting an event the other does not.
 */
function canonicalJson(value: unknown): string {
    if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
    if (value && typeof value === "object") {
        const entries = Object.entries(value as Record<string, unknown>)
            .filter(([, v]) => v !== undefined)
            .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
        return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(",")}}`;
    }
    return JSON.stringify(value ?? null);
}

/**
 * The before/after diff the db twin makes in SQL — the `moved` CTE, field for field.
 *
 * `display_name` is trimmed and an empty result clears the column, mirroring
 * `NULLIF(BTRIM($5), '')`; `metadata` is MERGED and compared canonically, mirroring
 * `p.metadata IS DISTINCT FROM (COALESCE(p.metadata,'{}') || $7)`. Sorted, because the db side
 * aggregates `ORDER BY field`.
 */
function diffAgentProfile(
  prior: StoredAgent,
  updates: import("./db").AgentProfileUpdate
): { next: StoredAgent; changedFields: string[] } {
  const next = { ...prior };
  const changedFields: string[] = [];
  if (updates.description !== undefined && prior.description !== updates.description) {
    next.description = updates.description;
    changedFields.push("description");
  }
  const displayName = updates.displayName?.trim() || undefined;
  if (updates.displayName !== undefined && prior.displayName !== displayName) {
    next.displayName = displayName;
    changedFields.push("display_name");
  }
  const merged = { ...(prior.metadata ?? {}), ...(updates.metadataDelta ?? {}) };
  if (updates.metadataDelta !== undefined && canonicalJson(prior.metadata ?? null) !== canonicalJson(merged)) {
    next.metadata = merged;
    changedFields.push("metadata");
  }
  return { next, changedFields: changedFields.sort() };
}

/**
 * The memory twin of `updateAgentProfile` — one conditional edit, the same diff, the same event.
 *
 * `validatePreparedEvents` runs FIRST because the db twin renders its events before it executes
 * anything, so a bad kind is refused there whether or not the agent exists. The idempotency
 * preflight (`prepareEventBatch`) runs only on the path that writes, because the db side's event
 * CTE is gated on `updated` and therefore inserts nothing — and collides with nothing — when the
 * edit is a no-op.
 *
 * No `await` between the diff and the write, so no eligibility re-check is owed here.
 */
export async function updateAgentProfile(
  agentId: string,
  updates: import("./db").AgentProfileUpdate,
  events?: readonly PreparedEvent[]
): Promise<import("./db").AgentProfileUpdateResult> {
  validatePreparedEvents(events);
  const prior = agents.get(agentId);
  if (!prior) return { agent: null, changedFields: [] };

  const { next, changedFields } = diffAgentProfile(prior, updates);
  if (changedFields.length === 0) return { agent: prior, changedFields: [] };

  // The PRIMARY event carries the statement's diff, substituted positionally — the db side merges
  // the same list over the same event (index 0), and a kind-keyed rule would diverge for a batch.
  const batch = prepareEventBatch(
    (events ?? []).map((event, position) =>
      position === 0
        ? ({ ...event, payload: { ...(event.payload as object), fields: changedFields } } as PreparedEvent)
        : event
    )
  );
  agents.set(agentId, next);
  await appendPreparedBatch(batch).dispatched;
  return { agent: next, changedFields };
}

export async function touchAgentLastActiveAtIfStale(agentId: string, staleAfterMs = 5 * 60 * 1000) {
  const agent = agents.get(agentId);
  if (!agent) return;
  const last = agent.lastActiveAt ? Date.parse(agent.lastActiveAt) : 0;
  if (!Number.isFinite(last) || Date.now() - last >= staleAfterMs) {
    agents.set(agentId, { ...agent, lastActiveAt: new Date().toISOString() });
  }
}

/**
 * The memory twin of the two avatar writes: conditional on the value actually moving, so an
 * identical re-upload and a clear of an absent avatar write nothing and emit nothing — which is
 * what the db twin's `IS DISTINCT FROM` predicate decides there.
 */
async function writeAgentAvatar(
  agentId: string,
  avatarUrl: string | undefined,
  events?: readonly PreparedEvent[]
) {
  validatePreparedEvents(events);
  const a = agents.get(agentId);
  if (!a) return null;
  if ((a.avatarUrl ?? undefined) === avatarUrl) return a;
  // Return the value this write stored, never a re-read after the dispatch await: a withdrawal
  // landing in that window would otherwise make the map read empty and report a spurious null for
  // a write that already happened — the db twin returns the statement's own row for the same reason.
  const next = { ...a, avatarUrl };
  const batch = prepareEventBatch(events);
  agents.set(agentId, next);
  await appendPreparedBatch(batch).dispatched;
  return next;
}

export async function setAgentAvatar(agentId: string, avatarUrl: string, events?: readonly PreparedEvent[]) {
  return writeAgentAvatar(agentId, avatarUrl, events);
}

export async function clearAgentAvatar(agentId: string, events?: readonly PreparedEvent[]) {
  return writeAgentAvatar(agentId, undefined, events);
}

export async function createVettingChallenge(agentId: string, events?: readonly PreparedEvent[]) {
  validatePreparedEvents(events);
  if (!agents.has(agentId)) {
    const error = new Error(`agent ${agentId} does not exist`) as Error & { code: string; constraint: string };
    error.code = "23503";
    error.constraint = "vetting_challenges_agent_id_fkey";
    throw error;
  }
  const id = generateChallengeId();
  const values = generateChallengeValues();
  const nonce = generateNonce();
  const expectedHash = computeExpectedHash(values, nonce);
  const createdAt = new Date().toISOString();
  const expiresAt = getChallengeExpiry();

  const challenge: VettingChallenge = {
    id,
    agentId,
    values,
    nonce,
    expectedHash,
    createdAt,
    expiresAt,
    fetched: false,
    consumed: false,
  };

  // The subject is the AGENT, supplied by the action — the same column the db statement fills from
  // its own parameter. Preflight, mutate, append, with no `await` in between.
  const batch = prepareEventBatch(events);
  vettingChallenges.set(id, challenge);
  await appendPreparedBatch(batch).dispatched;
  return challenge;
}

export async function createVettingChallengeIfNotVetted(
  agentId: string,
  events?: readonly PreparedEvent[]
): Promise<VettingChallengeStartOutcome> {
  validatePreparedEvents(events);
  const agent = agents.get(agentId);
  if (!agent) return { agentExists: false, created: false, alreadyVetted: false };
  if (agent.isVetted) return { agentExists: true, created: false, alreadyVetted: true };
  const challenge = await createVettingChallenge(agentId, events);
  return { agentExists: true, created: true, alreadyVetted: false, challenge };
}

export async function getVettingChallenge(id: string) {
  return vettingChallenges.get(id) ?? null;
}

export async function markChallengeFetched(id: string) {
  const challenge = vettingChallenges.get(id);
  if (!challenge) return false;
  vettingChallenges.set(id, { ...challenge, fetched: true });
  return true;
}

export async function consumeVettingChallenge(id: string) {
  const challenge = vettingChallenges.get(id);
  if (!challenge || challenge.consumed) return false;
  vettingChallenges.set(id, { ...challenge, consumed: true });
  return true;
}

/** Mirrors the db-side bounded maintenance delete: expired past the retention window only. */
export async function pruneExpiredVettingChallenges(retentionMs: number) {
  const cutoff = Date.now() - retentionMs;
  let pruned = 0;
  for (const [id, challenge] of vettingChallenges) {
    if (new Date(challenge.expiresAt).getTime() < cutoff) {
      vettingChallenges.delete(id);
      pruned += 1;
    }
  }
  return pruned;
}

/** The shared agent-deletion path calls this (M11-1 C14): the db side cascades via FK; the
 *  memory side must sweep explicitly or challenge rows outlive their agent. */
export function deleteChallengesForAgent(agentId: string): void {
  for (const [id, challenge] of vettingChallenges) {
    if (challenge.agentId === agentId) vettingChallenges.delete(id);
  }
}

/** Same story for playground episodic memories (M11-1b D5): db cascades, memory must sweep. */
function deletePlaygroundMemoriesForAgent(agentId: string): void {
  for (const [k, memory] of playgroundAgentMemories) {
    if (memory.agentId === agentId) playgroundAgentMemories.delete(k);
  }
}

/** Mirrors the evaluation foreign-key cascade before the candidate agent is removed. */
function deleteEvaluationMemoryForAgent(agentId: string): void {
  const registrationIds = new Set(
    Array.from(evaluationRegistrations.values())
      .filter((registration) => registration.agentId === agentId)
      .map((registration) => registration.id)
  );
  const sessionIds = new Set(
    Array.from(evaluationSessions.values())
      .filter((session) => session.registrationId != null && registrationIds.has(session.registrationId))
      .map((session) => session.id)
  );
  for (const [id, message] of evaluationMessages) {
    if (sessionIds.has(message.sessionId) || message.senderAgentId === agentId) evaluationMessages.delete(id);
  }
  for (const [id, participant] of evaluationSessionParticipants) {
    if (participant.agentId === agentId || sessionIds.has(participant.sessionId)) {
      evaluationSessionParticipants.delete(id);
    }
  }
  for (const [id, job] of certificationJobs) {
    if (job.agentId === agentId || registrationIds.has(job.registrationId)) certificationJobs.delete(id);
  }
  for (const [id, result] of evaluationResults) {
    if (result.agentId === agentId || registrationIds.has(result.registrationId)) evaluationResults.delete(id);
  }
  for (const id of sessionIds) evaluationSessions.delete(id);
  for (const id of registrationIds) evaluationRegistrations.delete(id);
}

/** `evaluation_results.proctor_agent_id` has no ON DELETE CASCADE, so Postgres refuses this delete. */
function assertAgentIsNotRecordedProctor(agentId: string): void {
  if (Array.from(evaluationResults.values()).some((result) => result.proctorAgentId === agentId)) {
    const error = new Error(
      `update or delete on table "agents" violates foreign key constraint on evaluation_results`
    ) as Error & { code: string };
    error.code = "23503";
    throw error;
  }
}

/**
 * One bootstrap evaluation's writes, deliberately synchronous (no `await` anywhere): skipped
 * entirely when a passed result exists, else the newest active registration transitions — or a
 * terminal one is inserted — and exactly one result is recorded. Mirrors the db batch's
 * self-contained CTE. Returns the result id, or null when already passed.
 */
function recordBootstrapPassSync(
  agentId: string,
  spec: { evaluationId: string; pointsEarned: number | null; evaluationVersion: string },
  now: string,
  challengeId: string,
  identityMd: string
): { resultId: string; registrationId: string; freshRegistration: boolean } | null {
  const alreadyPassed = Array.from(evaluationResults.values()).some(
    (r) => r.agentId === agentId && r.evaluationId === spec.evaluationId && r.passed
  );
  if (alreadyPassed) return null;

  const activeReg = Array.from(evaluationRegistrations.values())
    .filter(
      (r) =>
        r.agentId === agentId &&
        r.evaluationId === spec.evaluationId &&
        (r.status === "registered" || r.status === "in_progress")
    )
    .sort((a, b) => b.registeredAt.localeCompare(a.registeredAt))[0];

  let registrationId: string;
  // Which arm ran is what decides whether `evaluation.registered` exists at all: the db statement
  // gates that event on `inserted_reg`, so a reused registration emits none.
  let freshRegistration = false;
  if (activeReg) {
    activeReg.status = "completed";
    activeReg.completedAt = now;
    registrationId = activeReg.id;
  } else {
    freshRegistration = true;
    registrationId = generateId("eval_reg");
    evaluationRegistrations.set(registrationId, {
      id: registrationId,
      agentId,
      evaluationId: spec.evaluationId,
      registeredAt: now,
      status: "completed",
      completedAt: now,
      schoolId: "foundation",
      schoolScopeTrusted: true,
    });
  }

  const resultId = generateId("eval_res");
  evaluationResults.set(resultId, {
    id: resultId,
    registrationId,
    agentId,
    evaluationId: spec.evaluationId,
    passed: true,
    pointsEarned: spec.pointsEarned ?? undefined,
    resultData:
      spec.evaluationId === "poaw"
        ? { challenge_id: challengeId, completed_within_time_limit: true }
        : { identity_received: identityMd.length > 0 },
    completedAt: now,
    evaluationVersion: spec.evaluationVersion,
    schoolId: "foundation",
  });
  return { resultId, registrationId, freshRegistration };
}

/**
 * The half of the preflight that CAN run before the mutation, over every event the batch might
 * emit — kind and payload, exactly where the db store renders them, and over the whole set because
 * the db batch renders all of its statements before it sends any of them.
 *
 * **The other half, the idempotency check, cannot run up front here**: which arm each bootstrap
 * takes — and therefore which events exist at all — is only knowable after the writes. So this
 * batch may not carry an `idem_key`. With none, what runs here covers everything
 * `prepareEventBatch` can throw on, which makes the call below the mutations a pure construction. A
 * future kind that needs a key must move its substitution out of the synchronous section rather
 * than relax this.
 */
function preflightVettingEvents(
  specs: Array<{ evaluationId: string }>,
  events?: CompleteVettingEvents
): void {
  const candidates: readonly PreparedEvent[] = [
    ...(events?.vetted ?? []),
    ...specs.flatMap((spec) => {
      const specEvents = events?.bootstrap?.[spec.evaluationId];
      return [...(specEvents?.registered ?? []), ...(specEvents?.completed ?? [])];
    }),
  ];
  validatePreparedEvents(candidates);
  const keyed = candidates.find((event) => event.idemKey != null);
  if (keyed) {
    throw new Error(
      `[completeVetting] '${keyed.kind}' carries an idem_key; this batch substitutes ids after its ` +
        `writes and therefore cannot preflight uniqueness before them`
    );
  }
}

/**
 * The events ONE bootstrap evaluation's writes produced, with their store-assigned ids substituted.
 *
 * Positional, primary event only, mirroring `emitEventCtes`: the db statement applies
 * `overrides[0]` and leaves every later event alone. The registration arm is included only when the
 * write actually inserted one — the db side gates that event on `inserted_reg`, so a reused active
 * registration emits none.
 */
function bootstrapEventsFor(
  specEvents: { registered?: readonly PreparedEvent[]; completed?: readonly PreparedEvent[] } | undefined,
  written: { resultId: string; registrationId: string; freshRegistration: boolean }
): PreparedEvent[] {
  const emitted: PreparedEvent[] = [];
  if (written.freshRegistration) {
    for (const [index, event] of (specEvents?.registered ?? []).entries()) {
      emitted.push(index === 0 ? { ...event, subjectId: written.registrationId } : event);
    }
  }
  for (const [index, event] of (specEvents?.completed ?? []).entries()) {
    emitted.push(
      index === 0
        ? ({
            ...event,
            subjectId: written.registrationId,
            payload: { ...event.payload, result_id: written.resultId },
          } as PreparedEvent)
        : event
    );
  }
  return emitted;
}

/**
 * M11-1 C14, memory mode — the same preflight-then-mutate atomicity as the db batch.
 *
 * "Preserves today's behavior" was the wrong standard (Locked decision 4): the route used to
 * consume, then vet, then bootstrap across many awaits, so a crash between them burned the
 * challenge in memory mode too. Here every check and every decisive mutation happens in ONE
 * synchronous section — no `await` between them, so interleaved promises cannot observe a
 * half-completed vetting or double-consume a challenge. The points recompute and activity events
 * follow after, exactly where the memory `saveEvaluationResult` puts them.
 */
export async function completeVetting(
  agentId: string,
  challengeId: string,
  identityMd: string,
  events?: CompleteVettingEvents
): Promise<CompleteVettingOutcome> {
  // Throwing/derivation work first: the field computation reads the definition loader and may
  // throw; nothing below it may.
  const { computeEvaluationResultFields } = await import("../evaluations/result-fields");
  const specs = VETTING_BOOTSTRAP_EVALUATIONS.map((evaluationId) => {
    const { pointsEarned, evaluationVersion } = computeEvaluationResultFields({
      evaluationId,
      passed: true,
    });
    return { evaluationId, pointsEarned, evaluationVersion };
  });
  preflightVettingEvents(specs, events);

  // ---- One synchronous section: validate, then mutate. No `await` until it ends. ----
  const challenge = vettingChallenges.get(challengeId);
  const agent = agents.get(agentId);
  if (!agent) return { outcome: "unavailable", reason: "not_found" };
  // Same precedence as the db classifier: mismatch outranks the vetted fallback, and a vetted
  // agent's own dead-or-absent challenge is the idempotent already_vetted retry (C14).
  if (challenge && challenge.agentId !== agentId) return { outcome: "unavailable", reason: "mismatch" };
  if (!challenge) return { outcome: "unavailable", reason: agent.isVetted ? "already_vetted" : "not_found" };
  if (challenge.consumed) return { outcome: "unavailable", reason: agent.isVetted ? "already_vetted" : "consumed" };
  if (new Date(challenge.expiresAt).getTime() <= Date.now()) {
    return { outcome: "unavailable", reason: agent.isVetted ? "already_vetted" : "expired" };
  }
  const winningVetting = !agent.isVetted;
  if (winningVetting) agents.set(agentId, { ...agent, isVetted: true, identityMd });

  const now = new Date().toISOString();
  const created: Array<{ evaluationId: string; resultId: string }> = [];
  // Collected as they are written and appended at the end of the section, which is the memory twin
  // of "the batch commits or it does not": every event here is gated on a write that has just
  // happened, and a bootstrap evaluation that was skipped contributes none.
  const emitted: PreparedEvent[] = winningVetting ? [...(events?.vetted ?? [])] : [];
  for (const spec of specs) {
    const written = recordBootstrapPassSync(agentId, spec, now, challengeId, identityMd);
    if (!written) continue;
    created.push({ evaluationId: spec.evaluationId, resultId: written.resultId });
    emitted.push(...bootstrapEventsFor(events?.bootstrap?.[spec.evaluationId], written));
  }

  // Consume last, still inside the synchronous section — nothing above can have thrown without
  // the loader throw happening before any mutation.
  vettingChallenges.set(challengeId, { ...challenge, consumed: true });
  updateAgentPointsFromEvaluationsSync(agentId);
  const batch = prepareEventBatch(emitted);
  const { dispatched } = appendPreparedBatch(batch);
  // ---- End synchronous section. ----
  await dispatched;

  for (const c of created) {
    const spec = specs.find((s) => s.evaluationId === c.evaluationId)!;
    await recordEvaluationResultActivityEvent({
      resultId: c.resultId,
      agentId,
      evaluationId: c.evaluationId,
      completedAt: now,
      passed: true,
      pointsEarned: spec.pointsEarned ?? undefined,
      resultData:
        c.evaluationId === "poaw"
          ? { challenge_id: challengeId, completed_within_time_limit: true }
          : { identity_received: identityMd.length > 0 },
    });
  }

  return { outcome: "completed", bootstrap: created };
}

/**
 * M11-1 C17 (opt-in re-issue), memory mode: ownership is re-derived here and the row AND its
 * api-key index entry are replaced in one synchronous block — no `await` between the ownership
 * read and the three writes, so neither a revoked owner (review round 2, B2) nor a concurrent
 * authentication can observe an inconsistent state.
 */
export async function rotateAgentApiKey(agentId: string, humanUserId: string): Promise<string | null> {
  const agent = agents.get(agentId);
  if (!agent) return null;
  if (!ownsAgentSync(humanUserId, agentId)) return null;
  const newKey = generateAgentApiKey();
  apiKeyToAgentId.delete(agent.apiKey);
  agents.set(agentId, { ...agent, apiKey: newKey });
  apiKeyToAgentId.set(newKey, agentId);
  return newKey;
}

export async function setAgentVetted(agentId: string, identityMd: string) {
  const agent = agents.get(agentId);
  if (!agent) return false;
  agents.set(agentId, { ...agent, isVetted: true, identityMd });
  return true;
}

export async function setAgentIdentityMd(agentId: string, identityMd: string) {
  const agent = agents.get(agentId);
  if (!agent) return false;
  agents.set(agentId, { ...agent, identityMd });
  return true;
}

export async function setAgentAdmitted(agentId: string, admitted: boolean): Promise<void> {
  const agent = agents.get(agentId);
  if (!agent) return;
  agents.set(agentId, { ...agent, isAdmitted: admitted });
}

export async function getRecentlyActiveAgents(withinDays: number) {
  const cutoff = Date.now() - withinDays * 24 * 60 * 60 * 1000;
  return Array.from(agents.values())
    .filter(a =>
      a.isClaimed &&
      a.lastActiveAt &&
      new Date(a.lastActiveAt).getTime() >= cutoff
    )
    .sort((a, b) =>
      new Date(b.lastActiveAt!).getTime() - new Date(a.lastActiveAt!).getTime()
    );
}
