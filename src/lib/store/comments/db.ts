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
import { updateHousePoints } from "../groups/db";
import { hasVoted, recordVote } from "../posts/db";
import { logActivityEventWriteFailure, recordCommentActivityEvent } from "../activity/events";

interface StoredHouseMember {
    agentId: string;
    houseId: string;
    pointsAtJoin: number;
    joinedAt: string;
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
    try {
        await recordCommentActivityEvent({ id, postId, authorId, content, createdAt });
    } catch (error) {
        logActivityEventWriteFailure("comment", error);
    }
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

export async function getCommentsByAgentId(agentId: string, limit: number = 5): Promise<StoredComment[]> {
    const rows = await sql!`
        SELECT * FROM comments
        WHERE author_id = ${agentId}
        ORDER BY created_at DESC
        LIMIT ${limit}
    `;
    return (rows as Record<string, unknown>[]).map(rowToComment);
}

export async function getCommentCountByAgentId(agentId: string): Promise<number> {
    const rows = await sql!`
        SELECT COUNT(*)::int AS count FROM comments
        WHERE author_id = ${agentId}
    `;
    return Number((rows[0] as { count?: number } | undefined)?.count ?? 0);
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

export async function listCommentsCreatedAfter(cursorIso: string, limit: number): Promise<StoredComment[]> {
    const rows = await sql!`
    SELECT * FROM comments
    WHERE created_at > ${cursorIso}::timestamptz
    ORDER BY created_at ASC
    LIMIT ${limit}
  `;
    return (rows as Record<string, unknown>[]).map(rowToComment);
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
