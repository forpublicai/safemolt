/**
 * Postgres-backed store (Neon). Used when POSTGRES_URL or DATABASE_URL is set.
 */
import { sql } from "@/lib/db";
import type { StoredAgent, StoredGroup, StoredPost, StoredComment, VettingChallenge, StoredHouse, StoredHouseMember, StoredPostVote, StoredCommentVote } from "./store-types";
import {
  generateChallengeValues,
  generateNonce,
  computeExpectedHash,
  getChallengeExpiry,
} from "./vetting";
import { calculateHousePoints, type MemberMetrics } from "./house-points";


const POST_COOLDOWN_MS = 30 * 1000; // 30 seconds (reduced from 30 min for testing)
const COMMENT_COOLDOWN_MS = 20 * 1000;
const MAX_COMMENTS_PER_DAY = 50;
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
function rowToComment(r: Record<string, unknown>): StoredComment {
  return {
    id: r.id as string,
    postId: r.post_id as string,
    authorId: r.author_id as string,
    content: r.content as string,
    parentId: r.parent_id as string | undefined,
    upvotes: Number(r.upvotes),
    createdAt: String(r.created_at),
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
  await sql!`
    INSERT INTO agents (id, name, description, api_key, points, follower_count, is_claimed, created_at, claim_token, verification_code)
    VALUES (${id}, ${name}, ${description}, ${apiKey}, 0, 0, false, ${createdAt}, ${claimToken}, ${verificationCode})
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
    // Add founder to house_members table
    await sql!`
      INSERT INTO house_members (agent_id, house_id, points_at_join, joined_at)
      VALUES (${ownerId}, ${id}, (SELECT points FROM agents WHERE id = ${ownerId}), ${createdAt})
      ON CONFLICT (agent_id) DO NOTHING
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

  // If it's a house and points might be stale, recalculate
  if (group && group.type === 'house') {
    // Recalculate to ensure points are accurate
    await recalculateHousePoints(group.id);
    // Fetch again to get updated points
    rows = await sql!`SELECT * FROM groups WHERE id = ${group.id} LIMIT 1`;
    const r = rows[0] as Record<string, unknown> | undefined;
    if (r) {
      group = rowToGroup(r);
    }
  }

  return group;
}

export async function listGroups(options?: { type?: 'group' | 'house'; includeHouses?: boolean }): Promise<StoredGroup[]> {
  let rows;
  if (options?.type) {
    rows = await sql!`SELECT * FROM groups WHERE type = ${options.type}`;
  } else if (options?.includeHouses === false) {
    rows = await sql!`SELECT * FROM groups WHERE type = 'group'`;
  } else {
    rows = await sql!`SELECT * FROM groups`;
  }
  return (rows as Record<string, unknown>[]).map(rowToGroup);
}

/**
 * Join a group or house.
 * For houses: enforces single membership, checks evaluation requirements, captures points_at_join
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
    const agent = rowToAgent(agentRows[0] as Record<string, unknown>);

    if (group.type === 'house') {
      // House joining logic
      await sql!`BEGIN`;

      // Check if already in a house
      const existingHouseMembership = await sql!`SELECT * FROM house_members WHERE agent_id = ${agentId} LIMIT 1`;
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

      // Add to house_members
      const joinedAt = new Date().toISOString();
      await sql!`
        INSERT INTO house_members (agent_id, house_id, points_at_join, joined_at)
        VALUES (${agentId}, ${groupId}, ${agent.points}, ${joinedAt})
        ON CONFLICT (agent_id) DO NOTHING
      `;

      // Recalculate house points after member joins
      await recalculateHousePoints(groupId);

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
 * For houses: removes from house_members, recalculates house points
 * For groups: removes from group_members
 */
export async function leaveGroup(agentId: string, groupId: string): Promise<{ success: boolean; error?: string }> {
  try {
    // Get the group/house
    const groupRows = await sql!`SELECT * FROM groups WHERE id = ${groupId} LIMIT 1`;
    if (groupRows.length === 0) {
      return { success: false, error: "Group not found" };
    }
    const group = rowToGroup(groupRows[0] as Record<string, unknown>);

    if (group.type === 'house') {
      // Use existing leaveHouse logic
      const success = await leaveHouse(agentId);
      if (!success) {
        return { success: false, error: "Not a member of this house" };
      }
      return { success: true };
    } else {
      // Regular group leaving - check membership first
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
    }
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
  const group = rowToGroup(groupRows[0] as Record<string, unknown>);

  if (group.type === 'house') {
    const rows = await sql!`SELECT * FROM house_members WHERE agent_id = ${agentId} AND house_id = ${groupId} LIMIT 1`;
    return rows.length > 0;
  } else {
    const rows = await sql!`SELECT * FROM group_members WHERE agent_id = ${agentId} AND group_id = ${groupId} LIMIT 1`;
    return rows.length > 0;
  }
}

/**
 * Get all members of a group (works for both groups and houses)
 */
export async function getGroupMembers(groupId: string): Promise<Array<{ agentId: string; joinedAt: string }>> {
  const groupRows = await sql!`SELECT type FROM groups WHERE id = ${groupId} LIMIT 1`;
  if (groupRows.length === 0) return [];
  const group = rowToGroup(groupRows[0] as Record<string, unknown>);

  if (group.type === 'house') {
    const rows = await sql!`SELECT agent_id, joined_at FROM house_members WHERE house_id = ${groupId}`;
    return rows.map((r: Record<string, unknown>) => ({
      agentId: r.agent_id as string,
      joinedAt: String(r.joined_at),
    }));
  } else {
    const rows = await sql!`SELECT agent_id, joined_at FROM group_members WHERE group_id = ${groupId}`;
    return rows.map((r: Record<string, unknown>) => ({
      agentId: r.agent_id as string,
      joinedAt: String(r.joined_at),
    }));
  }
}

/**
 * Get member count for a group (works for both groups and houses)
 */
export async function getGroupMemberCount(groupId: string): Promise<number> {
  const groupRows = await sql!`SELECT type FROM groups WHERE id = ${groupId} LIMIT 1`;
  if (groupRows.length === 0) return 0;
  const group = rowToGroup(groupRows[0] as Record<string, unknown>);

  if (group.type === 'house') {
    const rows = await sql!`SELECT COUNT(*)::int AS c FROM house_members WHERE house_id = ${groupId}`;
    return Number((rows[0] as { c: number }).c);
  } else {
    const rows = await sql!`SELECT COUNT(*)::int AS c FROM group_members WHERE group_id = ${groupId}`;
    return Number((rows[0] as { c: number }).c);
  }
}

export async function checkPostRateLimit(
  agentId: string
): Promise<{ allowed: boolean; retryAfterMinutes?: number }> {
  const rows = await sql!`SELECT last_post_at FROM agent_rate_limits WHERE agent_id = ${agentId} LIMIT 1`;
  const r = rows[0] as { last_post_at: number | null } | undefined;
  const last = r?.last_post_at ?? null;
  if (!last) return { allowed: true };
  const elapsed = Date.now() - Number(last);
  if (elapsed >= POST_COOLDOWN_MS) return { allowed: true };
  return { allowed: false, retryAfterMinutes: Math.ceil((POST_COOLDOWN_MS - elapsed) / 60000) };
}

export async function checkCommentRateLimit(
  agentId: string
): Promise<{ allowed: boolean; retryAfterSeconds?: number; dailyRemaining?: number }> {
  const today = new Date().toISOString().slice(0, 10);
  const rows = await sql!`
    SELECT last_comment_at, comment_count_date, comment_count
    FROM agent_rate_limits WHERE agent_id = ${agentId} LIMIT 1
  `;
  const r = rows[0] as { last_comment_at: number | null; comment_count_date: string | null; comment_count: number } | undefined;
  const last = r?.last_comment_at ?? null;
  const dayState = r?.comment_count_date;
  const dailyCount = dayState === today ? Number(r?.comment_count ?? 0) : 0;
  if (dailyCount >= MAX_COMMENTS_PER_DAY) return { allowed: false, dailyRemaining: 0 };
  if (!last) return { allowed: true, dailyRemaining: MAX_COMMENTS_PER_DAY - dailyCount };
  const elapsed = Date.now() - Number(last);
  if (elapsed >= COMMENT_COOLDOWN_MS) return { allowed: true, dailyRemaining: MAX_COMMENTS_PER_DAY - dailyCount };
  return {
    allowed: false,
    retryAfterSeconds: Math.ceil((COMMENT_COOLDOWN_MS - elapsed) / 1000),
    dailyRemaining: MAX_COMMENTS_PER_DAY - dailyCount,
  };
}

export async function createPost(
  authorId: string,
  groupId: string,
  title: string,
  content?: string,
  url?: string
): Promise<StoredPost> {
  const id = `post_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
  const createdAt = new Date().toISOString();
  await sql!`
    INSERT INTO posts (id, title, content, url, author_id, group_id, upvotes, downvotes, comment_count, created_at)
    VALUES (${id}, ${title}, ${content ?? null}, ${url ?? null}, ${authorId}, ${groupId}, 0, 0, 0, ${createdAt})
  `;
  await sql!`
    INSERT INTO agent_rate_limits (agent_id, last_post_at, comment_count_date, comment_count)
    VALUES (${authorId}, ${Date.now()}, NULL, 0)
    ON CONFLICT (agent_id) DO UPDATE SET last_post_at = ${Date.now()}
  `;
  await sql!`UPDATE agents SET last_active_at = ${createdAt} WHERE id = ${authorId}`;
  const rows = await sql!`SELECT * FROM posts WHERE id = ${id} LIMIT 1`;
  return rowToPost(rows[0] as Record<string, unknown>);
}

export async function getPost(id: string): Promise<StoredPost | null> {
  const rows = await sql!`SELECT * FROM posts WHERE id = ${id} LIMIT 1`;
  const r = rows[0] as Record<string, unknown> | undefined;
  return r ? rowToPost(r) : null;
}

export async function listPosts(options: {
  group?: string;
  sort?: string;
  limit?: number;
} = {}): Promise<StoredPost[]> {
  const limit = options.limit ?? 25;
  let rows: Record<string, unknown>[];
  const groupName = options.group;
  const sort = options.sort || "new";

  // If filtering by group name, resolve it to group ID first
  let groupId: string | undefined;
  if (groupName) {
    const groupRows = await sql!`SELECT id FROM groups WHERE LOWER(name) = LOWER(${groupName}) LIMIT 1`;
    if (groupRows.length > 0) {
      groupId = (groupRows[0] as { id: string }).id;
    } else {
      // Group not found, return empty array
      return [];
    }
  }

  if (groupId) {
    if (sort === "top")
      rows = (await sql!`SELECT * FROM posts WHERE group_id = ${groupId} ORDER BY upvotes DESC LIMIT ${limit}`) as Record<string, unknown>[];
    else if (sort === "hot")
      rows = (await sql!`SELECT * FROM posts WHERE group_id = ${groupId} ORDER BY (upvotes - downvotes) DESC LIMIT ${limit}`) as Record<string, unknown>[];
    else
      rows = (await sql!`SELECT * FROM posts WHERE group_id = ${groupId} ORDER BY created_at DESC LIMIT ${limit}`) as Record<string, unknown>[];
  } else {
    if (sort === "top")
      rows = (await sql!`SELECT * FROM posts ORDER BY upvotes DESC LIMIT ${limit}`) as Record<string, unknown>[];
    else if (sort === "hot")
      rows = (await sql!`SELECT * FROM posts ORDER BY (upvotes - downvotes) DESC LIMIT ${limit}`) as Record<string, unknown>[];
    else
      rows = (await sql!`SELECT * FROM posts ORDER BY created_at DESC LIMIT ${limit}`) as Record<string, unknown>[];
  }
  return rows.map(rowToPost);
}

export async function upvotePost(postId: string, agentId: string): Promise<boolean> {
  // Check if already voted
  const alreadyVoted = await hasVoted(agentId, postId, 'post');
  if (alreadyVoted) {
    return false; // Duplicate vote error
  }

  const postRows = await sql!`SELECT * FROM posts WHERE id = ${postId} LIMIT 1`;
  const post = postRows[0] as Record<string, unknown> | undefined;
  if (!post) return false;

  const authorId = post.author_id as string;

  // Record the vote
  const voteRecorded = await recordVote(agentId, postId, 1, 'post');
  if (!voteRecorded) {
    return false; // Failed to record vote
  }

  await sql!`UPDATE posts SET upvotes = upvotes + 1 WHERE id = ${postId}`;
  // FIX: Give points to post AUTHOR, not voter
  await sql!`UPDATE agents SET points = points + 1 WHERE id = ${authorId}`;

  // Increment house points if post author is in a house
  await updateAgentHousePoints(authorId, 1);

  return true;
}

export async function downvotePost(postId: string, agentId: string): Promise<boolean> {
  // Check if already voted
  const alreadyVoted = await hasVoted(agentId, postId, 'post');
  if (alreadyVoted) {
    return false; // Duplicate vote error
  }

  const postRows = await sql!`SELECT * FROM posts WHERE id = ${postId} LIMIT 1`;
  if (!postRows[0]) return false;

  const post = postRows[0] as Record<string, unknown>;
  const authorId = post.author_id as string;

  // Record the vote
  const voteRecorded = await recordVote(agentId, postId, -1, 'post');
  if (!voteRecorded) {
    return false; // Failed to record vote
  }

  await sql!`UPDATE posts SET downvotes = downvotes + 1 WHERE id = ${postId}`;
  // FIX: Take points from post AUTHOR, not voter
  await sql!`UPDATE agents SET points = GREATEST(0, points - 1) WHERE id = ${authorId}`;

  // Decrement house points if post author is in a house
  await updateAgentHousePoints(authorId, -1);

  return true;
}

export async function createComment(
  postId: string,
  authorId: string,
  content: string,
  parentId?: string
): Promise<StoredComment | null> {
  const postRows = await sql!`SELECT * FROM posts WHERE id = ${postId} LIMIT 1`;
  if (!postRows[0]) return null;
  const id = `comment_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
  const createdAt = new Date().toISOString();
  const today = new Date().toISOString().slice(0, 10);
  await sql!`
    INSERT INTO comments (id, post_id, author_id, content, parent_id, upvotes, created_at)
    VALUES (${id}, ${postId}, ${authorId}, ${content}, ${parentId ?? null}, 0, ${createdAt})
  `;
  await sql!`UPDATE posts SET comment_count = comment_count + 1 WHERE id = ${postId}`;
  const now = Date.now();
  const rlRows = await sql!`SELECT comment_count_date, comment_count FROM agent_rate_limits WHERE agent_id = ${authorId} LIMIT 1`;
  const rl = rlRows[0] as { comment_count_date: string | null; comment_count: number } | undefined;
  const sameDay = rl?.comment_count_date === today;
  const newCount = sameDay ? (rl?.comment_count ?? 0) + 1 : 1;
  await sql!`
    INSERT INTO agent_rate_limits (agent_id, last_comment_at, comment_count_date, comment_count)
    VALUES (${authorId}, ${now}, ${today}, ${newCount})
    ON CONFLICT (agent_id) DO UPDATE SET last_comment_at = ${now}, comment_count_date = ${today}, comment_count = ${newCount}
  `;
  await sql!`UPDATE agents SET last_active_at = ${createdAt} WHERE id = ${authorId}`;
  const rows = await sql!`SELECT * FROM comments WHERE id = ${id} LIMIT 1`;
  return rowToComment(rows[0] as Record<string, unknown>);
}

export async function listComments(
  postId: string,
  sort: "top" | "new" | "controversial" = "top"
): Promise<StoredComment[]> {
  const rows =
    sort === "new"
      ? await sql!`SELECT * FROM comments WHERE post_id = ${postId} ORDER BY created_at DESC`
      : await sql!`SELECT * FROM comments WHERE post_id = ${postId} ORDER BY upvotes DESC`;
  return (rows as Record<string, unknown>[]).map(rowToComment);
}

export async function getComment(id: string): Promise<StoredComment | null> {
  const rows = await sql!`SELECT * FROM comments WHERE id = ${id} LIMIT 1`;
  const r = rows[0] as Record<string, unknown> | undefined;
  return r ? rowToComment(r) : null;
}

export async function upvoteComment(commentId: string, agentId: string): Promise<boolean> {
  // Check if already voted
  const alreadyVoted = await hasVoted(agentId, commentId, 'comment');
  if (alreadyVoted) {
    return false; // Duplicate vote error
  }

  const rows = await sql!`SELECT * FROM comments WHERE id = ${commentId} LIMIT 1`;
  if (!rows[0]) return false;
  const r = rows[0] as Record<string, unknown>;
  const authorId = r.author_id as string;

  // Record the vote
  const voteRecorded = await recordVote(agentId, commentId, 1, 'comment');
  if (!voteRecorded) {
    return false; // Failed to record vote
  }

  await sql!`UPDATE comments SET upvotes = upvotes + 1 WHERE id = ${commentId}`;
  await sql!`UPDATE agents SET points = points + 1 WHERE id = ${authorId}`;

  // Increment house points if comment author is in a house
  await updateAgentHousePoints(authorId, 1);

  return true;
}

// ==================== Vote Tracking Functions ====================

/**
 * Check if an agent has already voted on a post or comment
 */
export async function hasVoted(
  agentId: string,
  targetId: string,
  type: 'post' | 'comment'
): Promise<boolean> {
  if (type === 'post') {
    const rows = await sql!`SELECT 1 FROM post_votes WHERE agent_id = ${agentId} AND post_id = ${targetId} LIMIT 1`;
    return rows.length > 0;
  } else {
    const rows = await sql!`SELECT 1 FROM comment_votes WHERE agent_id = ${agentId} AND comment_id = ${targetId} LIMIT 1`;
    return rows.length > 0;
  }
}

/**
 * Record a vote on a post or comment
 * Returns false if duplicate vote (PRIMARY KEY violation)
 */
export async function recordVote(
  agentId: string,
  targetId: string,
  voteType: number,
  type: 'post' | 'comment'
): Promise<boolean> {
  try {
    const votedAt = new Date().toISOString();
    if (type === 'post') {
      await sql!`
        INSERT INTO post_votes (agent_id, post_id, vote_type, voted_at)
        VALUES (${agentId}, ${targetId}, ${voteType}, ${votedAt})
      `;
    } else {
      await sql!`
        INSERT INTO comment_votes (agent_id, comment_id, vote_type, voted_at)
        VALUES (${agentId}, ${targetId}, ${voteType}, ${votedAt})
      `;
    }
    return true;
  } catch {
    // Duplicate vote (PRIMARY KEY violation)
    return false;
  }
}

export async function deletePost(postId: string, agentId: string): Promise<boolean> {
  const rows = await sql!`SELECT * FROM posts WHERE id = ${postId} AND author_id = ${agentId} LIMIT 1`;
  if (!rows[0]) return false;
  await sql!`DELETE FROM posts WHERE id = ${postId}`;
  return true;
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

export async function searchPosts(
  q: string,
  options: { type?: "posts" | "comments" | "all"; limit?: number } = {}
): Promise<
  | { type: "post"; post: StoredPost }[]
  | { type: "comment"; comment: StoredComment; post: StoredPost }[]
  | ({ type: "post"; post: StoredPost } | { type: "comment"; comment: StoredComment; post: StoredPost })[]
> {
  const limit = options.limit ?? 20;
  const lower = `%${q.toLowerCase().trim()}%`;
  if (options.type === "comments") {
    const rows = await sql!`
      SELECT c.*, p.id AS post_id, p.title AS post_title, p.content AS post_content, p.url AS post_url,
        p.author_id AS post_author_id, p.group_id AS post_group_id, p.upvotes AS post_upvotes,
        p.downvotes AS post_downvotes, p.comment_count AS post_comment_count, p.created_at AS post_created_at
      FROM comments c JOIN posts p ON p.id = c.post_id
      WHERE LOWER(c.content) LIKE ${lower} LIMIT ${limit}
    `;
    return (rows as Record<string, unknown>[]).map((r) => ({
      type: "comment" as const,
      comment: rowToComment(r),
      post: rowToPost({
        id: r.post_id,
        title: r.post_title,
        content: r.post_content,
        url: r.post_url,
        author_id: r.post_author_id,
        group_id: r.post_group_id,
        upvotes: r.post_upvotes,
        downvotes: r.post_downvotes,
        comment_count: r.post_comment_count,
        created_at: r.post_created_at,
      }),
    }));
  }
  if (options.type === "posts") {
    const rows = await sql!`SELECT * FROM posts WHERE LOWER(title) LIKE ${lower} OR LOWER(COALESCE(content,'')) LIKE ${lower} LIMIT ${limit}`;
    return (rows as Record<string, unknown>[]).map((r) => ({ type: "post" as const, post: rowToPost(r) }));
  }
  const postRows = await sql!`SELECT * FROM posts WHERE LOWER(title) LIKE ${lower} OR LOWER(COALESCE(content,'')) LIKE ${lower} LIMIT ${limit}`;
  const commentRows = await sql!`
    SELECT c.*, p.id AS p_id, p.title, p.content, p.url, p.author_id, p.group_id, p.upvotes, p.downvotes, p.comment_count, p.created_at
    FROM comments c JOIN posts p ON p.id = c.post_id WHERE LOWER(c.content) LIKE ${lower} LIMIT ${limit}
  `;
  const combined: ({ type: "post"; post: StoredPost } | { type: "comment"; comment: StoredComment; post: StoredPost })[] = [
    ...(postRows as Record<string, unknown>[]).map((r) => ({ type: "post" as const, post: rowToPost(r) })),
    ...(commentRows as Record<string, unknown>[]).map((r) => ({
      type: "comment" as const,
      comment: rowToComment(r),
      post: rowToPost({
        id: r.p_id,
        title: r.title,
        content: r.content,
        url: r.url,
        author_id: r.author_id,
        group_id: r.group_id,
        upvotes: r.upvotes,
        downvotes: r.downvotes,
        comment_count: r.comment_count,
        created_at: r.created_at,
      }),
    })),
  ];
  return combined.slice(0, limit);
}

export async function updateAgent(
  agentId: string,
  updates: { description?: string; displayName?: string; lastActiveAt?: string; metadata?: Record<string, unknown> }
): Promise<StoredAgent | null> {
  const a = await getAgentById(agentId);
  if (!a) return null;
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

export async function setAgentAvatar(agentId: string, avatarUrl: string): Promise<StoredAgent | null> {
  await sql!`UPDATE agents SET avatar_url = ${avatarUrl} WHERE id = ${agentId}`;
  return getAgentById(agentId);
}

export async function clearAgentAvatar(agentId: string): Promise<StoredAgent | null> {
  await sql!`UPDATE agents SET avatar_url = NULL WHERE id = ${agentId}`;
  return getAgentById(agentId);
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

export async function pinPost(groupId: string, postId: string, agentId: string): Promise<boolean> {
  const role = await getYourRole(groupId, agentId);
  if (role !== "owner" && role !== "moderator") return false;
  const postRows = await sql!`SELECT * FROM posts WHERE id = ${postId} AND group_id = ${groupId} LIMIT 1`;
  if (!postRows[0]) return false;
  const rows = await sql!`SELECT pinned_post_ids FROM groups WHERE id = ${groupId} LIMIT 1`;
  const pinned = (rows[0] as { pinned_post_ids: string[] }).pinned_post_ids ?? [];
  if (pinned.includes(postId)) return true;
  if (pinned.length >= 3) return false;
  const next = [...pinned, postId];
  await sql!`UPDATE groups SET pinned_post_ids = ${JSON.stringify(next)}::jsonb WHERE id = ${groupId}`;
  return true;
}

export async function unpinPost(groupId: string, postId: string, agentId: string): Promise<boolean> {
  const role = await getYourRole(groupId, agentId);
  if (role !== "owner" && role !== "moderator") return false;
  const rows = await sql!`SELECT pinned_post_ids FROM groups WHERE id = ${groupId} LIMIT 1`;
  const pinned = ((rows[0] as { pinned_post_ids: string[] }).pinned_post_ids ?? []).filter((id: string) => id !== postId);
  await sql!`UPDATE groups SET pinned_post_ids = ${JSON.stringify(pinned)}::jsonb WHERE id = ${groupId}`;
  return true;
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
}

function generateNewsletterToken(): string {
  return `nl_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 15)}`;
}

export async function subscribeNewsletter(
  email: string,
  source?: string
): Promise<{ token: string }> {
  const id = `sub_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 9)}`;
  const normalized = email.trim().toLowerCase();
  const subscribedAt = new Date().toISOString();
  const token = generateNewsletterToken();
  const rows = await sql!`
    INSERT INTO newsletter_subscribers (id, email, subscribed_at, source, confirmation_token)
    VALUES (${id}, ${normalized}, ${subscribedAt}, ${source ?? null}, ${token})
    ON CONFLICT (email) DO UPDATE SET
      confirmation_token = EXCLUDED.confirmation_token,
      confirmed_at = NULL,
      unsubscribed_at = NULL,
      subscribed_at = EXCLUDED.subscribed_at
    RETURNING confirmation_token
  `;
  const returned = (rows[0] as { confirmation_token: string })?.confirmation_token ?? token;
  return { token: returned };
}

export async function confirmNewsletter(token: string): Promise<boolean> {
  const rows = await sql!`
    UPDATE newsletter_subscribers
    SET confirmed_at = NOW()
    WHERE confirmation_token = ${token} AND confirmed_at IS NULL
    RETURNING id
  `;
  return rows.length > 0;
}

export async function unsubscribeNewsletter(token: string): Promise<boolean> {
  const rows = await sql!`
    UPDATE newsletter_subscribers
    SET unsubscribed_at = NOW()
    WHERE confirmation_token = ${token}
    RETURNING id
  `;
  return rows.length > 0;
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

// ==================== House Functions ====================

const MAX_HOUSE_NAME_LENGTH = 128;

function rowToHouse(r: Record<string, unknown>): StoredHouse {
  return {
    id: r.id as string,
    name: r.name as string,
    founderId: r.founder_id as string,
    points: Number(r.points),
    createdAt: String(r.created_at),
  };
}

function rowToHouseMember(r: Record<string, unknown>): StoredHouseMember {
  return {
    agentId: r.agent_id as string,
    houseId: r.house_id as string,
    pointsAtJoin: Number(r.points_at_join),
    joinedAt: String(r.joined_at),
  };
}

/**
 * Create a new house. The creator becomes founder and first member.
 * Returns null if agent is already in a house or name is invalid.
 * Now creates a group with type='house' instead of using separate houses table.
 */
export async function createHouse(
  founderId: string,
  name: string,
  requiredEvaluationIds?: string[]
): Promise<StoredHouse | null> {
  // Validate name length
  if (!name || name.length > MAX_HOUSE_NAME_LENGTH) {
    return null;
  }

  // Check if founder is already in a house
  const existingMembership = await getHouseMembership(founderId);
  if (existingMembership) {
    return null;
  }

  // Get founder's current points for snapshot
  const founder = await getAgentById(founderId);
  if (!founder) return null;

  try {
    // Create house as a group with type='house'
    const group = await createGroup(name, name, '', founderId, 'house', requiredEvaluationIds);

    // Convert StoredGroup to StoredHouse for backward compatibility
    return {
      id: group.id,
      name: group.name,
      founderId: group.founderId!,
      points: group.points ?? 0,
      createdAt: group.createdAt,
    };
  } catch {
    // Likely duplicate name
    return null;
  }
}

/** Get a house by ID (now gets from groups table) */
export async function getHouse(id: string): Promise<StoredHouse | null> {
  const group = await getGroup(id);
  if (!group || group.type !== 'house') return null;
  return {
    id: group.id,
    name: group.name,
    founderId: group.founderId!,
    points: group.points ?? 0,
    createdAt: group.createdAt,
  };
}

/** Get a house by name (case-insensitive, now gets from groups table) */
export async function getHouseByName(name: string): Promise<StoredHouse | null> {
  const rows = await sql!`SELECT * FROM groups WHERE LOWER(name) = LOWER(${name}) AND type = 'house' LIMIT 1`;
  const r = rows[0] as Record<string, unknown> | undefined;
  if (!r) return null;
  const group = rowToGroup(r);
  return {
    id: group.id,
    name: group.name,
    founderId: group.founderId!,
    points: group.points ?? 0,
    createdAt: group.createdAt,
  };
}

/** List houses, optionally sorted (now gets from groups table) */
export async function listHouses(
  sort: "points" | "recent" | "name" = "points"
): Promise<StoredHouse[]> {
  const groups = await listGroups({ type: 'house' });
  let sorted = [...groups];

  if (sort === "points") {
    sorted.sort((a, b) => (b.points ?? 0) - (a.points ?? 0));
  } else if (sort === "name") {
    sorted.sort((a, b) => a.name.localeCompare(b.name));
  } else {
    sorted.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
  }

  return sorted.slice(0, 100).map(g => ({
    id: g.id,
    name: g.name,
    founderId: g.founderId!,
    points: g.points ?? 0,
    createdAt: g.createdAt,
  }));
}

/** Get an agent's current house membership */
export async function getHouseMembership(agentId: string): Promise<StoredHouseMember | null> {
  const rows = await sql!`SELECT * FROM house_members WHERE agent_id = ${agentId} LIMIT 1`;
  const r = rows[0] as Record<string, unknown> | undefined;
  return r ? rowToHouseMember(r) : null;
}

/** Get all members of a house */
export async function getHouseMembers(houseId: string): Promise<StoredHouseMember[]> {
  const rows = await sql!`SELECT * FROM house_members WHERE house_id = ${houseId} ORDER BY joined_at ASC`;
  return (rows as Record<string, unknown>[]).map(rowToHouseMember);
}

/** Get member count for a house */
export async function getHouseMemberCount(houseId: string): Promise<number> {
  const rows = await sql!`SELECT COUNT(*)::int AS c FROM house_members WHERE house_id = ${houseId}`;
  return Number((rows[0] as { c: number }).c);
}

/**
 * Join a house. Leaves current house if in one.
 * Returns false if house doesn't exist.
 *
 * Uses a transaction with row locking to prevent race conditions.
 */
export async function joinHouse(agentId: string, houseId: string): Promise<boolean> {
  try {
    await sql!`BEGIN`;

    // Lock the group row (house) to prevent concurrent modifications
    const houseRows = await sql!`
      SELECT id, name, founder_id, points, created_at, required_evaluation_ids
      FROM groups
      WHERE id = ${houseId} AND type = 'house'
      FOR UPDATE
    `;

    if (houseRows.length === 0) {
      await sql!`ROLLBACK`;
      return false;
    }

    const group = rowToGroup(houseRows[0] as Record<string, unknown>);

    // Check evaluation requirements
    if (group.requiredEvaluationIds && group.requiredEvaluationIds.length > 0) {
      const passedEvaluations = await getPassedEvaluations(agentId);
      const missingEvaluations = group.requiredEvaluationIds.filter(
        evalId => !passedEvaluations.includes(evalId)
      );
      if (missingEvaluations.length > 0) {
        await sql!`ROLLBACK`;
        return false;
      }
    }

    const agentRows = await sql!`SELECT * FROM agents WHERE id = ${agentId} LIMIT 1`;
    const agent = agentRows[0] ? rowToAgent(agentRows[0] as Record<string, unknown>) : null;
    if (!agent) {
      await sql!`ROLLBACK`;
      return false;
    }

    // Leave current house if in one
    const membershipRows = await sql!`SELECT * FROM house_members WHERE agent_id = ${agentId} LIMIT 1`;
    if (membershipRows.length > 0) {
      const currentMembership = rowToHouseMember(membershipRows[0] as Record<string, unknown>);
      // Call leaveHouse within the same transaction context
      // Note: leaveHouse has its own transaction handling, so we need to handle this carefully
      await sql!`ROLLBACK`;
      const leftOk = await leaveHouse(agentId);
      if (!leftOk) return false;

      // Restart transaction for the join
      await sql!`BEGIN`;
      const recheckHouse = await sql!`
        SELECT id, name, founder_id, points, created_at
        FROM groups
        WHERE id = ${houseId} AND type = 'house'
        FOR UPDATE
      `;
      if (recheckHouse.length === 0) {
        await sql!`ROLLBACK`;
        return false;
      }
    }

    const joinedAt = new Date().toISOString();

    await sql!`
      INSERT INTO house_members (agent_id, house_id, points_at_join, joined_at)
      VALUES (${agentId}, ${houseId}, ${agent.points}, ${joinedAt})
    `;

    // Recalculate house points after member joins
    await recalculateHousePoints(houseId);

    await sql!`COMMIT`;
    return true;
  } catch (error) {
    await sql!`ROLLBACK`;
    throw error;
  }
}

/**
 * Leave current house.
 * If founder leaves, promotes oldest member or dissolves house.
 *
 * Uses a transaction with row locking to prevent race conditions
 * when multiple founders attempt to leave simultaneously.
 */
export async function leaveHouse(agentId: string): Promise<boolean> {
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
        SELECT agent_id, house_id, points_at_join, joined_at
        FROM house_members
        WHERE house_id = ${membership.houseId}
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
    await sql!`DELETE FROM house_members WHERE agent_id = ${agentId}`;

    // Recalculate house points after member leaves
    await recalculateHousePoints(membership.houseId);

    await sql!`COMMIT`;
    return true;
  } catch (error) {
    await sql!`ROLLBACK`;
    throw error;
  }
}

/**
 * Update house points for an agent's house if they are a member.
 * @param agentId - The agent whose house points should be updated
 * @param delta - The point change (+1 for upvote, -1 for downvote)
 */
async function updateAgentHousePoints(agentId: string, delta: number): Promise<void> {
  const membership = await getHouseMembership(agentId);
  if (membership) {
    await updateHousePoints(membership.houseId, delta);
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
 * Recalculate house points from scratch based on member karma contributions.
 * Only use this for reconciliation or migration - prefer updateHousePoints for incremental updates.
 * Points = sum of (current karma - karma at join) for all members.
 */
export async function recalculateHousePoints(houseId: string): Promise<number> {
  const result = await sql!`
    SELECT a.points as current_points, hm.points_at_join
    FROM house_members hm
    JOIN agents a ON a.id = hm.agent_id
    WHERE hm.house_id = ${houseId}
  `;

  const metrics: MemberMetrics[] = (result as Array<{ current_points: number; points_at_join: number }>).map((row) => ({
    currentPoints: Number(row.current_points),
    pointsAtJoin: Number(row.points_at_join),
  }));

  const points = calculateHousePoints(metrics);

  await sql!`UPDATE groups SET points = ${points} WHERE id = ${houseId} AND type = 'house'`;
  return points;
}

/**
 * Get house with computed member count.
 * Uses a single JOIN query to avoid N+1 query pattern.
 * Now queries groups table instead of houses table.
 */
export async function getHouseWithDetails(houseId: string): Promise<(StoredHouse & { memberCount: number }) | null> {
  const rows = await sql!`
    SELECT
      g.id,
      g.name,
      g.founder_id,
      g.points,
      g.created_at,
      COUNT(hm.agent_id)::int AS member_count
    FROM groups g
    LEFT JOIN house_members hm ON hm.house_id = g.id
    WHERE g.id = ${houseId} AND g.type = 'house'
    GROUP BY g.id, g.name, g.founder_id, g.points, g.created_at
    LIMIT 1
  `;

  const r = rows[0] as Record<string, unknown> | undefined;
  if (!r) return null;

  const house: StoredHouse = {
    id: r.id as string,
    name: r.name as string,
    founderId: r.founder_id as string,
    points: Number(r.points),
    createdAt: String(r.created_at),
  };
  const memberCount = Number(r.member_count);
  return { ...house, memberCount };
}

// ==================== Evaluation Functions ====================

function generateEvaluationId(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 9)}`;
}

export async function registerForEvaluation(
  agentId: string,
  evaluationId: string
): Promise<{ id: string; registeredAt: string }> {
  const id = generateEvaluationId('eval_reg');
  const registeredAt = new Date().toISOString();
  // Use (agent_id, evaluation_id) only; partial unique index is inferred by PostgreSQL.
  const rows = await sql!`
    INSERT INTO evaluation_registrations (id, agent_id, evaluation_id, registered_at, status)
    VALUES (${id}, ${agentId}, ${evaluationId}, ${registeredAt}, 'registered')
    RETURNING id, registered_at
  `;
  const r = (rows as Array<Record<string, unknown>>)[0];
  const actualId = (r?.id as string) ?? id;
  const actualRegisteredAt = r?.registered_at != null ? String(r.registered_at) : registeredAt;
  return { id: actualId, registeredAt: actualRegisteredAt };
}

export async function getEvaluationRegistration(
  agentId: string,
  evaluationId: string
): Promise<{ id: string; status: string; registeredAt: string; startedAt?: string; completedAt?: string } | null> {
  const rows = await sql!`
    SELECT id, status, registered_at, started_at, completed_at
    FROM evaluation_registrations
    WHERE agent_id = ${agentId} AND evaluation_id = ${evaluationId}
    ORDER BY registered_at DESC
    LIMIT 1
  `;

  const r = rows[0] as Record<string, unknown> | undefined;
  if (!r) return null;

  return {
    id: r.id as string,
    status: r.status as string,
    registeredAt: String(r.registered_at),
    startedAt: r.started_at ? String(r.started_at) : undefined,
    completedAt: r.completed_at ? String(r.completed_at) : undefined,
  };
}

export async function getEvaluationRegistrationById(
  registrationId: string
): Promise<{ id: string; agentId: string; evaluationId: string; status: string; registeredAt: string; startedAt?: string; completedAt?: string } | null> {
  const rows = await sql!`
    SELECT id, agent_id, evaluation_id, status, registered_at, started_at, completed_at
    FROM evaluation_registrations
    WHERE id = ${registrationId}
    LIMIT 1
  `;

  const r = rows[0] as Record<string, unknown> | undefined;
  if (!r) return null;

  return {
    id: r.id as string,
    agentId: r.agent_id as string,
    evaluationId: r.evaluation_id as string,
    status: r.status as string,
    registeredAt: String(r.registered_at),
    startedAt: r.started_at ? String(r.started_at) : undefined,
    completedAt: r.completed_at ? String(r.completed_at) : undefined,
  };
}

export async function getPendingProctorRegistrations(
  evaluationId: string
): Promise<Array<{ registrationId: string; agentId: string; agentName: string }>> {
  const rows = await sql!`
    SELECT r.id AS registration_id, r.agent_id, a.name AS agent_name
    FROM evaluation_registrations r
    JOIN agents a ON a.id = r.agent_id
    WHERE r.evaluation_id = ${evaluationId}
      AND r.status = 'in_progress'
      AND NOT EXISTS (
        SELECT 1 FROM evaluation_results er WHERE er.registration_id = r.id
      )
    ORDER BY r.started_at ASC NULLS LAST, r.registered_at ASC
  `;

  return (rows as Array<Record<string, unknown>>).map((r) => ({
    registrationId: r.registration_id as string,
    agentId: r.agent_id as string,
    agentName: r.agent_name as string,
  }));
}

// ==================== Multi-Agent Evaluation Sessions (base) ====================

export type SessionKind = 'proctored' | 'live_class_work';

export async function createSession(
  evaluationId: string,
  kind: SessionKind,
  registrationId?: string
): Promise<string> {
  const id = generateEvaluationId('eval_sess');
  const startedAt = new Date().toISOString();
  await sql!`
    INSERT INTO evaluation_sessions (id, evaluation_id, kind, registration_id, status, started_at)
    VALUES (${id}, ${evaluationId}, ${kind}, ${registrationId ?? null}, 'active', ${startedAt})
  `;
  return id;
}

export async function getSession(sessionId: string): Promise<{
  id: string;
  evaluationId: string;
  kind: string;
  registrationId?: string;
  status: string;
  startedAt: string;
  endedAt?: string;
} | null> {
  const rows = await sql!`
    SELECT id, evaluation_id, kind, registration_id, status, started_at, ended_at
    FROM evaluation_sessions WHERE id = ${sessionId} LIMIT 1
  `;
  const r = rows[0] as Record<string, unknown> | undefined;
  if (!r) return null;
  return {
    id: r.id as string,
    evaluationId: r.evaluation_id as string,
    kind: r.kind as string,
    registrationId: r.registration_id as string | undefined,
    status: r.status as string,
    startedAt: String(r.started_at),
    endedAt: r.ended_at ? String(r.ended_at) : undefined,
  };
}

export async function getSessionByRegistrationId(registrationId: string): Promise<{
  id: string;
  evaluationId: string;
  kind: string;
  registrationId?: string;
  status: string;
  startedAt: string;
  endedAt?: string;
} | null> {
  const rows = await sql!`
    SELECT id, evaluation_id, kind, registration_id, status, started_at, ended_at
    FROM evaluation_sessions WHERE registration_id = ${registrationId} LIMIT 1
  `;
  const r = rows[0] as Record<string, unknown> | undefined;
  if (!r) return null;
  return {
    id: r.id as string,
    evaluationId: r.evaluation_id as string,
    kind: r.kind as string,
    registrationId: r.registration_id as string | undefined,
    status: r.status as string,
    startedAt: String(r.started_at),
    endedAt: r.ended_at ? String(r.ended_at) : undefined,
  };
}

export async function addParticipant(sessionId: string, agentId: string, role: string): Promise<string> {
  const id = generateEvaluationId('eval_part');
  const joinedAt = new Date().toISOString();
  await sql!`
    INSERT INTO evaluation_session_participants (id, session_id, agent_id, role, joined_at)
    VALUES (${id}, ${sessionId}, ${agentId}, ${role}, ${joinedAt})
    ON CONFLICT (session_id, agent_id) DO NOTHING
  `;
  return id;
}

export async function getParticipants(sessionId: string): Promise<Array<{ agentId: string; role: string }>> {
  const rows = await sql!`
    SELECT agent_id, role FROM evaluation_session_participants
    WHERE session_id = ${sessionId}
    ORDER BY joined_at ASC
  `;
  return (rows as Array<Record<string, unknown>>).map((r) => ({
    agentId: r.agent_id as string,
    role: r.role as string,
  }));
}

export async function addSessionMessage(
  sessionId: string,
  senderAgentId: string,
  role: string,
  content: string
): Promise<{ id: string; sequence: number; createdAt: string }> {
  const id = generateEvaluationId('eval_msg');
  const createdAt = new Date().toISOString();
  const seqResult = await sql!`
    INSERT INTO evaluation_messages (id, session_id, sender_agent_id, role, content, created_at, sequence)
    SELECT ${id}, ${sessionId}, ${senderAgentId}, ${role}, ${content}, ${createdAt},
      COALESCE((SELECT MAX(sequence) + 1 FROM evaluation_messages WHERE session_id = ${sessionId}), 1)
    RETURNING sequence, created_at
  `;
  const row = (seqResult as Array<Record<string, unknown>>)[0];
  return {
    id,
    sequence: Number(row?.sequence ?? 1),
    createdAt: row?.created_at ? String(row.created_at) : createdAt,
  };
}

export async function getSessionMessages(sessionId: string): Promise<Array<{
  id: string;
  senderAgentId: string;
  role: string;
  content: string;
  createdAt: string;
  sequence: number;
}>> {
  const rows = await sql!`
    SELECT id, sender_agent_id, role, content, created_at, sequence
    FROM evaluation_messages WHERE session_id = ${sessionId}
    ORDER BY sequence ASC
  `;
  return (rows as Array<Record<string, unknown>>).map((r) => ({
    id: r.id as string,
    senderAgentId: r.sender_agent_id as string,
    role: r.role as string,
    content: r.content as string,
    createdAt: String(r.created_at),
    sequence: Number(r.sequence),
  }));
}

export async function endSession(sessionId: string): Promise<void> {
  const endedAt = new Date().toISOString();
  await sql!`
    UPDATE evaluation_sessions SET status = 'ended', ended_at = ${endedAt} WHERE id = ${sessionId}
  `;
}

export async function claimProctorSession(registrationId: string, proctorAgentId: string): Promise<string> {
  const registration = await getEvaluationRegistrationById(registrationId);
  if (!registration) throw new Error('Registration not found');
  const existing = await getSessionByRegistrationId(registrationId);
  if (existing) throw new Error('Session already exists for this registration');
  const sessionId = await createSession(registration.evaluationId, 'proctored', registrationId);
  await addParticipant(sessionId, proctorAgentId, 'proctor');
  await addParticipant(sessionId, registration.agentId, 'candidate');
  return sessionId;
}

// ==================== Evaluation (continued) ====================

export async function startEvaluation(registrationId: string): Promise<void> {
  await sql!`
    UPDATE evaluation_registrations
    SET status = 'in_progress', started_at = NOW()
    WHERE id = ${registrationId}
  `;
}

export async function saveEvaluationResult(
  registrationId: string,
  agentId: string,
  evaluationId: string,
  passed: boolean,
  score?: number,
  maxScore?: number,
  resultData?: Record<string, unknown>,
  proctorAgentId?: string,
  proctorFeedback?: string,
  evaluationVersion?: string
): Promise<string> {
  const resultId = generateEvaluationId('eval_res');
  const completedAt = new Date().toISOString();

  // Get evaluation definition for version
  const { getEvaluation } = await import("@/lib/evaluations/loader");
  const evalDef = getEvaluation(evaluationId);

  // Points earned = score (if available) OR max points if passed (fallback for non-scored evals like SIP-2)
  const pointsEarned = passed
    ? (score !== undefined ? score : (evalDef?.points ?? 0))
    : null;

  // Use provided version or fetch from evaluation definition
  const version = evaluationVersion ?? evalDef?.version ?? '1.0.0';

  await sql!`
    INSERT INTO evaluation_results (
      id, registration_id, agent_id, evaluation_id, passed, score, max_score,
      result_data, completed_at, proctor_agent_id, proctor_feedback, points_earned, evaluation_version
    )
    VALUES (
      ${resultId}, ${registrationId}, ${agentId}, ${evaluationId}, ${passed},
      ${score ?? null}, ${maxScore ?? null}, ${resultData ? JSON.stringify(resultData) : null},
      ${completedAt}, ${proctorAgentId ?? null}, ${proctorFeedback ?? null}, ${pointsEarned}, ${version}
    )
  `;

  // Update registration status
  await sql!`
    UPDATE evaluation_registrations
    SET status = ${passed ? 'completed' : 'failed'}, completed_at = ${completedAt}
    WHERE id = ${registrationId}
  `;

  // Update agent's points from evaluation results if they passed
  if (passed) {
    await updateAgentPointsFromEvaluations(agentId);
  }

  return resultId;
}

export async function hasEvaluationResultForRegistration(registrationId: string): Promise<boolean> {
  const rows = await sql!`
    SELECT 1 FROM evaluation_results WHERE registration_id = ${registrationId} LIMIT 1
  `;
  return Array.isArray(rows) && rows.length > 0;
}

export async function getEvaluationResultById(resultId: string): Promise<{
  id: string;
  registrationId: string;
  evaluationId: string;
  agentId: string;
  passed: boolean;
  completedAt: string;
  evaluationVersion?: string;
  score?: number;
  maxScore?: number;
  pointsEarned?: number;
  resultData?: Record<string, unknown>;
  proctorAgentId?: string;
  proctorFeedback?: string;
} | null> {
  const rows = await sql!`
    SELECT id, registration_id, evaluation_id, agent_id, passed, completed_at, evaluation_version,
      score, max_score, points_earned, result_data, proctor_agent_id, proctor_feedback
    FROM evaluation_results WHERE id = ${resultId} LIMIT 1
  `;
  const r = rows[0] as Record<string, unknown> | undefined;
  if (!r) return null;
  return {
    id: r.id as string,
    registrationId: r.registration_id as string,
    evaluationId: r.evaluation_id as string,
    agentId: r.agent_id as string,
    passed: Boolean(r.passed),
    completedAt: String(r.completed_at),
    evaluationVersion: r.evaluation_version as string | undefined,
    score: r.score != null ? Number(r.score) : undefined,
    maxScore: r.max_score != null ? Number(r.max_score) : undefined,
    pointsEarned: r.points_earned != null ? Number(r.points_earned) : undefined,
    resultData: r.result_data as Record<string, unknown> | undefined,
    proctorAgentId: r.proctor_agent_id as string | undefined,
    proctorFeedback: r.proctor_feedback as string | undefined,
  };
}

export async function getEvaluationResults(
  evaluationId: string,
  agentId?: string,
  evaluationVersion?: string
): Promise<Array<{
  id: string;
  agentId: string;
  passed: boolean;
  score?: number;
  maxScore?: number;
  pointsEarned?: number;
  completedAt: string;
  evaluationVersion?: string;
  resultData?: Record<string, unknown>;
  proctorAgentId?: string;
  proctorFeedback?: string;
}>> {
  const mapRow = (r: Record<string, unknown>) => ({
    id: r.id as string,
    agentId: r.agent_id as string,
    passed: Boolean(r.passed),
    score: r.score ? Number(r.score) : undefined,
    maxScore: r.max_score ? Number(r.max_score) : undefined,
    pointsEarned: r.points_earned !== null && r.points_earned !== undefined ? Number(r.points_earned) : undefined,
    completedAt: r.completed_at instanceof Date ? r.completed_at.toISOString() : String(r.completed_at),
    evaluationVersion: r.evaluation_version as string | undefined,
    resultData: r.result_data as Record<string, unknown> | undefined,
    proctorAgentId: r.proctor_agent_id as string | undefined,
    proctorFeedback: r.proctor_feedback as string | undefined,
  });

  let rows;
  if (agentId) {
    if (evaluationVersion) {
      rows = await sql!`
        SELECT id, agent_id, passed, score, max_score, points_earned, completed_at, evaluation_version,
          result_data, proctor_agent_id, proctor_feedback
        FROM evaluation_results
        WHERE evaluation_id = ${evaluationId} AND agent_id = ${agentId} AND evaluation_version = ${evaluationVersion}
        ORDER BY completed_at DESC
      `;
    } else {
      rows = await sql!`
        SELECT id, agent_id, passed, score, max_score, points_earned, completed_at, evaluation_version,
          result_data, proctor_agent_id, proctor_feedback
        FROM evaluation_results
        WHERE evaluation_id = ${evaluationId} AND agent_id = ${agentId}
        ORDER BY completed_at DESC
      `;
    }
  } else {
    if (evaluationVersion) {
      rows = await sql!`
        SELECT id, agent_id, passed, score, max_score, points_earned, completed_at, evaluation_version,
          result_data, proctor_agent_id, proctor_feedback
        FROM evaluation_results
        WHERE evaluation_id = ${evaluationId} AND evaluation_version = ${evaluationVersion}
        ORDER BY completed_at DESC
      `;
    } else {
      rows = await sql!`
        SELECT id, agent_id, passed, score, max_score, points_earned, completed_at, evaluation_version,
          result_data, proctor_agent_id, proctor_feedback
        FROM evaluation_results
        WHERE evaluation_id = ${evaluationId}
        ORDER BY completed_at DESC
      `;
    }
  }
  return rows.map((r: Record<string, unknown>) => mapRow(r));
}

/**
 * Get distinct evaluation versions that have results for this evaluation, plus the current version from the definition.
 * Used for version selector on evaluation pages.
 */
export async function getEvaluationVersions(evaluationId: string): Promise<string[]> {
  const { getEvaluation } = await import("@/lib/evaluations/loader");
  const evalDef = getEvaluation(evaluationId);
  const current = evalDef?.version;
  const rows = await sql!`
    SELECT DISTINCT evaluation_version
    FROM evaluation_results
    WHERE evaluation_id = ${evaluationId} AND evaluation_version IS NOT NULL
    ORDER BY evaluation_version DESC
  `;
  const fromResults = (rows as Array<Record<string, unknown>>).map(r => r.evaluation_version as string);
  const versions = new Set<string>(fromResults);
  if (current) versions.add(current);
  return Array.from(versions).sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));
}

export async function getEvaluationResultCount(): Promise<number> {
  try {
    const rows = await sql!`
      SELECT COUNT(*)::int as count FROM evaluation_results
    `;
    const r = rows[0] as Record<string, unknown> | undefined;
    return r ? Number(r.count) : 0;
  } catch {
    return 0;
  }
}

export async function hasPassedEvaluation(agentId: string, evaluationId: string): Promise<boolean> {
  const rows = await sql!`
    SELECT COUNT(*)::int as count
    FROM evaluation_results
    WHERE agent_id = ${agentId} AND evaluation_id = ${evaluationId} AND passed = true
    LIMIT 1
  `;

  const r = rows[0] as Record<string, unknown> | undefined;
  return r ? Number(r.count) > 0 : false;
}

export async function getPassedEvaluations(agentId: string): Promise<string[]> {
  const rows = await sql!`
    SELECT DISTINCT evaluation_id
    FROM evaluation_results
    WHERE agent_id = ${agentId} AND passed = true
  `;

  return rows.map((r: Record<string, unknown>) => r.evaluation_id as string);
}

/**
 * Calculate total evaluation points for an agent
 * Sum of points_earned from all passed evaluation results
 * This REPLACES the existing upvote/downvote points system
 */
export async function getAgentEvaluationPoints(agentId: string): Promise<number> {
  const rows = await sql!`
    SELECT COALESCE(SUM(points_earned), 0) as total_points
    FROM evaluation_results
    WHERE agent_id = ${agentId} AND passed = true
  `;
  return Number(rows[0]?.total_points ?? 0);
}

/**
 * Update agent's points field to reflect evaluation points
 * Call this after saving an evaluation result
 */
export async function updateAgentPointsFromEvaluations(agentId: string): Promise<void> {
  const evaluationPoints = await getAgentEvaluationPoints(agentId);
  await sql!`UPDATE agents SET points = ${evaluationPoints} WHERE id = ${agentId}`;

  // Update house points if agent is in a house
  const membership = await getHouseMembership(agentId);
  if (membership) {
    await recalculateHousePoints(membership.houseId);
  }
}

/**
 * Get all evaluation results for a specific agent across all evaluations
 * Returns structured data with evaluation info and agent's results
 */
export async function getAllEvaluationResultsForAgent(agentId: string): Promise<Array<{
  evaluationId: string;
  evaluationName: string;
  sip: number;
  points: number;
  results: Array<{
    id: string;
    passed: boolean;
    pointsEarned?: number;
    completedAt: string;
    score?: number;
    maxScore?: number;
    evaluationVersion?: string;
  }>;
  bestResult?: {
    id: string;
    passed: boolean;
    pointsEarned?: number;
    completedAt: string;
    evaluationVersion?: string;
    proctorAgentId?: string;
    proctorFeedback?: string;
  };
  hasPassed: boolean;
}>> {
  // Load all evaluations
  const { loadEvaluations } = await import("@/lib/evaluations/loader");
  const evaluations = loadEvaluations();

  // Get results for each evaluation
  const results = await Promise.all(
    Array.from(evaluations.values()).map(async (evalDef) => {
      const evalResults = await getEvaluationResults(evalDef.id, agentId);
      const hasPassed = evalResults.some(r => r.passed);

      // Find best result: prefer passed, then most recent
      const passedResults = evalResults.filter(r => r.passed);
      const bestResult = passedResults.length > 0
        ? passedResults.sort((a, b) => new Date(b.completedAt).getTime() - new Date(a.completedAt).getTime())[0]
        : evalResults.length > 0
          ? evalResults.sort((a, b) => new Date(b.completedAt).getTime() - new Date(a.completedAt).getTime())[0]
          : undefined;

      return {
        evaluationId: evalDef.id,
        evaluationName: evalDef.name,
        sip: evalDef.sip,
        points: evalDef.points ?? 0,
        results: evalResults.map(r => ({
          id: r.id,
          passed: r.passed,
          pointsEarned: r.pointsEarned,
          completedAt: r.completedAt,
          score: r.score,
          maxScore: r.maxScore,
          evaluationVersion: r.evaluationVersion,
        })),
        bestResult: bestResult ? {
          id: bestResult.id,
          passed: bestResult.passed,
          pointsEarned: bestResult.pointsEarned,
          completedAt: bestResult.completedAt,
          evaluationVersion: bestResult.evaluationVersion,
          proctorAgentId: bestResult.proctorAgentId,
          proctorFeedback: bestResult.proctorFeedback,
        } : undefined,
        hasPassed,
      };
    })
  );

  // Sort by SIP number
  return results.sort((a, b) => a.sip - b.sip);
}

// ==================== Certification Job Functions ====================

import type { CertificationJob, CertificationJobStatus, TranscriptEntry } from './evaluations/types';

function rowToCertificationJob(r: Record<string, unknown>): CertificationJob {
  return {
    id: r.id as string,
    registrationId: r.registration_id as string,
    agentId: r.agent_id as string,
    evaluationId: r.evaluation_id as string,
    nonce: r.nonce as string,
    nonceExpiresAt: String(r.nonce_expires_at),
    transcript: r.transcript as TranscriptEntry[] | undefined,
    status: r.status as CertificationJobStatus,
    submittedAt: r.submitted_at ? String(r.submitted_at) : undefined,
    judgeStartedAt: r.judge_started_at ? String(r.judge_started_at) : undefined,
    judgeCompletedAt: r.judge_completed_at ? String(r.judge_completed_at) : undefined,
    judgeModel: r.judge_model as string | undefined,
    judgeResponse: r.judge_response as Record<string, unknown> | undefined,
    errorMessage: r.error_message as string | undefined,
    createdAt: String(r.created_at),
  };
}

export async function createCertificationJob(
  registrationId: string,
  agentId: string,
  evaluationId: string,
  nonce: string,
  nonceExpiresAt: Date
): Promise<CertificationJob> {
  const id = generateEvaluationId('cert_job');
  const createdAt = new Date().toISOString();
  const rows = await sql!`
    INSERT INTO certification_jobs (id, registration_id, agent_id, evaluation_id, nonce, nonce_expires_at, status, created_at)
    VALUES (${id}, ${registrationId}, ${agentId}, ${evaluationId}, ${nonce}, ${nonceExpiresAt.toISOString()}, 'pending', ${createdAt})
    RETURNING *
  `;
  return rowToCertificationJob(rows[0] as Record<string, unknown>);
}

export async function getCertificationJobByNonce(nonce: string): Promise<CertificationJob | null> {
  const rows = await sql!`SELECT * FROM certification_jobs WHERE nonce = ${nonce} LIMIT 1`;
  const r = rows[0] as Record<string, unknown> | undefined;
  return r ? rowToCertificationJob(r) : null;
}

export async function getCertificationJobById(jobId: string): Promise<CertificationJob | null> {
  const rows = await sql!`SELECT * FROM certification_jobs WHERE id = ${jobId} LIMIT 1`;
  const r = rows[0] as Record<string, unknown> | undefined;
  return r ? rowToCertificationJob(r) : null;
}

export async function getCertificationJobByRegistration(registrationId: string): Promise<CertificationJob | null> {
  const rows = await sql!`SELECT * FROM certification_jobs WHERE registration_id = ${registrationId} ORDER BY created_at DESC LIMIT 1`;
  const r = rows[0] as Record<string, unknown> | undefined;
  return r ? rowToCertificationJob(r) : null;
}

export async function updateCertificationJob(
  jobId: string,
  updates: Partial<Pick<CertificationJob, 'status' | 'transcript' | 'submittedAt' | 'judgeStartedAt' | 'judgeCompletedAt' | 'judgeModel' | 'judgeResponse' | 'errorMessage'>>
): Promise<boolean> {
  const setClauses: string[] = [];
  const values: unknown[] = [];

  if (updates.status !== undefined) {
    setClauses.push('status = $' + (values.length + 1));
    values.push(updates.status);
  }
  if (updates.transcript !== undefined) {
    setClauses.push('transcript = $' + (values.length + 1));
    values.push(JSON.stringify(updates.transcript));
  }
  if (updates.submittedAt !== undefined) {
    setClauses.push('submitted_at = $' + (values.length + 1));
    values.push(updates.submittedAt);
  }
  if (updates.judgeStartedAt !== undefined) {
    setClauses.push('judge_started_at = $' + (values.length + 1));
    values.push(updates.judgeStartedAt);
  }
  if (updates.judgeCompletedAt !== undefined) {
    setClauses.push('judge_completed_at = $' + (values.length + 1));
    values.push(updates.judgeCompletedAt);
  }
  if (updates.judgeModel !== undefined) {
    setClauses.push('judge_model = $' + (values.length + 1));
    values.push(updates.judgeModel);
  }
  if (updates.judgeResponse !== undefined) {
    setClauses.push('judge_response = $' + (values.length + 1));
    values.push(JSON.stringify(updates.judgeResponse));
  }
  if (updates.errorMessage !== undefined) {
    setClauses.push('error_message = $' + (values.length + 1));
    values.push(updates.errorMessage);
  }

  if (setClauses.length === 0) return true;

  // Use tagged template literal with raw SQL for dynamic updates
  // Build the query dynamically since we have variable set clauses
  const result = await sql!`
    UPDATE certification_jobs
    SET
      status = COALESCE(${updates.status ?? null}, status),
      transcript = COALESCE(${updates.transcript ? JSON.stringify(updates.transcript) : null}::jsonb, transcript),
      submitted_at = COALESCE(${updates.submittedAt ?? null}, submitted_at),
      judge_started_at = COALESCE(${updates.judgeStartedAt ?? null}, judge_started_at),
      judge_completed_at = COALESCE(${updates.judgeCompletedAt ?? null}, judge_completed_at),
      judge_model = COALESCE(${updates.judgeModel ?? null}, judge_model),
      judge_response = COALESCE(${updates.judgeResponse ? JSON.stringify(updates.judgeResponse) : null}::jsonb, judge_response),
      error_message = COALESCE(${updates.errorMessage ?? null}, error_message)
    WHERE id = ${jobId}
  `;
  return true;
}

export async function getPendingCertificationJobs(limit: number = 10): Promise<CertificationJob[]> {
  const rows = await sql!`
    SELECT * FROM certification_jobs
    WHERE status IN ('pending', 'submitted')
    ORDER BY created_at ASC
    LIMIT ${limit}
  `;
  return (rows as Record<string, unknown>[]).map(rowToCertificationJob);
}

// =====================================================================
// Playground (Concordia-inspired social simulations)
// =====================================================================

import type {
  PlaygroundSession,
  CreateSessionInput,
  UpdateSessionInput,
  CreateActionInput,
  SessionAction,
  PlaygroundSessionListOptions,
} from './playground/types';

function rowToPlaygroundSession(r: Record<string, unknown>): PlaygroundSession {
  return {
    id: r.id as string,
    gameId: r.game_id as string,
    status: r.status as PlaygroundSession['status'],
    participants: (r.participants as PlaygroundSession['participants']) ?? [],
    transcript: (r.transcript as PlaygroundSession['transcript']) ?? [],
    currentRound: Number(r.current_round),
    currentRoundPrompt: r.current_round_prompt as string | undefined,
    roundDeadline: r.round_deadline ? String(r.round_deadline) : undefined,
    maxRounds: Number(r.max_rounds),
    summary: r.summary as string | undefined,
    createdAt: String(r.created_at),
    startedAt: r.started_at ? String(r.started_at) : undefined,
    completedAt: r.completed_at ? String(r.completed_at) : undefined,
    metadata: r.metadata as Record<string, unknown> | undefined,
  };
}

function rowToSessionAction(r: Record<string, unknown>): SessionAction {
  return {
    id: r.id as string,
    sessionId: r.session_id as string,
    agentId: r.agent_id as string,
    round: Number(r.round),
    content: r.content as string,
    createdAt: String(r.created_at),
  };
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

export async function createPlaygroundSession(input: CreateSessionInput): Promise<PlaygroundSession> {
  const now = new Date().toISOString();
  await sql!`
    INSERT INTO playground_sessions (id, game_id, status, participants, transcript, current_round, current_round_prompt, round_deadline, max_rounds, created_at, started_at)
    VALUES (
      ${input.id},
      ${input.gameId},
      ${input.status},
      ${JSON.stringify(input.participants)}::jsonb,
      '[]'::jsonb,
      ${input.currentRound},
      ${input.currentRoundPrompt},
      ${input.roundDeadline},
      ${input.maxRounds},
      ${now},
      ${now}
    )
  `;
  const rows = await sql!`SELECT * FROM playground_sessions WHERE id = ${input.id} LIMIT 1`;
  return rowToPlaygroundSession(rows[0] as Record<string, unknown>);
}

export async function getPlaygroundSession(id: string): Promise<PlaygroundSession | null> {
  const rows = await sql!`SELECT * FROM playground_sessions WHERE id = ${id} LIMIT 1`;
  const r = rows[0] as Record<string, unknown> | undefined;
  return r ? rowToPlaygroundSession(r) : null;
}

export async function listPlaygroundSessions(options?: PlaygroundSessionListOptions): Promise<PlaygroundSession[]> {
  const status = options?.status;
  const limit = options?.limit ?? 20;
  const offset = options?.offset ?? 0;
  let rows;
  if (status) {
    rows = await sql!`
      SELECT * FROM playground_sessions
      WHERE status = ${status}
      ORDER BY created_at DESC
      LIMIT ${limit} OFFSET ${offset}
    `;
  } else {
    rows = await sql!`
      SELECT * FROM playground_sessions
      ORDER BY created_at DESC
      LIMIT ${limit} OFFSET ${offset}
    `;
  }
  return (rows as Record<string, unknown>[]).map(rowToPlaygroundSession);
}

export async function updatePlaygroundSession(id: string, updates: UpdateSessionInput): Promise<boolean> {
  // Build COALESCE-based update to only update provided fields
  await sql!`
    UPDATE playground_sessions SET
      status = COALESCE(${updates.status ?? null}, status),
      participants = COALESCE(${updates.participants ? JSON.stringify(updates.participants) : null}::jsonb, participants),
      transcript = COALESCE(${updates.transcript ? JSON.stringify(updates.transcript) : null}::jsonb, transcript),
      current_round = COALESCE(${updates.currentRound ?? null}, current_round),
      current_round_prompt = COALESCE(${updates.currentRoundPrompt !== undefined ? updates.currentRoundPrompt : null}, current_round_prompt),
      round_deadline = COALESCE(${updates.roundDeadline !== undefined ? updates.roundDeadline : null}::timestamptz, round_deadline),
      summary = COALESCE(${updates.summary ?? null}, summary),
      started_at = COALESCE(${updates.startedAt ?? null}::timestamptz, started_at),
      completed_at = COALESCE(${updates.completedAt ?? null}::timestamptz, completed_at)
    WHERE id = ${id}
  `;
  return true;
}

export async function createPlaygroundAction(input: CreateActionInput): Promise<SessionAction> {
  const now = new Date().toISOString();
  await sql!`
    INSERT INTO playground_actions (id, session_id, agent_id, round, content, created_at)
    VALUES (${input.id}, ${input.sessionId}, ${input.agentId}, ${input.round}, ${input.content}, ${now})
  `;
  return {
    ...input,
    createdAt: now,
  };
}

export async function getPlaygroundActions(sessionId: string, round: number): Promise<SessionAction[]> {
  const rows = await sql!`
    SELECT * FROM playground_actions
    WHERE session_id = ${sessionId} AND round = ${round}
    ORDER BY created_at ASC
  `;
  return (rows as Record<string, unknown>[]).map(rowToSessionAction);
}
