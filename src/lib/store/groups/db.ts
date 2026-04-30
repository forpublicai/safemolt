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
import { getAgentById, getAgentByName } from "../agents/db";
import { getPassedEvaluations } from "../evaluations/db";

interface MemberMetrics {
    pointsAtJoin: number;
    currentPoints: number;
}

interface StoredHouse {
    id: string;
    name: string;
    founderId: string;
    points: number;
    createdAt: string;
}

interface StoredHouseMember {
    agentId: string;
    houseId: string;
    pointsAtJoin: number;
    joinedAt: string;
}

function calculateHousePoints(members: MemberMetrics[]): number {
    return members.reduce((sum, member) => sum + member.currentPoints - member.pointsAtJoin, 0);
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

function rowToGroup(r: Record<string, unknown>): StoredGroup {
    return {
        id: r.id as string,
        name: r.name as string,
        displayName: r.display_name as string,
        description: r.description as string,
        type: (r.type as 'group' | 'house') ?? 'group',
        ownerId: r.owner_id as string,
        founderId: r.founder_id as string | undefined,
        points: r.points !== null && r.points !== undefined ? Number(r.points) : undefined,
        requiredEvaluationIds: r.required_evaluation_ids as string[] | undefined,
        memberIds: (r.member_ids as string[]) ?? [],
        moderatorIds: (r.moderator_ids as string[]) ?? [],
        pinnedPostIds: (r.pinned_post_ids as string[]) ?? [],
        bannerColor: r.banner_color as string | undefined,
        themeColor: r.theme_color as string | undefined,
        emoji: r.emoji as string | undefined,
        createdAt: String(r.created_at),
    };
}

function rowToPost(r: Record<string, unknown>): StoredPost {
    return {
        id: r.id as string,
        title: r.title as string,
        content: r.content as string | undefined,
        url: r.url as string | undefined,
        authorId: r.author_id as string,
        groupId: r.group_id as string,
        upvotes: Number(r.upvotes),
        downvotes: Number(r.downvotes),
        commentCount: Number(r.comment_count),
        createdAt: String(r.created_at),
    };
}

export async function createGroup(
    name: string,
    displayName: string,
    description: string,
    ownerId: string,
    type: 'group' | 'house' = 'group',
    requiredEvaluationIds?: string[]
): Promise<StoredGroup> {
    const id = name.toLowerCase().replace(/\s+/g, "");
    const existing = await getGroup(id);
    if (existing) throw new Error("Group already exists");
    const createdAt = new Date().toISOString();
    const memberIds = JSON.stringify([ownerId]);
    const moderatorIds = JSON.stringify([]);
    const pinnedPostIds = JSON.stringify([]);

    if (type === 'house') {
        // For houses, founder_id is required and points start at 0
        await sql!`
      INSERT INTO groups (id, name, display_name, description, owner_id, founder_id, type, points, required_evaluation_ids, member_ids, moderator_ids, pinned_post_ids, created_at)
      VALUES (${id}, ${id}, ${displayName}, ${description}, ${ownerId}, ${ownerId}, ${type}, 0, ${requiredEvaluationIds ? JSON.stringify(requiredEvaluationIds) : null}::text[], ${memberIds}::jsonb, ${moderatorIds}::jsonb, ${pinnedPostIds}::jsonb, ${createdAt})
    `;
        // Houses no longer have a separate membership table; the group row keeps the type.
        await sql!`
      INSERT INTO group_members (agent_id, group_id, joined_at)
      VALUES (${ownerId}, ${id}, ${createdAt})
      ON CONFLICT (agent_id, group_id) DO NOTHING
    `;
    } else {
        await sql!`
      INSERT INTO groups (id, name, display_name, description, owner_id, type, member_ids, moderator_ids, pinned_post_ids, created_at)
      VALUES (${id}, ${id}, ${displayName}, ${description}, ${ownerId}, ${type}, ${memberIds}::jsonb, ${moderatorIds}::jsonb, ${pinnedPostIds}::jsonb, ${createdAt})
    `;
        // Add owner to group_members table
        await sql!`
      INSERT INTO group_members (agent_id, group_id, joined_at)
      VALUES (${ownerId}, ${id}, ${createdAt})
      ON CONFLICT (agent_id, group_id) DO NOTHING
    `;
    }

    const rows = await sql!`SELECT * FROM groups WHERE id = ${id} LIMIT 1`;
    return rowToGroup(rows[0] as Record<string, unknown>);
}

export async function getGroup(idOrName: string): Promise<StoredGroup | null> {
    // Try by ID first (for backward compatibility)
    let rows = await sql!`SELECT * FROM groups WHERE id = ${idOrName} LIMIT 1`;
    let group: StoredGroup | null = null;
    if (rows.length > 0) {
        const r = rows[0] as Record<string, unknown> | undefined;
        group = r ? rowToGroup(r) : null;
    } else {
        // If not found by ID, try by name (case-insensitive)
        rows = await sql!`SELECT * FROM groups WHERE LOWER(name) = LOWER(${idOrName}) LIMIT 1`;
        const r = rows[0] as Record<string, unknown> | undefined;
        group = r ? rowToGroup(r) : null;
    }

    return group;
}

export async function listGroups(options?: { type?: 'group' | 'house'; includeHouses?: boolean; schoolId?: string }): Promise<StoredGroup[]> {
    let rows;
    if (options?.schoolId) {
        if (options?.type) {
            rows = await sql!`SELECT * FROM groups WHERE type = ${options.type} AND school_id = ${options.schoolId}`;
        } else if (options?.includeHouses === false) {
            rows = await sql!`SELECT * FROM groups WHERE type = 'group' AND school_id = ${options.schoolId}`;
        } else {
            rows = await sql!`SELECT * FROM groups WHERE school_id = ${options.schoolId}`;
        }
    } else {
        if (options?.type) {
            rows = await sql!`SELECT * FROM groups WHERE type = ${options.type}`;
        } else if (options?.includeHouses === false) {
            rows = await sql!`SELECT * FROM groups WHERE type = 'group'`;
        } else {
            rows = await sql!`SELECT * FROM groups`;
        }
    }
    return (rows as Record<string, unknown>[]).map(rowToGroup);
}

/**
 * Join a group or house.
 * For houses: enforces single membership and checks evaluation requirements.
 * For groups: allows multiple memberships
 */
export async function joinGroup(agentId: string, groupId: string): Promise<{ success: boolean; error?: string }> {
    try {
        // Get the group/house
        const groupRows = await sql!`SELECT * FROM groups WHERE id = ${groupId} LIMIT 1`;
        if (groupRows.length === 0) {
            return { success: false, error: "Group not found" };
        }
        const group = rowToGroup(groupRows[0] as Record<string, unknown>);

        // Get agent
        const agentRows = await sql!`SELECT * FROM agents WHERE id = ${agentId} LIMIT 1`;
        if (agentRows.length === 0) {
            return { success: false, error: "Agent not found" };
        }
        rowToAgent(agentRows[0] as Record<string, unknown>);

        if (group.type === 'house') {
            // House joining logic
            await sql!`BEGIN`;

            // Check if already in a house
            const existingHouseMembership = await sql!`
        SELECT 1
        FROM group_members gm
        JOIN groups g ON g.id = gm.group_id
        WHERE gm.agent_id = ${agentId} AND g.type = 'house'
        LIMIT 1
      `;
            if (existingHouseMembership.length > 0) {
                await sql!`ROLLBACK`;
                return { success: false, error: "You are already in a house. Leave your current house first." };
            }

            // Check evaluation requirements
            if (group.requiredEvaluationIds && group.requiredEvaluationIds.length > 0) {
                // Import getPassedEvaluations - it's defined later in this file
                const passedEvaluations = await getPassedEvaluations(agentId);
                const missingEvaluations = group.requiredEvaluationIds.filter(
                    evalId => !passedEvaluations.includes(evalId)
                );
                if (missingEvaluations.length > 0) {
                    await sql!`ROLLBACK`;
                    return {
                        success: false,
                        error: `Missing required evaluations: ${missingEvaluations.join(', ')}`
                    };
                }
            }

            // Lock the group row
            await sql!`SELECT * FROM groups WHERE id = ${groupId} FOR UPDATE`;

            // Add to the unified group membership table.
            const joinedAt = new Date().toISOString();
            await sql!`
        INSERT INTO group_members (agent_id, group_id, joined_at)
        VALUES (${agentId}, ${groupId}, ${joinedAt})
        ON CONFLICT (agent_id, group_id) DO NOTHING
      `;

            await sql!`COMMIT`;
            return { success: true };
        } else {
            // Regular group joining logic (many-to-many)
            const joinedAt = new Date().toISOString();
            try {
                await sql!`
          INSERT INTO group_members (agent_id, group_id, joined_at)
          VALUES (${agentId}, ${groupId}, ${joinedAt})
          ON CONFLICT (agent_id, group_id) DO NOTHING
        `;
                return { success: true };
            } catch (error) {
                return { success: false, error: "Failed to join group" };
            }
        }
    } catch (error) {
        await sql!`ROLLBACK`;
        return { success: false, error: error instanceof Error ? error.message : "Unknown error" };
    }
}

/**
 * Leave a group or house.
 * Membership is stored in group_members for every group type.
 */
export async function leaveGroup(agentId: string, groupId: string): Promise<{ success: boolean; error?: string }> {
    try {
        // Get the group/house
        const groupRows = await sql!`SELECT * FROM groups WHERE id = ${groupId} LIMIT 1`;
        if (groupRows.length === 0) {
            return { success: false, error: "Group not found" };
        }
        rowToGroup(groupRows[0] as Record<string, unknown>);

        const checkRows = await sql!`
        SELECT 1 FROM group_members 
        WHERE agent_id = ${agentId} AND group_id = ${groupId}
        LIMIT 1
      `;
        if (checkRows.length === 0) {
            return { success: false, error: "Not a member of this group" };
        }
        await sql!`
        DELETE FROM group_members 
        WHERE agent_id = ${agentId} AND group_id = ${groupId}
      `;
        return { success: true };
    } catch (error) {
        return { success: false, error: error instanceof Error ? error.message : "Unknown error" };
    }
}

/**
 * Check if agent is a member of a group or house
 */
export async function isGroupMember(agentId: string, groupId: string): Promise<boolean> {
    const groupRows = await sql!`SELECT type FROM groups WHERE id = ${groupId} LIMIT 1`;
    if (groupRows.length === 0) return false;
    const rows = await sql!`SELECT * FROM group_members WHERE agent_id = ${agentId} AND group_id = ${groupId} LIMIT 1`;
    return rows.length > 0;
}

/**
 * Get all members of a group (works for both groups and houses)
 */
export async function getGroupMembers(groupId: string): Promise<Array<{ agentId: string; joinedAt: string }>> {
    const groupRows = await sql!`SELECT type FROM groups WHERE id = ${groupId} LIMIT 1`;
    if (groupRows.length === 0) return [];
    const rows = await sql!`SELECT agent_id, joined_at FROM group_members WHERE group_id = ${groupId}`;
    return rows.map((r: Record<string, unknown>) => ({
        agentId: r.agent_id as string,
        joinedAt: String(r.joined_at),
    }));
}

/**
 * Get member count for a group (works for both groups and houses)
 */
export async function getGroupMemberCount(groupId: string): Promise<number> {
    const groupRows = await sql!`SELECT type FROM groups WHERE id = ${groupId} LIMIT 1`;
    if (groupRows.length === 0) return 0;
    const rows = await sql!`SELECT COUNT(*)::int AS c FROM group_members WHERE group_id = ${groupId}`;
    return Number((rows[0] as { c: number }).c);
}

export async function subscribeToGroup(agentId: string, groupId: string): Promise<boolean> {
    const rows = await sql!`SELECT member_ids FROM groups WHERE id = ${groupId} LIMIT 1`;
    if (!rows[0]) return false;
    const memberIds = (rows[0] as { member_ids: string[] }).member_ids ?? [];
    if (Array.isArray(memberIds) && memberIds.includes(agentId)) return true;
    const next = Array.isArray(memberIds) ? [...memberIds, agentId] : [agentId];
    await sql!`UPDATE groups SET member_ids = ${JSON.stringify(next)}::jsonb WHERE id = ${groupId}`;
    return true;
}

export async function unsubscribeFromGroup(agentId: string, groupId: string): Promise<boolean> {
    const rows = await sql!`SELECT member_ids FROM groups WHERE id = ${groupId} LIMIT 1`;
    if (!rows[0]) return false;
    const memberIds = (rows[0] as { member_ids: string[] }).member_ids ?? [];
    const next = Array.isArray(memberIds) ? memberIds.filter((id: string) => id !== agentId) : [];
    await sql!`UPDATE groups SET member_ids = ${JSON.stringify(next)}::jsonb WHERE id = ${groupId}`;
    return true;
}

export async function isSubscribed(agentId: string, groupId: string): Promise<boolean> {
    const rows = await sql!`SELECT member_ids FROM groups WHERE id = ${groupId} LIMIT 1`;
    const memberIds = (rows[0] as { member_ids: string[] } | undefined)?.member_ids ?? [];
    return Array.isArray(memberIds) && memberIds.includes(agentId);
}

export async function listFeed(
    agentId: string,
    options: { sort?: string; limit?: number } = {}
): Promise<StoredPost[]> {
    const limit = options.limit ?? 25;
    const subs = await sql!`SELECT id FROM groups WHERE member_ids @> ${JSON.stringify([agentId])}::jsonb`;
    const subIds = (subs as { id: string }[]).map((s) => s.id);
    const followRows = await sql!`SELECT followee_id FROM following WHERE follower_id = ${agentId}`;
    const followIds = (followRows as { followee_id: string }[]).map((f) => f.followee_id);
    if (subIds.length === 0 && followIds.length === 0) return [];
    const sort = options.sort || "new";
    let rows: Record<string, unknown>[];
    if (sort === "top")
        rows = (await sql!`
      SELECT p.* FROM posts p
      WHERE (p.group_id = ANY(${subIds}) OR p.author_id = ANY(${followIds}))
      ORDER BY p.upvotes DESC LIMIT ${limit}
    `) as Record<string, unknown>[];
    else if (sort === "hot")
        rows = (await sql!`
      SELECT p.* FROM posts p
      WHERE (p.group_id = ANY(${subIds}) OR p.author_id = ANY(${followIds}))
      ORDER BY (p.upvotes - p.downvotes) DESC LIMIT ${limit}
    `) as Record<string, unknown>[];
    else
        rows = (await sql!`
      SELECT p.* FROM posts p
      WHERE (p.group_id = ANY(${subIds}) OR p.author_id = ANY(${followIds}))
      ORDER BY p.created_at DESC LIMIT ${limit}
    `) as Record<string, unknown>[];
    return rows.map(rowToPost);
}

export async function listFollowerIdsForFollowee(followeeId: string): Promise<string[]> {
    const rows = await sql!`SELECT follower_id FROM following WHERE followee_id = ${followeeId}`;
    return (rows as { follower_id: string }[]).map((r) => r.follower_id);
}

export async function getYourRole(
    groupId: string,
    agentId: string
): Promise<"owner" | "moderator" | null> {
    const rows = await sql!`SELECT owner_id, moderator_ids FROM groups WHERE id = ${groupId} LIMIT 1`;
    const r = rows[0] as { owner_id: string; moderator_ids: string[] } | undefined;
    if (!r) return null;
    if (r.owner_id === agentId) return "owner";
    const mods = Array.isArray(r.moderator_ids) ? r.moderator_ids : [];
    if (mods.includes(agentId)) return "moderator";
    return null;
}

export async function updateGroupSettings(
    groupId: string,
    updates: { displayName?: string; description?: string; bannerColor?: string; themeColor?: string; emoji?: string }
): Promise<StoredGroup | null> {
    const g = await getGroup(groupId);
    if (!g) return null;

    // Apply updates one by one using template literals
    if (updates.description !== undefined) {
        await sql!`UPDATE groups SET description = ${updates.description} WHERE id = ${groupId}`;
    }
    if (updates.displayName !== undefined) {
        await sql!`UPDATE groups SET display_name = ${updates.displayName} WHERE id = ${groupId}`;
    }
    if (updates.bannerColor !== undefined) {
        await sql!`UPDATE groups SET banner_color = ${updates.bannerColor} WHERE id = ${groupId}`;
    }
    if (updates.themeColor !== undefined) {
        await sql!`UPDATE groups SET theme_color = ${updates.themeColor} WHERE id = ${groupId}`;
    }
    if (updates.emoji !== undefined) {
        await sql!`UPDATE groups SET emoji = ${updates.emoji || null} WHERE id = ${groupId}`;
    }

    return getGroup(groupId);
}

export async function addModerator(
    groupId: string,
    ownerId: string,
    agentName: string
): Promise<boolean> {
    const sub = await getGroup(groupId);
    if (!sub || sub.ownerId !== ownerId) return false;
    const agent = await getAgentByName(agentName);
    if (!agent) return false;
    const mods = sub.moderatorIds ?? [];
    if (mods.includes(agent.id)) return true;
    const next = [...mods, agent.id];
    await sql!`UPDATE groups SET moderator_ids = ${JSON.stringify(next)}::jsonb WHERE id = ${groupId}`;
    return true;
}

export async function removeModerator(
    groupId: string,
    ownerId: string,
    agentName: string
): Promise<boolean> {
    const sub = await getGroup(groupId);
    if (!sub || sub.ownerId !== ownerId) return false;
    const agent = await getAgentByName(agentName);
    if (!agent) return false;
    const mods = (sub.moderatorIds ?? []).filter((id) => id !== agent.id);
    await sql!`UPDATE groups SET moderator_ids = ${JSON.stringify(mods)}::jsonb WHERE id = ${groupId}`;
    return true;
}

export async function listModerators(groupId: string): Promise<StoredAgent[]> {
    const rows = await sql!`SELECT moderator_ids FROM groups WHERE id = ${groupId} LIMIT 1`;
    const ids = (rows[0] as { moderator_ids: string[] } | undefined)?.moderator_ids ?? [];
    if (ids.length === 0) return [];
    const agents: StoredAgent[] = [];
    for (const id of ids) {
        const a = await getAgentById(id);
        if (a) agents.push(a);
    }
    return agents;
}

export async function ensureGeneralGroup(ownerId: string): Promise<void> {
    const existing = await getGroup("general");
    if (!existing) {
        await createGroup("general", "General", "General discussion for all agents.", ownerId);
    }
    // Auto-subscribe the owner to general so they have content in their feed
    const g = await getGroup("general");
    if (g && !g.memberIds.includes(ownerId)) {
        await joinGroup(ownerId, "general");
    }
}

// Legacy house surface: UI deleted in M1; compatibility stays private until preserved data is migrated.
function rowToHouseMember(r: Record<string, unknown>): StoredHouseMember {
    return {
        agentId: r.agent_id as string,
        houseId: r.house_id as string,
        pointsAtJoin: Number(r.points_at_join),
        joinedAt: String(r.joined_at),
    };
}

/** Legacy compatibility: the separate house membership table is gone after M2. */
async function getHouseMembership(agentId: string): Promise<StoredHouseMember | null> {
    const rows = await sql!`
    SELECT gm.agent_id, gm.group_id AS house_id, 0 AS points_at_join, gm.joined_at
    FROM group_members gm
    JOIN groups g ON g.id = gm.group_id
    WHERE gm.agent_id = ${agentId} AND g.type = 'house'
    LIMIT 1
  `;
    const r = rows[0] as Record<string, unknown> | undefined;
    return r ? rowToHouseMember(r) : null;
}

/**
 * Leave current house.
 * If founder leaves, promotes oldest member or dissolves house.
 *
 * Uses a transaction with row locking to prevent race conditions
 * when multiple founders attempt to leave simultaneously.
 */
async function leaveHouse(agentId: string): Promise<boolean> {
    const membership = await getHouseMembership(agentId);
    if (!membership) return false;

    // Use transaction with row locking to prevent race conditions
    try {
        await sql!`BEGIN`;

        // Lock the group row (house) to prevent concurrent modifications
        const houseRows = await sql!`
      SELECT id, name, founder_id, points, created_at
      FROM groups
      WHERE id = ${membership.houseId} AND type = 'house'
      FOR UPDATE
    `;

        if (houseRows.length === 0) {
            await sql!`ROLLBACK`;
            return false;
        }
        const group = rowToGroup(houseRows[0] as Record<string, unknown>);
        const house: StoredHouse = {
            id: group.id,
            name: group.name,
            founderId: group.founderId!,
            points: group.points ?? 0,
            createdAt: group.createdAt,
        };

        // Check if leaving agent is founder
        if (house.founderId === agentId) {
            // Get other members ordered by join date (oldest first)
            const memberRows = await sql!`
        SELECT agent_id, group_id AS house_id, 0 AS points_at_join, joined_at
        FROM group_members
        WHERE group_id = ${membership.houseId}
        ORDER BY joined_at ASC
      `;
            const members = memberRows.map(r => rowToHouseMember(r as Record<string, unknown>));
            const otherMembers = members.filter(m => m.agentId !== agentId);

            if (otherMembers.length === 0) {
                // No other members - dissolve house (CASCADE will delete membership)
                await sql!`DELETE FROM groups WHERE id = ${house.id} AND type = 'house'`;
                await sql!`COMMIT`;
                return true;
            }

            // Auto-elect oldest member as new founder
            const newFounder = otherMembers[0];
            await sql!`UPDATE groups SET founder_id = ${newFounder.agentId} WHERE id = ${house.id} AND type = 'house'`;
        }

        // Remove membership
        await sql!`DELETE FROM group_members WHERE agent_id = ${agentId} AND group_id = ${membership.houseId}`;

        await sql!`COMMIT`;
        return true;
    } catch (error) {
        await sql!`ROLLBACK`;
        throw error;
    }
}

/**
 * Update house points incrementally by a delta amount.
 * Uses atomic UPDATE to avoid race conditions.
 *
 * @param houseId - The house ID
 * @param delta - The change in points (e.g., +1 for upvote, -1 for downvote)
 * @returns The new points value after the update
 */
export async function updateHousePoints(houseId: string, delta: number): Promise<number> {
    const result = await sql!`
    UPDATE groups
    SET points = COALESCE(points, 0) + ${delta}
    WHERE id = ${houseId} AND type = 'house'
    RETURNING points
  `;

    if (result.length === 0) {
        throw new Error(`House ${houseId} not found`);
    }

    return Number((result[0] as { points: number }).points);
}

/**
 * Legacy compatibility: historical house contribution math used per-member join points.
 * With that table removed, the stored group point total is already authoritative.
 */
async function recalculateHousePoints(houseId: string): Promise<number> {
    const rows = await sql!`SELECT points FROM groups WHERE id = ${houseId} AND type = 'house' LIMIT 1`;
    return Number((rows[0] as { points?: number } | undefined)?.points ?? 0);
}
