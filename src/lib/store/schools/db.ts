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

// ==================== School Methods ====================

function rowToSchool(r: Record<string, unknown>): StoredSchool {
    return {
        id: r.id as string,
        name: r.name as string,
        description: r.description as string | undefined,
        subdomain: r.subdomain as string,
        status: r.status as 'active' | 'draft' | 'archived',
        access: r.access as 'vetted' | 'admitted',
        requiredEvaluations: (r.required_evaluations as string[]) ?? [],
        config: (r.config as Record<string, unknown>) ?? {},
        themeColor: r.theme_color as string | undefined,
        emoji: r.emoji as string | undefined,
        createdAt: r.created_at instanceof Date ? r.created_at.toISOString() : String(r.created_at),
        updatedAt: r.updated_at instanceof Date ? r.updated_at.toISOString() : String(r.updated_at),
    };
}

export async function getSchool(id: string): Promise<StoredSchool | null> {
    const rows = await sql!`SELECT * FROM schools WHERE id = ${id} LIMIT 1`;
    const r = rows[0] as Record<string, unknown> | undefined;
    return r ? rowToSchool(r) : null;
}

export async function getSchoolBySubdomain(subdomain: string): Promise<StoredSchool | null> {
    const rows = await sql!`SELECT * FROM schools WHERE subdomain = ${subdomain} LIMIT 1`;
    const r = rows[0] as Record<string, unknown> | undefined;
    return r ? rowToSchool(r) : null;
}

export async function listSchools(status?: 'active' | 'draft' | 'archived'): Promise<StoredSchool[]> {
    let rows;
    if (status) {
        rows = await sql!`SELECT * FROM schools WHERE status = ${status} ORDER BY created_at ASC`;
    } else {
        rows = await sql!`SELECT * FROM schools ORDER BY created_at ASC`;
    }
    return (rows as Record<string, unknown>[]).map(rowToSchool);
}

export async function createSchool(school: Omit<StoredSchool, 'createdAt' | 'updatedAt'>): Promise<StoredSchool> {
    const now = new Date().toISOString();
    await sql!`
        INSERT INTO schools (id, name, description, subdomain, status, access, required_evaluations, config, theme_color, emoji, created_at, updated_at)
        VALUES (${school.id}, ${school.name}, ${school.description ?? null}, ${school.subdomain}, ${school.status}, ${school.access}, ${JSON.stringify(school.requiredEvaluations)}::jsonb, ${JSON.stringify(school.config)}::jsonb, ${school.themeColor ?? null}, ${school.emoji ?? null}, ${now}, ${now})
    `;
    return { ...school, createdAt: now, updatedAt: now };
}

export async function updateSchool(
    id: string,
    updates: Partial<Pick<StoredSchool, 'name' | 'description' | 'status' | 'access' | 'requiredEvaluations' | 'config' | 'themeColor' | 'emoji'>>
): Promise<boolean> {
    const existing = await getSchool(id);
    if (!existing) return false;
    const now = new Date().toISOString();
    await sql!`
        UPDATE schools SET
            name = ${updates.name ?? existing.name},
            description = ${updates.description ?? existing.description ?? null},
            status = ${updates.status ?? existing.status},
            access = ${updates.access ?? existing.access},
            required_evaluations = ${JSON.stringify(updates.requiredEvaluations ?? existing.requiredEvaluations)}::jsonb,
            config = ${JSON.stringify(updates.config ?? existing.config)}::jsonb,
            theme_color = ${updates.themeColor ?? existing.themeColor ?? null},
            emoji = ${updates.emoji ?? existing.emoji ?? null},
            updated_at = ${now}
        WHERE id = ${id}
    `;
    return true;
}

export async function addSchoolProfessor(schoolId: string, professorId: string): Promise<boolean> {
    try {
        const now = new Date().toISOString();
        await sql!`
            INSERT INTO school_professors (school_id, professor_id, status, hired_at)
            VALUES (${schoolId}, ${professorId}, 'active', ${now})
            ON CONFLICT (school_id, professor_id) DO UPDATE SET status = 'active'
        `;
        return true;
    } catch {
        return false;
    }
}

export async function removeSchoolProfessor(schoolId: string, professorId: string): Promise<boolean> {
    try {
        await sql!`
            UPDATE school_professors SET status = 'inactive'
            WHERE school_id = ${schoolId} AND professor_id = ${professorId}
        `;
        return true;
    } catch {
        return false;
    }
}

export async function getSchoolProfessors(schoolId: string): Promise<StoredSchoolProfessor[]> {
    const rows = await sql!`
        SELECT school_id, professor_id, status, hired_at
        FROM school_professors
        WHERE school_id = ${schoolId} AND status = 'active'
    `;
    return (rows as Record<string, unknown>[]).map(r => ({
        schoolId: r.school_id as string,
        professorId: r.professor_id as string,
        status: r.status as 'active' | 'inactive',
        hiredAt: r.hired_at instanceof Date ? r.hired_at.toISOString() : String(r.hired_at),
    }));
}

export async function isSchoolProfessor(schoolId: string, professorId: string): Promise<boolean> {
    const rows = await sql!`
        SELECT 1 FROM school_professors
        WHERE school_id = ${schoolId} AND professor_id = ${professorId} AND status = 'active'
        LIMIT 1
    `;
    return rows.length > 0;
}
