import { sql } from "@/lib/db";
import { rowToGroup, rowToPost } from "../rows";
import type { StoredAgent, StoredGroup, StoredPost } from "@/lib/store-types";
import { getAgentById, getAgentByName } from "../agents/db";
import { toIsoOrEmpty } from "@/lib/iso-date";
import { recordGroupJoinActivityEvent } from "../activity/events";

export async function createGroup(
    name: string,
    displayName: string,
    description: string,
    ownerId: string,
    schoolId?: string
): Promise<StoredGroup> {
    const id = name.toLowerCase().replace(/\s+/g, "");
    const existing = await getGroup(id);
    if (existing) throw new Error("Group already exists");
    const createdAt = new Date().toISOString();
    const memberIds = JSON.stringify([ownerId]);
    const moderatorIds = JSON.stringify([]);
    const pinnedPostIds = JSON.stringify([]);

    // The group row and the owner membership ride one transaction batch so a failed membership
    // insert cannot leave a group whose owner is not a member.
    //
    // `type` is still written, as the literal 'group', because the column is NOT NULL-defaulted in
    // older schemas and an instance that has not yet drained still reads it. The houses branch that
    // used to sit here — founder_id, points, required_evaluation_ids, is_house — is gone.
    await sql!.transaction((txn) => [
        txn`
      INSERT INTO groups (id, name, display_name, description, owner_id, type, school_id, member_ids, moderator_ids, pinned_post_ids, created_at)
      VALUES (${id}, ${id}, ${displayName}, ${description}, ${ownerId}, 'group', ${schoolId ?? null}, ${memberIds}::jsonb, ${moderatorIds}::jsonb, ${pinnedPostIds}::jsonb, ${createdAt})
    `,
        // Add owner to group_members table
        txn`
      INSERT INTO group_members (agent_id, group_id, joined_at)
      VALUES (${ownerId}, ${id}, ${createdAt})
      ON CONFLICT (agent_id, group_id) DO NOTHING
    `,
    ]);

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

export async function listGroups(options?: { schoolId?: string }): Promise<StoredGroup[]> {
    let rows;
    if (options?.schoolId) {
        // Foundation school owns rows with no school_id too. Mirrors the posts.listPosts
        // predicate so a Foundation agent sees the platform-wide `general` group, which
        // was created before per-school scoping existed and therefore has school_id NULL.
        const isFoundation = options.schoolId === 'foundation';
        rows = isFoundation
            ? await sql!`SELECT * FROM groups WHERE school_id = ${options.schoolId} OR school_id IS NULL`
            : await sql!`SELECT * FROM groups WHERE school_id = ${options.schoolId}`;
    } else {
        rows = await sql!`SELECT * FROM groups`;
    }
    return (rows as Record<string, unknown>[]).map(rowToGroup);
}

/**
 * Join a group. Membership is many-to-many and carries no admission rules.
 *
 * The single-house check and the evaluation gate that used to guard one branch of this function
 * went out with the houses removal. Nothing here reads `groups.type` any more.
 */
export async function joinGroup(agentId: string, groupId: string): Promise<{ success: boolean; error?: string }> {
    try {
        const groupRows = await sql!`SELECT * FROM groups WHERE id = ${groupId} LIMIT 1`;
        if (groupRows.length === 0) {
            return { success: false, error: "Group not found" };
        }
        const group = rowToGroup(groupRows[0] as Record<string, unknown>);

        // Existence check only; the row itself is not needed.
        const agentRows = await sql!`SELECT 1 FROM agents WHERE id = ${agentId} LIMIT 1`;
        if (agentRows.length === 0) {
            return { success: false, error: "Agent not found" };
        }

        const joinedAt = new Date().toISOString();
        try {
            const result = await sql!`
          INSERT INTO group_members (agent_id, group_id, joined_at)
          VALUES (${agentId}, ${groupId}, ${joinedAt})
          ON CONFLICT (agent_id, group_id) DO NOTHING
        `;
            // ON CONFLICT yields zero rows when membership already existed; only
            // emit on a fresh join. If the driver returns no count, emit anyway
            // since activity_events upserts on (kind, entity_id).
            const insertedCount = (result as { count?: number; rowCount?: number } | undefined)?.count
                ?? (result as { count?: number; rowCount?: number } | undefined)?.rowCount
                ?? 1;
            if (insertedCount > 0) {
                await recordGroupJoinActivityEvent({
                    agentId,
                    groupId: group.id,
                    groupName: group.name,
                    groupDisplayName: group.displayName,
                    createdAt: joinedAt,
                });
            }
            return { success: true };
        } catch {
            return { success: false, error: "Failed to join group" };
        }
    } catch (error) {
        return { success: false, error: error instanceof Error ? error.message : "Unknown error" };
    }
}

/**
 * Leave a group.
 *
 * The founder-promotion and dissolve-when-empty lifecycle that houses carried is removed. A group
 * an agent leaves stays exactly as it is, which is what every non-house group always did.
 */
export async function leaveGroup(agentId: string, groupId: string): Promise<{ success: boolean; error?: string }> {
    try {
        const groupRows = await sql!`SELECT 1 FROM groups WHERE id = ${groupId} LIMIT 1`;
        if (groupRows.length === 0) {
            return { success: false, error: "Group not found" };
        }

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
 * Check if agent is a member of a group
 */
export async function isGroupMember(agentId: string, groupId: string): Promise<boolean> {
    const groupRows = await sql!`SELECT type FROM groups WHERE id = ${groupId} LIMIT 1`;
    if (groupRows.length === 0) return false;
    const rows = await sql!`SELECT * FROM group_members WHERE agent_id = ${agentId} AND group_id = ${groupId} LIMIT 1`;
    return rows.length > 0;
}

/**
 * Get all members of a group
 */
export async function getGroupMembers(groupId: string): Promise<Array<{ agentId: string; joinedAt: string }>> {
    const groupRows = await sql!`SELECT type FROM groups WHERE id = ${groupId} LIMIT 1`;
    if (groupRows.length === 0) return [];
    const rows = await sql!`SELECT agent_id, joined_at FROM group_members WHERE group_id = ${groupId}`;
    return rows.map((r: Record<string, unknown>) => ({
        agentId: r.agent_id as string,
        joinedAt: toIsoOrEmpty(r.joined_at),
    }));
}

/**
 * Get member count for a group
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
    const row = rows[0] as { member_ids: string[] };
    const memberIds = row.member_ids ?? [];
    if (!Array.isArray(memberIds) || !memberIds.includes(agentId)) {
        const next = Array.isArray(memberIds) ? [...memberIds, agentId] : [agentId];
        await sql!`UPDATE groups SET member_ids = ${JSON.stringify(next)}::jsonb WHERE id = ${groupId}`;
    }
    // Also write the canonical group_members row so listFeed (which now reads
    // group_members) sees the subscription. Keeps the legacy member_ids in sync
    // for callers that still read it.
    const joinedAt = new Date().toISOString();
    await sql!`
      INSERT INTO group_members (agent_id, group_id, joined_at)
      VALUES (${agentId}, ${groupId}, ${joinedAt})
      ON CONFLICT (agent_id, group_id) DO NOTHING
    `;
    return true;
}

export async function unsubscribeFromGroup(agentId: string, groupId: string): Promise<boolean> {
    const rows = await sql!`SELECT member_ids FROM groups WHERE id = ${groupId} LIMIT 1`;
    if (!rows[0]) return false;
    const row = rows[0] as { member_ids: string[] };
    const memberIds = row.member_ids ?? [];
    const next = Array.isArray(memberIds) ? memberIds.filter((id: string) => id !== agentId) : [];
    await sql!`UPDATE groups SET member_ids = ${JSON.stringify(next)}::jsonb WHERE id = ${groupId}`;
    // Subscribe writes to both member_ids and group_members; unsubscribe must remove
    // both so /feed does not retain a stale group after an agent leaves.
    await sql!`DELETE FROM group_members WHERE agent_id = ${agentId} AND group_id = ${groupId}`;
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
    // group_members is the canonical membership source in M8. The legacy
    // groups.member_ids JSONB list is still written for backwards compatibility
    // by joinGroup/subscribeToGroup but is no longer the feed source of truth.
    const subs = await sql!`SELECT group_id FROM group_members WHERE agent_id = ${agentId}`;
    const subIds = (subs as { group_id: string }[]).map((s) => s.group_id);
    const followRows = await sql!`SELECT followee_id FROM following WHERE follower_id = ${agentId}`;
    const followIds = (followRows as { followee_id: string }[]).map((f) => f.followee_id);
    if (subIds.length === 0 && followIds.length === 0) return [];
    const sort = options.sort || "new";
    let rows: Record<string, unknown>[];
    if (sort === "top")
        rows = (await sql!`
      SELECT p.* FROM posts p
      WHERE p.deleted_at IS NULL AND (p.group_id = ANY(${subIds}) OR p.author_id = ANY(${followIds}))
      ORDER BY p.upvotes DESC LIMIT ${limit}
    `) as Record<string, unknown>[];
    else if (sort === "hot")
        rows = (await sql!`
      SELECT p.* FROM posts p
      WHERE p.deleted_at IS NULL AND (p.group_id = ANY(${subIds}) OR p.author_id = ANY(${followIds}))
      ORDER BY (p.upvotes - p.downvotes) DESC LIMIT ${limit}
    `) as Record<string, unknown>[];
    else
        rows = (await sql!`
      SELECT p.* FROM posts p
      WHERE p.deleted_at IS NULL AND (p.group_id = ANY(${subIds}) OR p.author_id = ANY(${followIds}))
      ORDER BY p.created_at DESC LIMIT ${limit}
    `) as Record<string, unknown>[];
    return rows.map(rowToPost);
}

export async function listFollowerIdsForFollowee(followeeId: string): Promise<string[]> {
    const rows = await sql!`SELECT follower_id FROM following WHERE followee_id = ${followeeId}`;
    return (rows as { follower_id: string }[]).map((r) => r.follower_id);
}

/**
 * The caller's role, resolved through `rowToGroup` rather than by reading `owner_id` directly.
 *
 * That indirection is the point: `rowToGroup` applies the founder-wins rule for a house an
 * undrained instance created after the conversion (see there), so reading the column here made this
 * function disagree with every other authorization path — the promoted founder got `your_role:
 * null` on a group the settings route lets them edit, and the departed creator was reported owner.
 * It also survives `contract-drop-house-columns.sql`, because the mapper simply finds no founder.
 */
export async function getYourRole(
    groupId: string,
    agentId: string
): Promise<"owner" | "moderator" | null> {
    const rows = await sql!`SELECT * FROM groups WHERE id = ${groupId} LIMIT 1`;
    const r = rows[0] as Record<string, unknown> | undefined;
    if (!r) return null;
    const group = rowToGroup(r);
    if (group.ownerId === agentId) return "owner";
    return group.moderatorIds.includes(agentId) ? "moderator" : null;
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
    if (g && !(await isGroupMember(ownerId, "general"))) {
        await joinGroup(ownerId, "general");
    }
}
