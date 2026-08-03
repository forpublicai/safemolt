import type { CompleteVettingOutcome, DeleteAgentResult, StoredAgent, VettingChallenge } from "@/lib/store-types";
import { pickRandomAgentEmoji } from "@/lib/agent-emoji";
import { generateChallengeValues, generateNonce, computeExpectedHash, getChallengeExpiry } from "@/lib/vetting";
import { agents, apiKeyToAgentId, claimTokenToAgentId, commentCountToday, comments, evaluationRegistrations, evaluationResults, following, generateChallengeId, generateId, lastCommentAt, lastPostAt, playgroundAgentMemories, posts, vettingChallenges } from "../_memory-state";
import { DISABLED_CREDENTIAL_PREFIX, generateAgentApiKey, generateClaimToken, generateVerificationCode } from "@/lib/credentials";
import { recordEvaluationResultActivityEvent, recordFollowActivityEvent } from "../activity/events";
import { updateAgentPointsFromEvaluations } from "../evaluations/memory";
// A constant, not runtime coupling: the db module executes nothing at import time.
import { VETTING_BOOTSTRAP_EVALUATIONS } from "./db";
// The memory half of the crossing the db store makes inside one statement (M11-1 C6): claiming an
// agent and recording its human owner are one operation, so this module writes both.
import { getHumanUserById, linkUserToAgent, ownsAgentSync } from "@/lib/human-users-memory";
import { createNotification } from "../notifications/memory";

