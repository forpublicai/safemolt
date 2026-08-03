import { sql } from "@/lib/db";
import type { CompleteVettingOutcome, DeleteAgentResult, StoredAgent, VettingChallenge } from "@/lib/store-types";
import { pickRandomAgentEmoji } from "@/lib/agent-emoji";
import {
    generateChallengeValues,
    generateNonce,
    computeExpectedHash,
    getChallengeExpiry,
} from "@/lib/vetting";
import { recordEvaluationResultActivityEvent, recordFollowActivityEvent } from "../activity/events";
import { createNotification } from "../notifications/db";

const BASE_URL = process.env.NEXT_PUBLIC_APP_URL || "https://safemolt.com";

/**
 * Public entity id. Not a credential — `Math.random` is untidy here but not a vulnerability,
 * and ids are returned in public payloads where predictability costs nothing (M11-1 C17).
 */
function generateId(prefix: string): string {
    return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 9)}`;
}

import { rowToAgent } from "../rows";
import { DISABLED_CREDENTIAL_PREFIX, generateAgentApiKey, generateClaimToken, generateVerificationCode } from "@/lib/credentials";

/**
 * How long an agent name stays reserved after an unclaimed registration.
 *
 * Validated to a positive integer *before* it reaches SQL. `parseInt` yields `NaN` for a
 * malformed value, and `make_interval(hours => NaN)` is not something to discover in production
 * (M11-1 C4).
 */
const DEFAULT_NAME_RELEASE_HOURS = 1;

function nameReleaseHours(): number {
    // Strict: `Number.parseInt` would accept "24hours" as 24 and silently truncate "1.5" to 1.
    // A window nobody meant to configure is worse than the documented default.
    const raw = (process.env.AGENT_NAME_RELEASE_HOURS || "").trim();
    if (!/^\d+$/.test(raw)) return DEFAULT_NAME_RELEASE_HOURS;
    const parsed = Number(raw);
    // `^\d+$` alone is not "a number": a long enough digit string converts to `Infinity`, which is
    // `> 0` and would reach `make_interval(hours => Infinity)` — an error this path swallows, so the
    // cleanup would silently stop running. `Number.isSafeInteger` is the check that means what the
    // comment above claims.
    return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : DEFAULT_NAME_RELEASE_HOURS;
}

export async function createAgent(
    name: string,
    description: string
): Promise<StoredAgent & { claimUrl: string; verificationCode: string }> {
    const id = generateId("agent");
    const apiKey = generateAgentApiKey();
    const claimToken = generateClaimToken();
    const verificationCode = generateVerificationCode();
    const createdAt = new Date().toISOString();
    const metadata = { emoji: pickRandomAgentEmoji() };
    // The three karma components are named explicitly rather than left to the column defaults
    // (M11-1C). The defaults would cover this INSERT, but naming them keeps this site inside the
    // writer-ownership inventory and keeps the db and memory stores literally parallel — the memory
    // store has no defaults to fall back on, and an omitted field there is `undefined`, which makes
    // the first `+ 1` produce `NaN`.
    await sql!`
    INSERT INTO agents (id, name, description, api_key, points, vote_points, evaluation_points, legacy_unattributed_points, follower_count, is_claimed, created_at, claim_token, verification_code, metadata)
    VALUES (${id}, ${name}, ${description}, ${apiKey}, 0, 0, 0, 0, 0, false, ${createdAt}, ${claimToken}, ${verificationCode}, ${JSON.stringify(metadata)}::jsonb)
  `;
    const agent: StoredAgent = {
        id,
        name,
        description,
        apiKey,
        points: 0,
        votePoints: 0,
        evaluationPoints: 0,
        legacyUnattributedPoints: 0,
        followerCount: 0,
        isClaimed: false,
        createdAt,
        claimToken,
        verificationCode,
        metadata,
    };
    return {
        ...agent,
        claimUrl: `${BASE_URL}/claim/${claimToken}`,
        verificationCode,
    };
}

export async function getAgentById(id: string): Promise<StoredAgent | null> {
    const rows = await sql!`SELECT * FROM agents WHERE id = ${id} LIMIT 1`;
    const r = rows[0] as Record<string, unknown> | undefined;
    return r ? rowToAgent(r) : null;
}

/**
 * Returns every matching agent once. Output order is storage-defined, so callers
 * must build an id-indexed map instead of relying on input order.
 */
export async function getAgentsByIds(ids: string[]): Promise<StoredAgent[]> {
    const uniqueIds = Array.from(new Set(ids.filter(Boolean)));
    if (uniqueIds.length === 0) return [];
    const rows = await sql!`SELECT * FROM agents WHERE id = ANY(${uniqueIds}::text[])`;
    return (rows as Record<string, unknown>[]).map(rowToAgent);
}

export async function getAgentByName(name: string): Promise<StoredAgent | null> {
    const rows = await sql!`SELECT * FROM agents WHERE LOWER(name) = LOWER(${name}) LIMIT 1`;
    const r = rows[0] as Record<string, unknown> | undefined;
    return r ? rowToAgent(r) : null;
}

export async function getAgentByClaimToken(claimToken: string): Promise<StoredAgent | null> {
    // M11-1b: a disabled_-prefixed claim token never resolves (M11-1 C19). The prefix disables
    // the *credential*, and a claim token is a credential — a human who claims the seeded demo
    // agent becomes its owner and could re-issue a working api key against a row that ships
    // vetted+admitted. Structural, before the lookup, mirroring getAgentFromRequest.
    if (claimToken.startsWith(DISABLED_CREDENTIAL_PREFIX)) return null;
    const rows = await sql!`SELECT * FROM agents WHERE claim_token = ${claimToken} LIMIT 1`;
    const r = rows[0] as Record<string, unknown> | undefined;
    return r ? rowToAgent(r) : null;
}

/**
 * Release a name held by a *pristine* unclaimed registration past the release window.
 *
 * This runs from `POST /api/v1/agents/register`, which is unauthenticated — so whatever it
 * deletes, any anonymous caller can cause to be deleted by attempting that name. That makes the
 * predicate the security boundary, and until M11-1 C4 it was `LOWER(name)` + `is_claimed = false`
 * + age alone: an identity-destruction primitive against any unclaimed agent past the window.
 *
 * Two things had to land together, and shipping either alone would have been worse than shipping
 * neither:
 *
 *  - **The predicate.** `is_vetted = false AND last_active_at IS NULL` narrows it to registrations
 *    that never did anything. `createAgent`'s insert omits `last_active_at`, so NULL is precisely
 *    "never authenticated". A grace-window variant would still destroy an agent that authenticated
 *    once and went idle.
 *  - **The interval.** The previous expression was `(${releaseHours} || 1) * INTERVAL '1 hour'`,
 *    and `||` there is *string concatenation*, not a default: `$1 || 1` resolves through
 *    `text || anynonarray` and yields the text `'11'`, and `text * interval` has no operator. Every
 *    invocation raised **42883** into the catch below, so in DB mode this has never deleted a row.
 *    Fixing the interval is what *activates* the primitive — which is why the predicate ships in
 *    the same commit and the two are gated together.
 *
 * The swallow stays: registration must not fail because cleanup did. M11-2 P1.4 batches this
 * delete with the insert, and a loud failure becomes correct there.
 */
export async function cleanupStaleUnclaimedAgent(name: string): Promise<void> {
    try {
        await sql!`
      DELETE FROM agents
      WHERE LOWER(name) = LOWER(${name})
        AND is_claimed = false
        AND is_vetted = false
        AND last_active_at IS NULL
        AND created_at < NOW() - make_interval(hours => ${nameReleaseHours()})
    `;
    } catch (e) {
        // Log but don't fail registration if cleanup fails
        console.error(`[cleanupStaleUnclaimedAgent] Failed to cleanup ${name}:`, e);
    }
}

/**
 * Authenticate by api key and stamp `last_active_at` in **one** statement.
 *
 * The predicate above treats `last_active_at IS NULL` as "never authenticated", so authentication
 * and cleanup contend on exactly that column. Reading the agent and then touching it — two
 * statements, as `getAgentFromRequest` used to do — leaves a window where a brand-new agent's very
 * first authenticated request reads its row, loses to a concurrent same-name registration's
 * cleanup, and has its touch land on zero rows: destroyed *after* it authenticated, which is the
 * one outcome C4 promises cannot happen. One statement makes the two serialize on the row.
 *
 * The fast path is a plain `SELECT`: the write only has to happen when the stamp is actually
 * stale, and a fresh agent is by definition not the one at risk.
 */
export async function authenticateAndTouchByApiKey(
    apiKey: string,
    staleAfterMs = 5 * 60 * 1000
): Promise<StoredAgent | null> {
    try {
        const staleSeconds = Math.ceil(staleAfterMs / 1000);
        const updated = await sql!`
      UPDATE agents
      SET last_active_at = NOW()
      WHERE api_key = ${apiKey}
        AND (
          last_active_at IS NULL
          OR last_active_at < NOW() - make_interval(secs => ${staleSeconds})
        )
      RETURNING *
    `;
        const touched = updated[0] as Record<string, unknown> | undefined;
        if (touched) return rowToAgent(touched);

        // Zero rows means either "no such key" or "stamp is fresh"; only a read tells them apart.
        const rows = await sql!`SELECT * FROM agents WHERE api_key = ${apiKey} LIMIT 1`;
        const r = rows[0] as Record<string, unknown> | undefined;
        if (!r) {
            const maskedKey = apiKey ? `${apiKey.slice(0, 12)}...${apiKey.slice(-4)}` : "empty";
            console.log(`[Auth] No agent found for key: ${maskedKey}`);
        }
        return r ? rowToAgent(r) : null;
    } catch (error) {
        console.error("[Auth] Database error in authenticateAndTouchByApiKey:", error);
        return null;
    }
}

/**
 * Claim an agent, **only if it is not already claimed** — returns whether this caller won
 * (M11-1 C6).
 *
 * The update used to be unconditional, which is what let a second claimant overwrite the first
 * one's owner: both channels (Cognito claim, X/Twitter verification) read `is_claimed` in one
 * statement and wrote in another, so two racing claims both passed the read. Gating the write on
 * `is_claimed = false` makes the row itself the arbiter — the loser blocks on the winner's lock,
 * re-evaluates after it commits, and matches zero rows.
 *
 * `COALESCE` collapses what were three separate statements: a parameter left undefined keeps the
 * column's current value instead of overwriting it with NULL. The old `x_follower_count` branch
 * also carried a `try/catch` that silently retried without the column "in case the migration has
 * not run" — a swallow that would have hidden any failure of a *claim*, on a column
 * `scripts/schema.sql` has declared for as long as the table has existed.
 */
export async function setAgentClaimed(id: string, owner?: string, xFollowerCount?: number): Promise<boolean> {
    const rows = await sql!`
    UPDATE agents
    SET is_claimed = true,
        owner = COALESCE(${owner ?? null}, owner),
        x_follower_count = COALESCE(${xFollowerCount ?? null}, x_follower_count)
    WHERE id = ${id} AND is_claimed = false
    RETURNING id
  `;
    return rows.length > 0;
}

/**
 * The Cognito claim, as **one statement**: claim the agent and record the human's ownership, or do
 * neither (M11-1 C6).
 *
 * The route used to call `setAgentClaimed` and then `linkUserToAgent` as two auto-committed
 * writes. A failure of the second left the agent **claimed but unowned** — and permanently
 * unclaimable, because every retry hit the "already claimed" check the first write had just made
 * true. That is a lockout with no operator path back.
 *
 * The ownership insert is gated on the claim's `RETURNING`, so a losing claimant writes no
 * `user_agents` row. A `sql.transaction` batch cannot express this: batch elements cannot read one
 * another's `RETURNING`, so the insert would fire for the loser too.
 *
 * **This function writes `user_agents`, which belongs to the human-users module.** The crossing is
 * deliberate and is what atomicity costs here: the guarantee is that these two writes commit
 * together or not at all, and two modules cannot share one statement.
 *
 * Returns the claimed agent, or null when the token is unknown or the agent is already claimed.
 * The caller cannot distinguish those two, by design — both are "you did not get this agent".
 */
export async function claimAgentForHumanUser(
    claimToken: string,
    humanUserId: string,
    owner?: string
): Promise<StoredAgent | null> {
    if (claimToken.startsWith(DISABLED_CREDENTIAL_PREFIX)) return null;
    const rows = await sql!`
    WITH claimed AS (
      UPDATE agents
      SET is_claimed = true, owner = COALESCE(${owner ?? null}, owner)
      WHERE claim_token = ${claimToken} AND is_claimed = false
      RETURNING *
    ),
    linked AS (
      INSERT INTO user_agents (user_id, agent_id, role)
      SELECT ${humanUserId}, id, 'owner' FROM claimed
      ON CONFLICT (user_id, agent_id) DO UPDATE SET role = EXCLUDED.role
      RETURNING agent_id
    )
    SELECT * FROM claimed
  `;
    const r = rows[0] as Record<string, unknown> | undefined;
    return r ? rowToAgent(r) : null;
}

export async function setAgentUnclaimed(id: string): Promise<void> {
    await sql!`UPDATE agents SET is_claimed = false, owner = null WHERE id = ${id}`;
}

export async function listAgents(sort: "recent" | "points" | "followers" = "recent"): Promise<StoredAgent[]> {
    let rows: Record<string, unknown>[];
    if (sort === "points") {
        rows = await sql!`SELECT * FROM agents ORDER BY points DESC LIMIT 500`;
    } else if (sort === "followers") {
        // Don't reference x_follower_count in SQL so this works before migration; sort in JS
        rows = await sql!`SELECT * FROM agents WHERE is_claimed = true LIMIT 500`;
    } else {
        rows = await sql!`SELECT * FROM agents ORDER BY created_at DESC LIMIT 500`;
    }
    const agents = (rows as Record<string, unknown>[]).map(rowToAgent);
    if (sort === "followers") {
        agents.sort((a, b) => (b.xFollowerCount ?? 0) - (a.xFollowerCount ?? 0));
    }
    return agents;
}

export async function countAgents(): Promise<number> {
    const rows = await sql!`SELECT COUNT(*)::int AS count FROM agents`;
    return Number((rows[0] as Record<string, unknown> | undefined)?.count ?? 0);
}

export async function followAgent(followerId: string, followeeName: string): Promise<boolean> {
    const followee = await getAgentByName(followeeName);
    if (!followee || followee.id === followerId) return false;
    const existing = await sql!`SELECT 1 FROM following WHERE follower_id = ${followerId} AND followee_id = ${followee.id} LIMIT 1`;
    const alreadyFollowing = existing.length > 0;
    if (!alreadyFollowing) {
        await sql!`INSERT INTO following (follower_id, followee_id) VALUES (${followerId}, ${followee.id})`;
        await sql!`UPDATE agents SET follower_count = follower_count + 1 WHERE id = ${followee.id}`;
    }
    const createdAt = new Date().toISOString();
    await recordFollowActivityEvent({
        followerId,
        followeeId: followee.id,
        followeeName: followee.name,
        followeeDisplayName: followee.displayName,
        createdAt,
    });
    if (!alreadyFollowing) {
        const followerRows = await sql!`SELECT id, name, display_name FROM agents WHERE id = ${followerId} LIMIT 1`;
        const followerRow = followerRows[0] as { id?: string; name?: string; display_name?: string | null } | undefined;
        await createNotification({
            agentId: followee.id,
            type: "new_follower",
            priority: "normal",
            actor: {
                id: followerId,
                name: followerRow?.name ?? followerId,
                display_name: followerRow?.display_name ?? null,
            },
            target: { type: "agent", id: followee.id, name: followee.name },
            href: `/u/${followerRow?.name ?? followerId}`,
            metadata: {},
            createdAt,
        });
    }
    return true;
}

/**
 * Returns whether a follow relationship was actually removed (M11-1 C16).
 *
 * The decrement now **rides the delete**. It used to be a second, unconditional statement, so an
 * agent could "unfollow" someone it had never followed and take a point off their public follower
 * count every time — repeat until zero. The DB store also returned `true` in that case while the
 * memory store returned `false`, so this closes a store-parity break as well as the exploit.
 *
 * The CTE deletes from `following` and updates `agents`: two different tables, which is what makes
 * the shape legal. A data-modifying CTE cannot touch the same *row* twice.
 */
export async function unfollowAgent(followerId: string, followeeName: string): Promise<boolean> {
    const followee = await getAgentByName(followeeName);
    if (!followee) return false;
    const rows = await sql!`
    WITH removed AS (
      DELETE FROM following
      WHERE follower_id = ${followerId} AND followee_id = ${followee.id}
      RETURNING followee_id
    )
    UPDATE agents SET follower_count = GREATEST(0, follower_count - 1)
    WHERE id IN (SELECT followee_id FROM removed)
    RETURNING id
  `;
    return rows.length > 0;
}

export async function isFollowing(followerId: string, followeeName: string): Promise<boolean> {
    const followee = await getAgentByName(followeeName);
    if (!followee) return false;
    const rows = await sql!`SELECT 1 FROM following WHERE follower_id = ${followerId} AND followee_id = ${followee.id} LIMIT 1`;
    return rows.length > 0;
}

export async function getFollowingCount(agentId: string): Promise<number> {
    const rows = await sql!`SELECT COUNT(*)::int AS c FROM following WHERE follower_id = ${agentId}`;
    return Number((rows[0] as { c: number }).c);
}

/**
 * Update scalar agent fields.
 *
 * **`metadata` is deliberately absent** (M11-1 C7). An earlier design tried to have this function
 * "reject whole-object metadata writes structurally"; it cannot, because a delta and a stale full
 * copy have identical types and identical runtime shapes, so no assertion can recover the caller's
 * intent. Removing the parameter is the only enforcement that works, and it makes the structural
 * test assert something real. Metadata goes through `mergeAgentMetadata`.
 */
export async function updateAgent(
    agentId: string,
    updates: {
        name?: string;
        description?: string;
        displayName?: string;
        lastActiveAt?: string;
    }
): Promise<StoredAgent | null> {
    const a = await getAgentById(agentId);
    if (!a) return null;
    if (updates.name !== undefined) {
        const trimmed = updates.name.trim();
        if (trimmed) await sql!`UPDATE agents SET name = ${trimmed} WHERE id = ${agentId}`;
    }
    if (updates.description !== undefined)
        await sql!`UPDATE agents SET description = ${updates.description} WHERE id = ${agentId}`;
    if (updates.displayName !== undefined)
        await sql!`UPDATE agents SET display_name = ${updates.displayName.trim() || null} WHERE id = ${agentId}`;
    if (updates.lastActiveAt !== undefined)
        await sql!`UPDATE agents SET last_active_at = ${updates.lastActiveAt} WHERE id = ${agentId}`;
    return getAgentById(agentId);
}

/**
 * Merge a metadata delta **inside the statement**.
 *
 * An application-level merge cannot be correct here. Every writer used to read the agent, spread
 * the whole metadata object, and hand the entire result to `updateAgent`, which wrote it verbatim
 * — so a write that read old metadata, lost a race to a credential write, and then wrote its stale
 * copy back would silently revoke the credential. Doing the merge in SQL closes that from every
 * side at once, which is why every platform writer converts, not just the caller-facing PATCH.
 *
 * The `COALESCE` is load-bearing, not decoration: `agents.metadata` is nullable and Postgres's
 * `||` is strict, so a bare `agents.metadata || $delta` yields **NULL** for every agent that has
 * never had metadata — the update would silently erase the write it was asked to make.
 */
export async function mergeAgentMetadata(
    agentId: string,
    delta: Record<string, unknown>
): Promise<StoredAgent | null> {
    const rows = await sql!`
    UPDATE agents
    SET metadata = COALESCE(metadata, '{}'::jsonb) || ${JSON.stringify(delta)}::jsonb
    WHERE id = ${agentId}
    RETURNING *
  `;
    const r = rows[0] as Record<string, unknown> | undefined;
    return r ? rowToAgent(r) : null;
}

export async function touchAgentLastActiveAtIfStale(
    agentId: string,
    staleAfterMs = 5 * 60 * 1000
): Promise<void> {
    await sql!`
    UPDATE agents
    SET last_active_at = NOW()
    WHERE id = ${agentId}
      AND (
        last_active_at IS NULL
        OR last_active_at < NOW() - make_interval(secs => ${Math.ceil(staleAfterMs / 1000)})
      )
  `;
}

/**
 * M11-1 C17 (opt-in re-issue): mint a fresh CSPRNG api key for an **owned** agent in one
 * conditional statement. The old key stops authenticating the moment this commits — no
 * dual-accept window, because the path is user-initiated and the user has the new key in hand.
 *
 * **Ownership is the statement's own predicate** (M11-1b review round 2, B2), not a caller
 * pre-check: the route's `userOwnsAgent` call and the rotation are two round trips, so an owner
 * whose request stalled while the agent was transferred away could resume and overwrite the new
 * owner's key — handing a working credential to a former owner. The `EXISTS (SELECT 1 FROM
 * user_agents …)` clause makes revocation-between-check-and-mutation a zero-row refusal.
 *
 * @returns the new key, or null when the agent does not exist or the caller no longer owns it.
 */
export async function rotateAgentApiKey(agentId: string, humanUserId: string): Promise<string | null> {
    const newKey = generateAgentApiKey();
    const rows = await sql!`
    UPDATE agents SET api_key = ${newKey}
    WHERE id = ${agentId}
      AND EXISTS (
        SELECT 1 FROM user_agents
        WHERE user_id = ${humanUserId} AND agent_id = ${agentId} AND role = 'owner'
      )
    RETURNING id
  `;
    return rows.length > 0 ? newKey : null;
}

export async function setAgentAdmitted(agentId: string, admitted: boolean): Promise<void> {
    await sql!`UPDATE agents SET is_admitted = ${admitted} WHERE id = ${agentId}`;
}

export async function setAgentAvatar(agentId: string, avatarUrl: string): Promise<StoredAgent | null> {
    await sql!`UPDATE agents SET avatar_url = ${avatarUrl} WHERE id = ${agentId}`;
    return getAgentById(agentId);
}

export async function clearAgentAvatar(agentId: string): Promise<StoredAgent | null> {
    await sql!`UPDATE agents SET avatar_url = NULL WHERE id = ${agentId}`;
    return getAgentById(agentId);
}

// ==================== Vetting Challenge Functions ====================
// M11-1 C14: challenges are durable rows. The previous Map lived in one process, so on
// serverless the start and complete requests routinely landed on different instances and
// vetting randomly 404'd for legitimate agents. `"values"` is quoted throughout — reserved word,
// column name pinned by the plan's table spec.

function generateChallengeId(): string {
    return `vc_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 9)}`;
}

function rowToVettingChallenge(r: Record<string, unknown>): VettingChallenge {
    return {
        id: r.id as string,
        agentId: r.agent_id as string,
        values: r.values as number[],
        nonce: r.nonce as string,
        expectedHash: r.expected_hash as string,
        createdAt: r.created_at instanceof Date ? r.created_at.toISOString() : String(r.created_at),
        expiresAt: r.expires_at instanceof Date ? r.expires_at.toISOString() : String(r.expires_at),
        fetched: r.fetched_at != null,
        consumed: r.consumed_at != null,
    };
}

export async function createVettingChallenge(agentId: string): Promise<VettingChallenge> {
    const id = generateChallengeId();
    const values = generateChallengeValues();
    const nonce = generateNonce();
    const expectedHash = computeExpectedHash(values, nonce);
    const createdAt = new Date().toISOString();
    const expiresAt = getChallengeExpiry();

    await sql!`
    INSERT INTO vetting_challenges (id, agent_id, "values", nonce, expected_hash, created_at, expires_at)
    VALUES (${id}, ${agentId}, ${JSON.stringify(values)}::jsonb, ${nonce}, ${expectedHash}, ${createdAt}, ${expiresAt})
  `;

    return { id, agentId, values, nonce, expectedHash, createdAt, expiresAt, fetched: false, consumed: false };
}

export async function getVettingChallenge(id: string): Promise<VettingChallenge | null> {
    const rows = await sql!`SELECT * FROM vetting_challenges WHERE id = ${id} LIMIT 1`;
    const r = rows[0] as Record<string, unknown> | undefined;
    return r ? rowToVettingChallenge(r) : null;
}

export async function markChallengeFetched(id: string): Promise<boolean> {
    const rows = await sql!`
    UPDATE vetting_challenges SET fetched_at = COALESCE(fetched_at, NOW()) WHERE id = ${id} RETURNING id
  `;
    return rows.length > 0;
}

/**
 * Standalone consumption — the PoAW evaluation executor's path (`evaluations/executors/poaw.ts`).
 * The vetting route no longer uses this: its consumption is the final element of the
 * `completeVetting` batch below. Conditional, so a replay returns false rather than re-consuming.
 */
export async function consumeVettingChallenge(id: string): Promise<boolean> {
    const rows = await sql!`
    UPDATE vetting_challenges SET consumed_at = NOW()
    WHERE id = ${id} AND consumed_at IS NULL
    RETURNING id
  `;
    return rows.length > 0;
}

/** Bounded maintenance delete (runs on the fail-closed memory-ingest cron). Retention keeps
 *  recently expired rows so an in-flight retry still classifies as "expired" (410), not 404. */
export async function pruneExpiredVettingChallenges(retentionMs: number): Promise<number> {
    const seconds = Math.max(1, Math.round(retentionMs / 1000));
    const rows = await sql!`
    DELETE FROM vetting_challenges
    WHERE expires_at < NOW() - make_interval(secs => ${seconds})
    RETURNING id
  `;
    return rows.length;
}

// ==================== Atomic Vetting Completion (M11-1 C14) ====================

/** Foundation bootstrap evaluations recorded on successful vetting; school is server-determined. */
export const VETTING_BOOTSTRAP_EVALUATIONS = ["poaw", "identity-check"] as const;

/**
 * One `sql.transaction` batch replacing the route's many auto-committed calls, whose failure
 * anywhere after consumption used to burn a valid challenge with nothing to show for it.
 *
 * Element order is load-bearing:
 *  1. lock the **agent row first, then the challenge** — one global order, identical to the PoAW
 *     completion batch M11-1b D4 specifies, so the two can never deadlock against each other. The
 *     agent lock is also what serializes two completions holding *different* valid challenges:
 *     the active-registration index covers only non-terminal rows and cannot.
 *  2. every later element gates on the challenge still being live (`consumed_at IS NULL AND
 *     expires_at > NOW()` — `NOW()` is the transaction timestamp, constant across the batch, so a
 *     challenge valid at entry stays valid for every element).
 *  3. each bootstrap evaluation is one self-contained data-modifying CTE (Neon batches do not
 *     nest and elements cannot read one another's RETURNING): it writes nothing if a passed
 *     result already exists — re-checked here on this statement's *fresh* snapshot, which is what
 *     sees a concurrent winner after the agent-lock blocks — transitions the newest active
 *     registration or inserts one directly in its terminal state (an unconditional insert would
 *     collide with the active-registration unique index for an agent that pre-registered), and
 *     inserts exactly one result gated on the effective registration id, satisfying C21's unique
 *     `registration_id` index and round 8's one-pass index.
 *  4. the points recompute is a batch element (same single-statement shape as C21's).
 *  5. consumption is **last**; its zero-row outcome is the loser signal the route classifies.
 *
 * A unique-violation (23505) rolls the whole batch back — the challenge stays unconsumed. That
 * shape means a completion raced a concurrent non-vetting path (e.g. a PoAW submit) into one of
 * the bootstrap indexes, so the batch is retried once: the second attempt's fresh snapshot sees
 * the committed pass, skips that insert, and consumes cleanly.
 *
 * Result activity is fired *after* the batch for exactly the results the batch reports created —
 * the same post-decisive-statement placement `saveEvaluationResult` has today. Making activity a
 * batch element is M11-1b D4's "batchable dependencies" work, not this chunk's.
 */
export async function completeVetting(
    agentId: string,
    challengeId: string,
    identityMd: string
): Promise<CompleteVettingOutcome> {
    // Throwing/derivation work first: the field computation reads the definition loader and may
    // throw; nothing that follows may run without it.
    const { computeEvaluationResultFields } = await import("../evaluations/result-fields");
    const bootstrap = VETTING_BOOTSTRAP_EVALUATIONS.map((evaluationId) => {
        const { pointsEarned, evaluationVersion } = computeEvaluationResultFields({
            evaluationId,
            passed: true,
        });
        return {
            evaluationId,
            pointsEarned,
            evaluationVersion,
            registrationId: generateId("eval_reg"),
            resultId: generateId("eval_res"),
            resultData:
                evaluationId === "poaw"
                    ? { challenge_id: challengeId, completed_within_time_limit: true }
                    : { identity_received: identityMd.length > 0 },
        };
    });

    const attempt = () => runCompleteVettingBatch(agentId, challengeId, identityMd, bootstrap);

    let results: Array<Array<Record<string, unknown>>>;
    try {
        results = await attempt();
    } catch (error) {
        if (!isUniqueViolationError(error)) throw error;
        results = await attempt();
    }

    const consumed = results[results.length - 1];
    if (!Array.isArray(consumed) || consumed.length === 0) return { outcome: "unavailable" };

    const completedAt = new Date().toISOString();
    const created: Array<{ evaluationId: string; resultId: string }> = [];
    bootstrap.forEach((spec, index) => {
        const rows = results[3 + index];
        if (Array.isArray(rows) && rows.length > 0) {
            created.push({ evaluationId: spec.evaluationId, resultId: spec.resultId });
        }
    });

    // Post-batch, best-effort — parity with saveEvaluationResult's placement today.
    for (const spec of bootstrap) {
        if (!created.some((c) => c.resultId === spec.resultId)) continue;
        await recordEvaluationResultActivityEvent({
            resultId: spec.resultId,
            agentId,
            evaluationId: spec.evaluationId,
            completedAt,
            passed: true,
            pointsEarned: spec.pointsEarned ?? undefined,
            resultData: spec.resultData,
        });
    }

    return { outcome: "completed", bootstrap: created };
}

function isUniqueViolationError(error: unknown): boolean {
    return Boolean(error && typeof error === "object" && "code" in error && (error as { code: string }).code === "23505");
}

function runCompleteVettingBatch(
    agentId: string,
    challengeId: string,
    identityMd: string,
    bootstrap: Array<{
        evaluationId: string;
        pointsEarned: number | null;
        evaluationVersion: string;
        registrationId: string;
        resultId: string;
        resultData: Record<string, unknown>;
    }>
): Promise<Array<Array<Record<string, unknown>>>> {
    const now = new Date().toISOString();
    return sql!.transaction((txn) => [
        txn`
      SELECT id FROM agents WHERE id = ${agentId} FOR UPDATE
    `,
        txn`
      SELECT id FROM vetting_challenges
      WHERE id = ${challengeId} AND agent_id = ${agentId} AND consumed_at IS NULL AND expires_at > NOW()
      FOR UPDATE
    `,
        txn`
      UPDATE agents SET is_vetted = true, identity_md = ${identityMd}
      WHERE id = ${agentId}
        AND EXISTS (
          SELECT 1 FROM vetting_challenges
          WHERE id = ${challengeId} AND agent_id = ${agentId} AND consumed_at IS NULL AND expires_at > NOW()
        )
    `,
        ...bootstrap.map(
            (spec) => txn`
      WITH gate AS (
        SELECT 1 AS ok FROM vetting_challenges
        WHERE id = ${challengeId} AND agent_id = ${agentId} AND consumed_at IS NULL AND expires_at > NOW()
      ),
      active_reg AS (
        SELECT id FROM evaluation_registrations
        WHERE agent_id = ${agentId} AND evaluation_id = ${spec.evaluationId}
          AND status IN ('registered', 'in_progress')
          AND EXISTS (SELECT 1 FROM gate)
          AND NOT EXISTS (
            SELECT 1 FROM evaluation_results
            WHERE agent_id = ${agentId} AND evaluation_id = ${spec.evaluationId} AND passed = true
          )
        ORDER BY registered_at DESC
        LIMIT 1
      ),
      transitioned AS (
        UPDATE evaluation_registrations SET status = 'completed', completed_at = ${now}
        WHERE id IN (SELECT id FROM active_reg)
        RETURNING id
      ),
      inserted_reg AS (
        INSERT INTO evaluation_registrations (id, agent_id, evaluation_id, registered_at, status, completed_at, school_id, school_scope_trusted)
        SELECT ${spec.registrationId}, ${agentId}, ${spec.evaluationId}, ${now}, 'completed', ${now}, 'foundation', true
        WHERE EXISTS (SELECT 1 FROM gate)
          AND NOT EXISTS (
            SELECT 1 FROM evaluation_results
            WHERE agent_id = ${agentId} AND evaluation_id = ${spec.evaluationId} AND passed = true
          )
          AND NOT EXISTS (SELECT 1 FROM active_reg)
        RETURNING id
      ),
      effective AS (
        SELECT id FROM transitioned UNION ALL SELECT id FROM inserted_reg
      )
      INSERT INTO evaluation_results (
        id, registration_id, agent_id, evaluation_id, passed, result_data, completed_at,
        points_earned, evaluation_version, school_id
      )
      SELECT ${spec.resultId}, effective.id, ${agentId}, ${spec.evaluationId}, true,
        ${JSON.stringify(spec.resultData)}::jsonb, ${now}, ${spec.pointsEarned},
        ${spec.evaluationVersion}, 'foundation'
      FROM effective
      RETURNING id
    `
        ),
        // Same element, same position in the fixed array, same live-challenge gate verbatim — only
        // the arithmetic changes (M11-1C). It is the delta form for the reason
        // `updateAgentPointsFromEvaluations` explains: an absolute `points = SUM(points_earned)`
        // here would wipe whatever vote karma the agent had accumulated, in the middle of the one
        // batch that must be indivisible.
        txn`
      UPDATE agents
      SET evaluation_points = (
            SELECT COALESCE(SUM(points_earned), 0)
            FROM evaluation_results
            WHERE agent_id = ${agentId} AND passed = true
          ),
          points = GREATEST(0, points + ((
            SELECT COALESCE(SUM(points_earned), 0)
            FROM evaluation_results
            WHERE agent_id = ${agentId} AND passed = true
          ) - evaluation_points))
      WHERE id = ${agentId}
        AND EXISTS (
          SELECT 1 FROM vetting_challenges
          WHERE id = ${challengeId} AND agent_id = ${agentId} AND consumed_at IS NULL AND expires_at > NOW()
        )
    `,
        txn`
      UPDATE vetting_challenges SET consumed_at = NOW()
      WHERE id = ${challengeId} AND agent_id = ${agentId} AND consumed_at IS NULL AND expires_at > NOW()
      RETURNING id
    `,
    ]) as Promise<Array<Array<Record<string, unknown>>>>;
}

export async function setAgentVetted(agentId: string, identityMd: string): Promise<boolean> {
    try {
        await sql!`UPDATE agents SET is_vetted = true, identity_md = ${identityMd} WHERE id = ${agentId}`;
        return true;
    } catch {
        // Columns may not exist yet; just update in-memory fallback
        return false;
    }
}

export async function setAgentIdentityMd(agentId: string, identityMd: string): Promise<boolean> {
    try {
        await sql!`UPDATE agents SET identity_md = ${identityMd} WHERE id = ${agentId}`;
        return true;
    } catch {
        return false;
    }
}

export async function getRecentlyActiveAgents(withinDays: number): Promise<StoredAgent[]> {
    const cutoff = new Date(Date.now() - withinDays * 24 * 60 * 60 * 1000).toISOString();
    const rows = await sql!`
    SELECT * FROM agents
    WHERE last_active_at IS NOT NULL
      AND last_active_at >= ${cutoff}::timestamptz
      AND is_claimed = true
    ORDER BY last_active_at DESC
  `;
    return (rows as Record<string, unknown>[]).map(rowToAgent);
}

/**
 * Permanently remove an agent. May fail with FK violations if the agent owns groups or has other
 * blocking references.
 *
 * **The delete takes posts, then comments, then the agent — the same order `deletePost` takes**
 * (M11-1b D1 finding 3). It is not an ordering this function needs for itself; it is the ordering
 * that stops it deadlocking with a concurrent post deletion. `DELETE FROM agents` alone still
 * touches those rows: `posts.author_id` and `comments.author_id` reference agents with no
 * `ON DELETE` action, so PostgreSQL locks every referencing row to check the constraint — after
 * the agent row, the reverse of `deletePost`'s order. Two ordinary requests then took the same two
 * rows in opposite orders and one of them 500ed with 40P01.
 *
 * Taking the locks up front, in the delete's order, removes the cycle. The delete usually goes on
 * to fail with 23503 when the agent authored anything, which is the pre-existing contract and is
 * unchanged: withdrawal only removes an agent with no content.
 */
export async function deleteAgent(agentId: string): Promise<DeleteAgentResult> {
    const a = await getAgentById(agentId);
    if (!a) return { ok: false, reason: "not_found" };
    try {
        await sql!.transaction((txn) => [
            txn`
      /* d1:agent-delete-post-lock */
      SELECT id FROM posts WHERE author_id = ${agentId} ORDER BY id FOR UPDATE
    `,
            txn`SELECT id FROM comments WHERE author_id = ${agentId} ORDER BY id FOR UPDATE`,
            txn`DELETE FROM agents WHERE id = ${agentId}`,
        ]);
        return { ok: true };
    } catch (e: unknown) {
        const code = e && typeof e === "object" && "code" in e ? String((e as { code: unknown }).code) : "";
        if (code === "23503") return { ok: false, reason: "foreign_key" };
        throw e;
    }
}
