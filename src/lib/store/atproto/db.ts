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

// --- AT Protocol identity ---

function rowToAtprotoIdentity(r: Record<string, unknown>): AtprotoIdentity {
    return {
        agentId: (r.agent_id as string) ?? null,
        handle: r.handle as string,
        signingKeyPrivate: r.signing_key_private as string,
        publicKeyMultibase: r.public_key_multibase as string,
        createdAt: r.created_at instanceof Date ? r.created_at.toISOString() : String(r.created_at),
    };
}

export async function getAtprotoIdentityByHandle(handle: string): Promise<AtprotoIdentity | null> {
    const rows = await sql!`SELECT * FROM atproto_identities WHERE handle = ${handle} LIMIT 1`;
    const r = rows[0] as Record<string, unknown> | undefined;
    return r ? rowToAtprotoIdentity(r) : null;
}

export async function getAtprotoIdentityByAgentId(agentId: string): Promise<AtprotoIdentity | null> {
    const rows = await sql!`SELECT * FROM atproto_identities WHERE agent_id = ${agentId} LIMIT 1`;
    const r = rows[0] as Record<string, unknown> | undefined;
    return r ? rowToAtprotoIdentity(r) : null;
}

export async function createAtprotoIdentity(
    agentId: string | null,
    handle: string,
    signingKeyPrivate: string,
    publicKeyMultibase: string
): Promise<AtprotoIdentity> {
    const createdAt = new Date().toISOString();
    await sql!`
        INSERT INTO atproto_identities (agent_id, handle, signing_key_private, public_key_multibase, created_at)
        VALUES (${agentId}, ${handle}, ${signingKeyPrivate}, ${publicKeyMultibase}, ${createdAt})
    `;
    return {
        agentId,
        handle,
        signingKeyPrivate,
        publicKeyMultibase,
        createdAt,
    };
}

export async function ensureNetworkAtprotoIdentity(
    signingKeyPrivate: string,
    publicKeyMultibase: string
): Promise<AtprotoIdentity> {
    const existing = await getAtprotoIdentityByHandle("network.safemolt.com");
    if (existing) return existing;
    return createAtprotoIdentity(null, "network.safemolt.com", signingKeyPrivate, publicKeyMultibase);
}

export async function listAtprotoHandles(): Promise<string[]> {
    const rows = await sql!`SELECT handle FROM atproto_identities ORDER BY handle`;
    return (rows as { handle: string }[]).map((r) => r.handle);
}

// --- AT Protocol blob methods ---

function rowToAtprotoBlob(r: Record<string, unknown>): AtprotoBlob {
    return {
        agentId: r.agent_id as string,
        cid: r.cid as string,
        mimeType: r.mime_type as string,
        size: Number(r.size),
        sourceUrl: r.source_url as string,
        createdAt: r.created_at instanceof Date ? r.created_at.toISOString() : String(r.created_at),
    };
}

export async function getAtprotoBlobsByAgent(agentId: string): Promise<AtprotoBlob[]> {
    const rows = await sql!`SELECT * FROM atproto_blobs WHERE agent_id = ${agentId}`;
    return (rows as Record<string, unknown>[]).map(rowToAtprotoBlob);
}

export async function getAtprotoBlobByCid(agentId: string, cid: string): Promise<AtprotoBlob | null> {
    const rows = await sql!`SELECT * FROM atproto_blobs WHERE agent_id = ${agentId} AND cid = ${cid} LIMIT 1`;
    const r = rows[0] as Record<string, unknown> | undefined;
    return r ? rowToAtprotoBlob(r) : null;
}

export async function upsertAtprotoBlob(
    agentId: string,
    cid: string,
    mimeType: string,
    size: number,
    sourceUrl: string
): Promise<AtprotoBlob> {
    const createdAt = new Date().toISOString();
    await sql!`
        INSERT INTO atproto_blobs (agent_id, cid, mime_type, size, source_url, created_at)
        VALUES (${agentId}, ${cid}, ${mimeType}, ${size}, ${sourceUrl}, ${createdAt})
        ON CONFLICT (agent_id, cid) DO UPDATE SET
            mime_type = EXCLUDED.mime_type,
            size = EXCLUDED.size,
            source_url = EXCLUDED.source_url
    `;
    return { agentId, cid, mimeType, size, sourceUrl, createdAt };
}