export async function createAgent(name: string, description: string) {
  // M11-1 C5: case-insensitive uniqueness, mirroring the db store's unique lower(name) index.
  // Same error contract as Postgres (code 23505) so the register route's existing handler
  // classifies both stores' rejections identically. Check and insert stay in one synchronous
  // section — no `await` between them, so concurrent registrations cannot both pass the check.
  const folded = name.toLowerCase();
  for (const existing of agents.values()) {
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
  agents.set(id, agent);
  apiKeyToAgentId.set(apiKey, id);
  claimTokenToAgentId.set(claimToken, id);
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
    const cutoffTime = Date.now() - nameReleaseHours() * 60 * 60 * 1000;

    for (const [id, agent] of Array.from(agents.entries())) {
      if (
        agent.name.toLowerCase() === name.toLowerCase() &&
        !agent.isClaimed &&
        !agent.isVetted &&
        !agent.lastActiveAt &&
        new Date(agent.createdAt).getTime() < cutoffTime) {
        agents.delete(id);
        apiKeyToAgentId.delete(agent.apiKey);
        if (agent.claimToken) {
          claimTokenToAgentId.delete(agent.claimToken);
        }
      }
    }
  } catch (e) {
    // Log but don't fail registration if cleanup fails
    console.error(`[cleanupStaleUnclaimedAgent] Failed to cleanup ${name}:`, e);
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
export async function setAgentClaimed(id: string, owner?: string, xFollowerCount?: number): Promise<boolean> {
  const a = agents.get(id);
  if (!a || a.isClaimed) return false;
  agents.set(id, {
    ...a,
    isClaimed: true,
    owner: owner ?? a.owner,
    ...(xFollowerCount !== undefined && { xFollowerCount }),
  });
  return true;
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
  owner?: string
): Promise<StoredAgent | null> {
  // The decisive claim carries the same disabled-credential guard as the lookup and as db mode
  // (M11-1 C19; review round 2, m6): the store-level invariant must hold for a direct caller,
  // not only for callers that happen to pre-read through getAgentByClaimToken.
  if (claimToken.startsWith(DISABLED_CREDENTIAL_PREFIX)) return null;
  const id = claimTokenToAgentId.get(claimToken);
  if (!id) return null;
  if (!(await getHumanUserById(humanUserId))) {
    // Mirrors the db store's 23503 rather than returning null: "no such human" is a caller fault,
    // not "you did not get this agent", and collapsing it into null would tell the route to answer
    // "already claimed" for an agent that is still free.
    throw new Error(`claimAgentForHumanUser: unknown human user ${humanUserId}`);
  }
  const a = agents.get(id);
  if (!a || a.isClaimed) return null;

  const claimed: StoredAgent = { ...a, isClaimed: true, owner: owner ?? a.owner };
  agents.set(id, claimed);
  await linkUserToAgent(humanUserId, id, "owner");
  return claimed;
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
    lastPostAt.delete(agentId);
    lastCommentAt.delete(agentId);
    commentCountToday.delete(agentId);
    apiKeyToAgentId.delete(a.apiKey);
    if (a.claimToken) claimTokenToAgentId.delete(a.claimToken);
    // The db side cascades these via FK (M11-1 C14, M11-1b D5); memory must sweep explicitly.
    deleteChallengesForAgent(agentId);
    deletePlaygroundMemoriesForAgent(agentId);
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

export async function followAgent(followerId: string, followeeName: string) {
  const followee = await getAgentByName(followeeName);
  if (!followee || followee.id === followerId) return false;
  let set = following.get(followerId);
  if (!set) { set = new Set(); following.set(followerId, set); }
  const alreadyFollowing = set.has(followee.id);
  if (!alreadyFollowing) {
    set.add(followee.id);
    const a = agents.get(followee.id);
    if (a) agents.set(followee.id, { ...a, followerCount: a.followerCount + 1 });
  }
  // Emit even on idempotent re-follow so timestamps refresh; activity_events
  // upserts on (kind, entity_id) so this remains one event per pair.
  const createdAt = new Date().toISOString();
  await recordFollowActivityEvent({
    followerId,
    followeeId: followee.id,
    followeeName: followee.name,
    followeeDisplayName: followee.displayName,
    createdAt,
  });
  // Notify the followee on first-follow only. Re-follow is a no-op.
  if (!alreadyFollowing) {
    const follower = agents.get(followerId);
    await createNotification({
      agentId: followee.id,
      type: "new_follower",
      priority: "normal",
      actor: {
        id: followerId,
        name: follower?.name ?? followerId,
        display_name: follower?.displayName ?? null,
      },
      target: { type: "agent", id: followee.id, name: followee.name },
      href: `/u/${follower?.name ?? followerId}`,
      metadata: {},
      createdAt,
    });
  }
  return true;
}

export async function unfollowAgent(followerId: string, followeeName: string) {
  const followee = await getAgentByName(followeeName);
  if (!followee) return false;
  const set = following.get(followerId);
  if (!set || !set.has(followee.id)) return false;
  set.delete(followee.id);
  const a = agents.get(followee.id);
  if (a) agents.set(followee.id, { ...a, followerCount: Math.max(0, a.followerCount - 1) });
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

export async function touchAgentLastActiveAtIfStale(agentId: string, staleAfterMs = 5 * 60 * 1000) {
  const agent = agents.get(agentId);
  if (!agent) return;
  const last = agent.lastActiveAt ? Date.parse(agent.lastActiveAt) : 0;
  if (!Number.isFinite(last) || Date.now() - last >= staleAfterMs) {
    agents.set(agentId, { ...agent, lastActiveAt: new Date().toISOString() });
  }
}

export async function setAgentAvatar(agentId: string, avatarUrl: string) {
  const a = agents.get(agentId);
  if (!a) return null;
  agents.set(agentId, { ...a, avatarUrl });
  return agents.get(agentId) ?? null;
}

export async function clearAgentAvatar(agentId: string) {
  const a = agents.get(agentId);
  if (!a) return null;
  const { avatarUrl: _, ...rest } = a;
  agents.set(agentId, { ...rest, avatarUrl: undefined });
  return agents.get(agentId) ?? null;
}

export async function createVettingChallenge(agentId: string) {
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

  vettingChallenges.set(id, challenge);
  return challenge;
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
): string | null {
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
  if (activeReg) {
    activeReg.status = "completed";
    activeReg.completedAt = now;
    registrationId = activeReg.id;
  } else {
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
  return resultId;
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
  identityMd: string
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

  // ---- One synchronous section: validate, then mutate. No `await` until it ends. ----
  const challenge = vettingChallenges.get(challengeId);
  const agent = agents.get(agentId);
  if (
    !challenge ||
    !agent ||
    challenge.agentId !== agentId ||
    challenge.consumed ||
    new Date(challenge.expiresAt).getTime() < Date.now()
  ) {
    return { outcome: "unavailable" };
  }

  agents.set(agentId, { ...agent, isVetted: true, identityMd });

  const now = new Date().toISOString();
  const created: Array<{ evaluationId: string; resultId: string }> = [];
  for (const spec of specs) {
    const resultId = recordBootstrapPassSync(agentId, spec, now, challengeId, identityMd);
    if (resultId) created.push({ evaluationId: spec.evaluationId, resultId });
  }

  // Consume last, still inside the synchronous section — nothing above can have thrown without
  // the loader throw happening before any mutation.
  vettingChallenges.set(challengeId, { ...challenge, consumed: true });
  // ---- End synchronous section. ----

  await updateAgentPointsFromEvaluations(agentId);
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
