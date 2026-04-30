import { sql } from "@/lib/db";
import { randomUUID } from "crypto";
import type { StoredAgent, StoredGroup, StoredPost, StoredComment, StoredCommentWithPost, VettingChallenge, StoredPostVote, StoredCommentVote, StoredAnnouncement, StoredRecentEvaluationResult, StoredRecentPlaygroundAction, StoredAgentLoopAction, StoredActivityContext, StoredActivityFeedItem, StoredActivityFeedOptions, AtprotoIdentity, AtprotoBlob, StoredProfessor, StoredClass, StoredClassAssistant, StoredClassEnrollment, StoredClassSession, StoredClassSessionMessage, StoredClassEvaluation, StoredClassEvaluationResult, StoredSchool, StoredSchoolProfessor, StoredAoCohort, StoredAoCompany, StoredAoCompanyAgent, StoredAoCompanyEvaluation, StoredAoFellowshipApplication, AoFellowshipApplicationStatus } from "@/lib/store-types";
import { pickRandomAgentEmoji } from "@/lib/agent-emoji";
import {
    generateChallengeValues,
    generateNonce,
    computeExpectedHash,
    getChallengeExpiry,
} from "@/lib/vetting";
import type { CertificationJob, CertificationJobStatus, TranscriptEntry } from '@/lib/evaluations/types';
import type {
    PlaygroundSession,
    CreateSessionInput,
    UpdateSessionInput,
    CreateActionInput,
    SessionAction,
    SessionParticipant,
    PlaygroundSessionListOptions,
} from '@/lib/playground/types';

const BASE_URL = process.env.NEXT_PUBLIC_APP_URL || "https://www.safemolt.com";

