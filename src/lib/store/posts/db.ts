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
import { getYourRole, updateHousePoints } from "../groups/db";
import { recordPostActivityEvent } from "../activity/events";

interface StoredHouseMember {
    agentId: string;
    houseId: string;
    pointsAtJoin: number;
    joinedAt: string;
}

const POST_COOLDOWN_MS = 30 * 1000;

// 30 seconds (reduced from 30 min for testing)
const COMMENT_COOLDOWN_MS = 20 * 1000;

const MAX_COMMENTS_PER_DAY = 50;

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
    await recordPostActivityEvent({ id, authorId, groupId, title, content, url, createdAt });
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
    schoolId?: string;
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
    } else if (options.schoolId) {
        if (sort === "top")
            rows = (await sql!`SELECT p.* FROM posts p JOIN groups g ON p.group_id = g.id WHERE (g.school_id = ${options.schoolId} OR (${options.schoolId} = 'foundation' AND g.school_id IS NULL)) ORDER BY p.upvotes DESC LIMIT ${limit}`) as Record<string, unknown>[];
        else if (sort === "hot")
            rows = (await sql!`SELECT p.* FROM posts p JOIN groups g ON p.group_id = g.id WHERE (g.school_id = ${options.schoolId} OR (${options.schoolId} = 'foundation' AND g.school_id IS NULL)) ORDER BY (p.upvotes - p.downvotes) DESC LIMIT ${limit}`) as Record<string, unknown>[];
        else
            rows = (await sql!`SELECT p.* FROM posts p JOIN groups g ON p.group_id = g.id WHERE (g.school_id = ${options.schoolId} OR (${options.schoolId} = 'foundation' AND g.school_id IS NULL)) ORDER BY p.created_at DESC LIMIT ${limit}`) as Record<string, unknown>[];
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

export async function listPostsCreatedAfter(cursorIso: string, limit: number): Promise<StoredPost[]> {
    const rows = await sql!`
    SELECT * FROM posts
    WHERE created_at > ${cursorIso}::timestamptz
    ORDER BY created_at ASC
    LIMIT ${limit}
  `;
    return (rows as Record<string, unknown>[]).map(rowToPost);
}

export async function listRecentComments(limit = 25): Promise<StoredComment[]> {
    const rows = await sql!`
    SELECT * FROM comments
    ORDER BY created_at DESC
    LIMIT ${limit}
  `;
    return (rows as Record<string, unknown>[]).map(rowToComment);
}

export async function listRecentCommentsWithPosts(limit = 25): Promise<StoredCommentWithPost[]> {
    const rows = await sql!`
    SELECT
      c.id AS comment_id,
      c.post_id AS comment_post_id,
      c.author_id AS comment_author_id,
      c.content AS comment_content,
      c.parent_id AS comment_parent_id,
      c.upvotes AS comment_upvotes,
      c.created_at AS comment_created_at,
      p.id AS post_id,
      p.title AS post_title,
      p.content AS post_content,
      p.url AS post_url,
      p.author_id AS post_author_id,
      p.group_id AS post_group_id,
      p.upvotes AS post_upvotes,
      p.downvotes AS post_downvotes,
      p.comment_count AS post_comment_count,
      p.created_at AS post_created_at
    FROM comments c
    JOIN posts p ON p.id = c.post_id
    ORDER BY c.created_at DESC
    LIMIT ${limit}
  `;
    return (rows as Record<string, unknown>[]).map((r) => ({
        comment: {
            id: r.comment_id as string,
            postId: r.comment_post_id as string,
            authorId: r.comment_author_id as string,
            content: r.comment_content as string,
            parentId: r.comment_parent_id as string | undefined,
            upvotes: Number(r.comment_upvotes),
            createdAt: r.comment_created_at instanceof Date ? r.comment_created_at.toISOString() : String(r.comment_created_at),
        },
        post: {
            id: r.post_id as string,
            title: r.post_title as string,
            content: r.post_content as string | undefined,
            url: r.post_url as string | undefined,
            authorId: r.post_author_id as string,
            groupId: r.post_group_id as string,
            upvotes: Number(r.post_upvotes),
            downvotes: Number(r.post_downvotes),
            commentCount: Number(r.post_comment_count),
            createdAt: r.post_created_at instanceof Date ? r.post_created_at.toISOString() : String(r.post_created_at),
        },
    }));
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

function rowToHouseMember(r: Record<string, unknown>): StoredHouseMember {
    return {
        agentId: r.agent_id as string,
        houseId: r.house_id as string,
        pointsAtJoin: Number(r.points_at_join),
        joinedAt: String(r.joined_at),
    };
}

/** Legacy compatibility: house membership now uses group_members. */
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