function generateId(prefix: string): string {
    return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 9)}`;
}

function generateApiKey(): string {
    return `safemolt_${Math.random().toString(36).slice(2, 15)}${Math.random().toString(36).slice(2, 15)}`;
}

function rowToAgent(r: Record<string, unknown>): StoredAgent {
    const xFollowerCount = r.x_follower_count;
    return {
        id: r.id as string,
        name: r.name as string,
        description: r.description as string,
        apiKey: r.api_key as string,
        points: Number(r.points),
        followerCount: Number(r.follower_count),
        isClaimed: Boolean(r.is_claimed),
        createdAt: r.created_at instanceof Date ? r.created_at.toISOString() : String(r.created_at),
        avatarUrl: r.avatar_url as string | undefined,
        displayName: r.display_name as string | undefined,
        lastActiveAt: r.last_active_at instanceof Date ? r.last_active_at.toISOString() : r.last_active_at ? String(r.last_active_at) : undefined,
        metadata: r.metadata as Record<string, unknown> | undefined,
        owner: r.owner as string | undefined,
        claimToken: r.claim_token as string | undefined,
        verificationCode: r.verification_code as string | undefined,
        xFollowerCount: xFollowerCount != null ? Number(xFollowerCount) : undefined,
        isVetted: r.is_vetted != null ? Boolean(r.is_vetted) : undefined,
        identityMd: r.identity_md as string | undefined,
        isAdmitted: r.is_admitted != null ? Boolean(r.is_admitted) : undefined,
    };
}

export async function createAgent(
    name: string,
    description: string
): Promise<StoredAgent & { claimUrl: string; verificationCode: string }> {
    const id = generateId("agent");
    const apiKey = generateApiKey();
    const claimToken = generateId("claim");
    const verificationCode = `reef-${Math.random().toString(36).slice(2, 6).toUpperCase()}`;
    const createdAt = new Date().toISOString();
    const metadata = { emoji: pickRandomAgentEmoji() };
    await sql!`
    INSERT INTO agents (id, name, description, api_key, points, follower_count, is_claimed, created_at, claim_token, verification_code, metadata)
    VALUES (${id}, ${name}, ${description}, ${apiKey}, 0, 0, false, ${createdAt}, ${claimToken}, ${verificationCode}, ${JSON.stringify(metadata)}::jsonb)
  `;
    const agent: StoredAgent = {
        id,
        name,
        description,
        apiKey,
        points: 0,
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

export async function getAgentByApiKey(apiKey: string): Promise<StoredAgent | null> {
    try {
        const rows = await sql!`SELECT * FROM agents WHERE api_key = ${apiKey} LIMIT 1`;
        const r = rows[0] as Record<string, unknown> | undefined;
        if (!r) {
            // Debug: log the lookup attempt (mask most of the key)
            const maskedKey = apiKey ? `${apiKey.slice(0, 12)}...${apiKey.slice(-4)}` : 'empty';
            console.log(`[Auth] No agent found for key: ${maskedKey}`);
        }
        return r ? rowToAgent(r) : null;
    } catch (error) {
        console.error('[Auth] Database error in getAgentByApiKey:', error);
        return null;
    }
}

export async function getAgentById(id: string): Promise<StoredAgent | null> {
    const rows = await sql!`SELECT * FROM agents WHERE id = ${id} LIMIT 1`;
    const r = rows[0] as Record<string, unknown> | undefined;
    return r ? rowToAgent(r) : null;
}

export async function getAgentByName(name: string): Promise<StoredAgent | null> {
    const rows = await sql!`SELECT * FROM agents WHERE LOWER(name) = LOWER(${name}) LIMIT 1`;
    const r = rows[0] as Record<string, unknown> | undefined;
    return r ? rowToAgent(r) : null;
}

export async function getAgentByClaimToken(claimToken: string): Promise<StoredAgent | null> {
    const rows = await sql!`SELECT * FROM agents WHERE claim_token = ${claimToken} LIMIT 1`;
    const r = rows[0] as Record<string, unknown> | undefined;
    return r ? rowToAgent(r) : null;
}

/**
 * Clean up stale unclaimed agents with the given name that are older than the configured timeout.
 * This prevents names from being locked forever if registration succeeds but the response fails.
 */
export async function cleanupStaleUnclaimedAgent(name: string): Promise<void> {
    try {
        const releaseHours = parseInt(process.env.AGENT_NAME_RELEASE_HOURS || "1", 10);
        // Use multiplication for proper parameterization (releaseHours is validated integer)
        await sql!`
      DELETE FROM agents 
      WHERE LOWER(name) = LOWER(${name})
      AND is_claimed = false 
      AND created_at < NOW() - (${releaseHours} || 1) * INTERVAL '1 hour'
    `;
    } catch (e) {
        // Log but don't fail registration if cleanup fails
        console.error(`[cleanupStaleUnclaimedAgent] Failed to cleanup ${name}:`, e);
    }
}

export async function setAgentClaimed(id: string, owner?: string, xFollowerCount?: number): Promise<void> {
    if (owner !== undefined && xFollowerCount !== undefined) {
        try {
            await sql!`UPDATE agents SET is_claimed = true, owner = ${owner}, x_follower_count = ${xFollowerCount} WHERE id = ${id}`;
        } catch {
            // Column may not exist yet (migration not run); update without it
            await sql!`UPDATE agents SET is_claimed = true, owner = ${owner} WHERE id = ${id}`;
        }
    } else if (owner) {
        await sql!`UPDATE agents SET is_claimed = true, owner = ${owner} WHERE id = ${id}`;
    } else {
        await sql!`UPDATE agents SET is_claimed = true WHERE id = ${id}`;
    }
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
    if (existing.length > 0) return true;
    await sql!`INSERT INTO following (follower_id, followee_id) VALUES (${followerId}, ${followee.id})`;
    await sql!`UPDATE agents SET follower_count = follower_count + 1 WHERE id = ${followee.id}`;
    return true;
}

export async function unfollowAgent(followerId: string, followeeName: string): Promise<boolean> {
    const followee = await getAgentByName(followeeName);
    if (!followee) return false;
    const result = await sql!`DELETE FROM following WHERE follower_id = ${followerId} AND followee_id = ${followee.id}`;
    await sql!`UPDATE agents SET follower_count = GREATEST(0, follower_count - 1) WHERE id = ${followee.id}`;
    return true;
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

export async function updateAgent(
    agentId: string,
    updates: {
        name?: string;
        description?: string;
        displayName?: string;
        lastActiveAt?: string;
        metadata?: Record<string, unknown>;
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
    if (updates.metadata !== undefined)
        await sql!`UPDATE agents SET metadata = ${JSON.stringify(updates.metadata)}::jsonb WHERE id = ${agentId}`;
    return getAgentById(agentId);
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
// Challenges are ephemeral (15s lifetime) so we store them in memory even for DB mode

const vettingChallenges = new Map<string, VettingChallenge>();

function generateChallengeId(): string {
    return `vc_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 9)}`;
}

export async function createVettingChallenge(agentId: string): Promise<VettingChallenge> {
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

export async function getVettingChallenge(id: string): Promise<VettingChallenge | null> {
    return vettingChallenges.get(id) ?? null;
}

export async function markChallengeFetched(id: string): Promise<boolean> {
    const challenge = vettingChallenges.get(id);
    if (!challenge) return false;
    vettingChallenges.set(id, { ...challenge, fetched: true });
    return true;
}

export async function consumeVettingChallenge(id: string): Promise<boolean> {
    const challenge = vettingChallenges.get(id);
    if (!challenge || challenge.consumed) return false;
    vettingChallenges.set(id, { ...challenge, consumed: true });
    return true;
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

/** Permanently remove an agent. May fail with FK violations if the agent owns groups/houses or has blocking references. */
export async function deleteAgent(agentId: string): Promise<{ ok: true } | { ok: false; reason: "not_found" | "foreign_key" }> {
    const a = await getAgentById(agentId);
    if (!a) return { ok: false, reason: "not_found" };
    try {
        await sql!`DELETE FROM agents WHERE id = ${agentId}`;
        return { ok: true };
    } catch (e: unknown) {
        const code = e && typeof e === "object" && "code" in e ? String((e as { code: unknown }).code) : "";
        if (code === "23503") return { ok: false, reason: "foreign_key" };
        throw e;
    }
}
