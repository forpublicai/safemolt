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

// ==================== Classes System ====================

function generateClassId(prefix: string): string {
    return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 9)}`;
}

// --- Professors ---

export async function createProfessor(
    name: string,
    email: string | undefined,
    apiKey: string,
    id?: string
): Promise<StoredProfessor> {
    const profId = id || generateClassId('prof');
    const createdAt = new Date().toISOString();
    await sql!`
        INSERT INTO professors (id, name, email, api_key, created_at)
        VALUES (${profId}, ${name}, ${email ?? null}, ${apiKey}, ${createdAt})
        ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name
    `;
    return { id: profId, name, email, apiKey, createdAt };
}

export async function getProfessorByApiKey(apiKey: string): Promise<StoredProfessor | null> {
    const rows = await sql!`SELECT id, name, email, api_key, created_at FROM professors WHERE api_key = ${apiKey} LIMIT 1`;
    const r = rows[0] as Record<string, unknown> | undefined;
    if (!r) return null;
    return {
        id: r.id as string,
        name: r.name as string,
        email: r.email as string | undefined,
        apiKey: r.api_key as string,
        createdAt: String(r.created_at),
    };
}

export async function getProfessorById(id: string): Promise<StoredProfessor | null> {
    const rows = await sql!`SELECT id, name, email, api_key, created_at FROM professors WHERE id = ${id} LIMIT 1`;
    const r = rows[0] as Record<string, unknown> | undefined;
    if (!r) return null;
    return {
        id: r.id as string,
        name: r.name as string,
        email: r.email as string | undefined,
        apiKey: r.api_key as string,
        createdAt: String(r.created_at),
    };
}

export async function getProfessorByHumanUserId(humanUserId: string): Promise<StoredProfessor | null> {
    const rows = await sql!`SELECT id, name, email, api_key, created_at FROM professors WHERE human_user_id = ${humanUserId} LIMIT 1`;
    const r = rows[0] as Record<string, unknown> | undefined;
    if (!r) return null;
    return {
        id: r.id as string,
        name: r.name as string,
        email: r.email as string | undefined,
        apiKey: r.api_key as string,
        createdAt: String(r.created_at),
    };
}

export async function listAllProfessors(): Promise<Array<StoredProfessor & { humanUserId?: string }>> {
    const rows = await sql!`SELECT id, name, email, api_key, created_at, human_user_id FROM professors ORDER BY created_at DESC`;
    return (rows as Record<string, unknown>[]).map((r) => ({
        id: r.id as string,
        name: r.name as string,
        email: r.email as string | undefined,
        apiKey: r.api_key as string,
        createdAt: String(r.created_at),
        humanUserId: r.human_user_id as string | undefined,
    }));
}

export async function createProfessorForHumanUser(
    humanUserId: string,
    name: string,
    email?: string,
): Promise<StoredProfessor> {
    const profId = generateClassId('prof');
    const apiKey = `prof_${Array.from(
        { length: 24 },
        () => Math.random().toString(36)[2] ?? '0'
    ).join('')}`;
    const createdAt = new Date().toISOString();
    await sql!`
        INSERT INTO professors (id, name, email, api_key, created_at, human_user_id)
        VALUES (${profId}, ${name}, ${email ?? null}, ${apiKey}, ${createdAt}, ${humanUserId})
    `;
    return { id: profId, name, email, apiKey, createdAt };
}

export async function linkProfessorToHumanUser(professorId: string, humanUserId: string): Promise<boolean> {
    await sql!`UPDATE professors SET human_user_id = ${humanUserId} WHERE id = ${professorId}`;
    return true;
}

// --- Classes ---

function mapClassRow(r: Record<string, unknown>): StoredClass {
    return {
        id: r.id as string,
        slug: (r.slug as string | undefined) ?? String(r.id),
        professorId: r.professor_id as string,
        name: r.name as string,
        description: r.description as string | undefined,
        syllabus: r.syllabus as Record<string, unknown> | undefined,
        status: r.status as StoredClass['status'],
        enrollmentOpen: Boolean(r.enrollment_open),
        maxStudents: r.max_students != null ? Number(r.max_students) : undefined,
        hiddenObjective: r.hidden_objective as string | undefined,
        createdAt: String(r.created_at),
        startedAt: r.started_at ? String(r.started_at) : undefined,
        endedAt: r.ended_at ? String(r.ended_at) : undefined,
    };
}

function slugifyClassName(name: string): string {
    const normalized = name
        .toLowerCase()
        .trim()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "");
    return normalized || "class";
}

async function generateUniqueClassSlug(name: string, excludeId?: string): Promise<string> {
    const base = slugifyClassName(name);
    let candidate = base;
    let i = 2;
    while (true) {
        const rows = excludeId
            ? await sql!`SELECT id FROM classes WHERE slug = ${candidate} AND id != ${excludeId} LIMIT 1`
            : await sql!`SELECT id FROM classes WHERE slug = ${candidate} LIMIT 1`;
        if (!rows.length) return candidate;
        candidate = `${base}-${i}`;
        i++;
    }
}

export async function getClassBySlug(slug: string): Promise<StoredClass | null> {
    const rows = await sql!`SELECT * FROM classes WHERE slug = ${slug} LIMIT 1`;
    const r = rows[0] as Record<string, unknown> | undefined;
    if (!r) return null;
    return mapClassRow(r);
}

export async function getClassBySlugAlias(alias: string): Promise<StoredClass | null> {
    const rows = await sql!`
        SELECT c.*
        FROM class_slug_aliases a
        JOIN classes c ON c.id = a.class_id
        WHERE a.old_slug = ${alias}
        LIMIT 1
    `;
    const r = rows[0] as Record<string, unknown> | undefined;
    if (!r) return null;
    return mapClassRow(r);
}

async function resolveClassId(identifier: string): Promise<string | null> {
    const direct = await sql!`SELECT id FROM classes WHERE id = ${identifier} LIMIT 1`;
    if (direct.length > 0) {
        return String((direct[0] as Record<string, unknown>).id);
    }

    const bySlug = await sql!`SELECT id FROM classes WHERE slug = ${identifier} LIMIT 1`;
    if (bySlug.length > 0) {
        return String((bySlug[0] as Record<string, unknown>).id);
    }

    const byAlias = await sql!`
        SELECT class_id FROM class_slug_aliases WHERE old_slug = ${identifier} LIMIT 1
    `;
    if (byAlias.length > 0) {
        return String((byAlias[0] as Record<string, unknown>).class_id);
    }

    return null;
}

export async function createClass(
    professorId: string,
    name: string,
    description?: string,
    syllabus?: Record<string, unknown>,
    hiddenObjective?: string,
    maxStudents?: number,
    schoolId = 'foundation',
    id?: string,
    slug?: string
): Promise<StoredClass> {
    const classId = id || randomUUID();
    const classSlug = await generateUniqueClassSlug(slug ?? name, classId);
    const createdAt = new Date().toISOString();
    await sql!`
        INSERT INTO classes (id, slug, professor_id, name, description, syllabus, hidden_objective, max_students, created_at, school_id)
        VALUES (${classId}, ${classSlug}, ${professorId}, ${name}, ${description ?? null},
                ${syllabus ? JSON.stringify(syllabus) : null},
                ${hiddenObjective ?? null}, ${maxStudents ?? null}, ${createdAt}, ${schoolId})
        ON CONFLICT (id) DO UPDATE SET 
            slug = EXCLUDED.slug,
            name = EXCLUDED.name, 
            description = EXCLUDED.description,
            syllabus = EXCLUDED.syllabus,
            hidden_objective = EXCLUDED.hidden_objective,
            max_students = EXCLUDED.max_students
    `;
    return {
        id: classId, slug: classSlug, professorId, name, description, syllabus, hiddenObjective, maxStudents,
        status: 'draft', enrollmentOpen: false, createdAt,
    };
}

export async function getClassById(id: string): Promise<StoredClass | null> {
    const resolvedId = await resolveClassId(id);
    if (!resolvedId) return null;
    const rows = await sql!`SELECT * FROM classes WHERE id = ${resolvedId} LIMIT 1`;
    const r = rows[0] as Record<string, unknown> | undefined;
    if (!r) return null;
    return mapClassRow(r);
}

export async function listClasses(options?: {
    professorId?: string;
    status?: string;
    enrollmentOpen?: boolean;
    schoolId?: string;
    limit?: number;
}): Promise<StoredClass[]> {
    let rows;
    if (options?.schoolId) {
        if (options?.professorId) {
            rows = await sql!`SELECT * FROM classes WHERE professor_id = ${options.professorId} AND school_id = ${options.schoolId} ORDER BY created_at DESC`;
        } else if (options?.enrollmentOpen) {
            rows = await sql!`SELECT * FROM classes WHERE enrollment_open = true AND status = 'active' AND school_id = ${options.schoolId} ORDER BY created_at DESC`;
        } else if (options?.status) {
            rows = await sql!`SELECT * FROM classes WHERE status = ${options.status} AND school_id = ${options.schoolId} ORDER BY created_at DESC`;
        } else {
            rows = await sql!`SELECT * FROM classes WHERE school_id = ${options.schoolId} ORDER BY created_at DESC`;
        }
    } else {
        if (options?.professorId) {
            rows = await sql!`SELECT * FROM classes WHERE professor_id = ${options.professorId} ORDER BY created_at DESC`;
        } else if (options?.enrollmentOpen) {
            rows = await sql!`SELECT * FROM classes WHERE enrollment_open = true AND status = 'active' ORDER BY created_at DESC`;
        } else if (options?.status) {
            rows = await sql!`SELECT * FROM classes WHERE status = ${options.status} ORDER BY created_at DESC`;
        } else {
            rows = await sql!`SELECT * FROM classes ORDER BY created_at DESC`;
        }
    }
    const classes = (rows as Array<Record<string, unknown>>).map(mapClassRow);
    const limit = options?.limit ? Math.max(1, Math.floor(options.limit)) : undefined;
    return limit ? classes.slice(0, limit) : classes;
}

export async function updateClass(
    id: string,
    updates: Partial<Pick<StoredClass, 'name' | 'slug' | 'description' | 'syllabus' | 'status' | 'enrollmentOpen' | 'maxStudents' | 'hiddenObjective' | 'startedAt' | 'endedAt' | 'professorId'>>
): Promise<boolean> {
    const resolvedId = await resolveClassId(id);
    if (!resolvedId) return false;

    // Individual updates since neon tagged template doesn't support dynamic column names
    if (updates.name !== undefined) {
        await sql!`UPDATE classes SET name = ${updates.name} WHERE id = ${resolvedId}`;
        const nextSlug = await generateUniqueClassSlug(updates.slug ?? updates.name, resolvedId);
        await sql!`UPDATE classes SET slug = ${nextSlug} WHERE id = ${resolvedId}`;
    } else if (updates.slug !== undefined) {
        const nextSlug = await generateUniqueClassSlug(updates.slug, resolvedId);
        await sql!`UPDATE classes SET slug = ${nextSlug} WHERE id = ${resolvedId}`;
    }
    if (updates.description !== undefined) await sql!`UPDATE classes SET description = ${updates.description} WHERE id = ${resolvedId}`;
    if (updates.syllabus !== undefined) await sql!`UPDATE classes SET syllabus = ${JSON.stringify(updates.syllabus)} WHERE id = ${resolvedId}`;
    if (updates.professorId !== undefined) await sql!`UPDATE classes SET professor_id = ${updates.professorId} WHERE id = ${resolvedId}`;
    if (updates.status !== undefined) await sql!`UPDATE classes SET status = ${updates.status} WHERE id = ${resolvedId}`;
    if (updates.enrollmentOpen !== undefined) await sql!`UPDATE classes SET enrollment_open = ${updates.enrollmentOpen} WHERE id = ${resolvedId}`;
    if (updates.maxStudents !== undefined) await sql!`UPDATE classes SET max_students = ${updates.maxStudents} WHERE id = ${resolvedId}`;
    if (updates.hiddenObjective !== undefined) await sql!`UPDATE classes SET hidden_objective = ${updates.hiddenObjective} WHERE id = ${resolvedId}`;
    if (updates.startedAt !== undefined) await sql!`UPDATE classes SET started_at = ${updates.startedAt} WHERE id = ${resolvedId}`;
    if (updates.endedAt !== undefined) await sql!`UPDATE classes SET ended_at = ${updates.endedAt} WHERE id = ${resolvedId}`;
    return true;
}

// --- Class Assistants ---

export async function addClassAssistant(classId: string, agentId: string): Promise<StoredClassAssistant> {
    const resolvedClassId = await resolveClassId(classId);
    if (!resolvedClassId) throw new Error("Class not found");
    const assignedAt = new Date().toISOString();
    await sql!`
        INSERT INTO class_assistants (class_id, agent_id, assigned_at)
        VALUES (${resolvedClassId}, ${agentId}, ${assignedAt})
        ON CONFLICT (class_id, agent_id) DO NOTHING
    `;
    return { classId: resolvedClassId, agentId, assignedAt };
}

export async function removeClassAssistant(classId: string, agentId: string): Promise<boolean> {
    const resolvedClassId = await resolveClassId(classId);
    if (!resolvedClassId) return false;
    const result = await sql!`DELETE FROM class_assistants WHERE class_id = ${resolvedClassId} AND agent_id = ${agentId}`;
    return (result as unknown as { count: number }).count > 0;
}

export async function getClassAssistants(classId: string): Promise<Array<{ agentId: string; assignedAt: string }>> {
    const resolvedClassId = await resolveClassId(classId);
    if (!resolvedClassId) return [];
    const rows = await sql!`SELECT agent_id, assigned_at FROM class_assistants WHERE class_id = ${resolvedClassId} ORDER BY assigned_at ASC`;
    return (rows as Array<Record<string, unknown>>).map(r => ({
        agentId: r.agent_id as string,
        assignedAt: String(r.assigned_at),
    }));
}

export async function isClassAssistant(classId: string, agentId: string): Promise<boolean> {
    const resolvedClassId = await resolveClassId(classId);
    if (!resolvedClassId) return false;
    const rows = await sql!`SELECT 1 FROM class_assistants WHERE class_id = ${resolvedClassId} AND agent_id = ${agentId} LIMIT 1`;
    return Array.isArray(rows) && rows.length > 0;
}

// --- Class Enrollments ---

export async function enrollInClass(classId: string, agentId: string): Promise<StoredClassEnrollment> {
    const resolvedClassId = await resolveClassId(classId);
    if (!resolvedClassId) throw new Error("Class not found");
    const id = generateClassId('enrl');
    const enrolledAt = new Date().toISOString();
    await sql!`
        INSERT INTO class_enrollments (id, class_id, agent_id, status, enrolled_at)
        VALUES (${id}, ${resolvedClassId}, ${agentId}, 'enrolled', ${enrolledAt})
    `;
    return { id, classId: resolvedClassId, agentId, status: 'enrolled', enrolledAt };
}

export async function dropClass(classId: string, agentId: string): Promise<boolean> {
    const resolvedClassId = await resolveClassId(classId);
    if (!resolvedClassId) return false;
    const result = await sql!`
        UPDATE class_enrollments SET status = 'dropped'
        WHERE class_id = ${resolvedClassId} AND agent_id = ${agentId} AND status IN ('enrolled', 'active')
    `;
    return (result as unknown as { count: number }).count > 0;
}

export async function getClassEnrollment(classId: string, agentId: string): Promise<StoredClassEnrollment | null> {
    const resolvedClassId = await resolveClassId(classId);
    if (!resolvedClassId) return null;
    const rows = await sql!`
        SELECT id, class_id, agent_id, status, enrolled_at, completed_at
        FROM class_enrollments WHERE class_id = ${resolvedClassId} AND agent_id = ${agentId} LIMIT 1
    `;
    const r = rows[0] as Record<string, unknown> | undefined;
    if (!r) return null;
    return {
        id: r.id as string,
        classId: r.class_id as string,
        agentId: r.agent_id as string,
        status: r.status as StoredClassEnrollment['status'],
        enrolledAt: String(r.enrolled_at),
        completedAt: r.completed_at ? String(r.completed_at) : undefined,
    };
}

export async function getClassEnrollments(classId: string): Promise<StoredClassEnrollment[]> {
    const resolvedClassId = await resolveClassId(classId);
    if (!resolvedClassId) return [];
    const rows = await sql!`
        SELECT id, class_id, agent_id, status, enrolled_at, completed_at
        FROM class_enrollments WHERE class_id = ${resolvedClassId} ORDER BY enrolled_at ASC
    `;
    return (rows as Array<Record<string, unknown>>).map(r => ({
        id: r.id as string,
        classId: r.class_id as string,
        agentId: r.agent_id as string,
        status: r.status as StoredClassEnrollment['status'],
        enrolledAt: String(r.enrolled_at),
        completedAt: r.completed_at ? String(r.completed_at) : undefined,
    }));
}

export async function getClassEnrollmentCount(classId: string): Promise<number> {
    const resolvedClassId = await resolveClassId(classId);
    if (!resolvedClassId) return 0;
    const rows = await sql!`
        SELECT COUNT(*)::int AS count FROM class_enrollments
        WHERE class_id = ${resolvedClassId} AND status IN ('enrolled', 'active')
    `;
    return Number((rows[0] as Record<string, unknown>)?.count ?? 0);
}

export async function getAgentClasses(agentId: string): Promise<Array<{ classId: string; status: string; enrolledAt: string }>> {
    const rows = await sql!`
        SELECT class_id, status, enrolled_at FROM class_enrollments
        WHERE agent_id = ${agentId} AND status != 'dropped'
        ORDER BY enrolled_at DESC
    `;
    return (rows as Array<Record<string, unknown>>).map(r => ({
        classId: r.class_id as string,
        status: r.status as string,
        enrolledAt: String(r.enrolled_at),
    }));
}

// --- Class Sessions ---

export async function createClassSession(
    classId: string,
    title: string,
    type: StoredClassSession['type'],
    content: string | undefined,
    sequence: number
): Promise<StoredClassSession> {
    const resolvedClassId = await resolveClassId(classId);
    if (!resolvedClassId) throw new Error("Class not found");
    const id = generateClassId('csess');
    const createdAt = new Date().toISOString();
    await sql!`
        INSERT INTO class_sessions (id, class_id, title, type, content, sequence, status, created_at)
        VALUES (${id}, ${resolvedClassId}, ${title}, ${type}, ${content ?? null}, ${sequence}, 'scheduled', ${createdAt})
    `;
    return { id, classId: resolvedClassId, title, type, content, sequence, status: 'scheduled', createdAt };
}

export async function getClassSession(sessionId: string): Promise<StoredClassSession | null> {
    const rows = await sql!`SELECT * FROM class_sessions WHERE id = ${sessionId} LIMIT 1`;
    const r = rows[0] as Record<string, unknown> | undefined;
    if (!r) return null;
    return {
        id: r.id as string,
        classId: r.class_id as string,
        title: r.title as string,
        type: r.type as StoredClassSession['type'],
        content: r.content as string | undefined,
        sequence: Number(r.sequence),
        status: r.status as StoredClassSession['status'],
        startedAt: r.started_at ? String(r.started_at) : undefined,
        endedAt: r.ended_at ? String(r.ended_at) : undefined,
        createdAt: String(r.created_at),
    };
}

export async function listClassSessions(classId: string): Promise<StoredClassSession[]> {
    const resolvedClassId = await resolveClassId(classId);
    if (!resolvedClassId) return [];
    const rows = await sql!`SELECT * FROM class_sessions WHERE class_id = ${resolvedClassId} ORDER BY sequence ASC`;
    return (rows as Array<Record<string, unknown>>).map(r => ({
        id: r.id as string,
        classId: r.class_id as string,
        title: r.title as string,
        type: r.type as StoredClassSession['type'],
        content: r.content as string | undefined,
        sequence: Number(r.sequence),
        status: r.status as StoredClassSession['status'],
        startedAt: r.started_at ? String(r.started_at) : undefined,
        endedAt: r.ended_at ? String(r.ended_at) : undefined,
        createdAt: String(r.created_at),
    }));
}

export async function updateClassSession(
    sessionId: string,
    updates: Partial<Pick<StoredClassSession, 'status' | 'startedAt' | 'endedAt' | 'content' | 'title'>>
): Promise<boolean> {
    if (updates.status === 'active') {
        await sql!`UPDATE class_sessions SET status = 'active', started_at = NOW() WHERE id = ${sessionId}`;
    } else if (updates.status === 'completed') {
        await sql!`UPDATE class_sessions SET status = 'completed', ended_at = NOW() WHERE id = ${sessionId}`;
    } else if (updates.content !== undefined) {
        await sql!`UPDATE class_sessions SET content = ${updates.content} WHERE id = ${sessionId}`;
    } else if (updates.title !== undefined) {
        await sql!`UPDATE class_sessions SET title = ${updates.title} WHERE id = ${sessionId}`;
    }
    return true;
}

// --- Class Session Messages ---

export async function addClassSessionMessage(
    sessionId: string,
    senderId: string,
    senderRole: StoredClassSessionMessage['senderRole'],
    content: string
): Promise<StoredClassSessionMessage> {
    const id = generateClassId('cmsg');
    const createdAt = new Date().toISOString();
    const seqResult = await sql!`
        INSERT INTO class_session_messages (id, session_id, sender_id, sender_role, content, created_at, sequence)
        SELECT ${id}, ${sessionId}, ${senderId}, ${senderRole}, ${content}, ${createdAt},
            COALESCE((SELECT MAX(sequence) + 1 FROM class_session_messages WHERE session_id = ${sessionId}), 1)
        RETURNING sequence, created_at
    `;
    const row = (seqResult as Array<Record<string, unknown>>)[0];
    return {
        id,
        sessionId,
        senderId,
        senderRole,
        content,
        sequence: Number(row?.sequence ?? 1),
        createdAt: row?.created_at ? String(row.created_at) : createdAt,
    };
}

export async function getClassSessionMessages(sessionId: string): Promise<StoredClassSessionMessage[]> {
    const rows = await sql!`
        SELECT m.id, m.session_id, m.sender_id, m.sender_role, m.content, m.sequence, m.created_at,
               COALESCE(a.name, p.name) AS sender_name
        FROM class_session_messages m
        LEFT JOIN agents a ON m.sender_id = a.id
        LEFT JOIN professors p ON m.sender_id = p.id
        WHERE m.session_id = ${sessionId}
        ORDER BY m.sequence ASC
    `;
    return (rows as Array<Record<string, unknown>>).map(r => ({
        id: r.id as string,
        sessionId: r.session_id as string,
        senderId: r.sender_id as string,
        senderName: r.sender_name as string | undefined,
        senderRole: r.sender_role as StoredClassSessionMessage['senderRole'],
        content: r.content as string,
        sequence: Number(r.sequence),
        createdAt: String(r.created_at),
    }));
}

// --- Class Evaluations ---

export async function createClassEvaluation(
    classId: string,
    title: string,
    prompt: string,
    description?: string,
    taughtTopic?: string,
    maxScore?: number
): Promise<StoredClassEvaluation> {
    const resolvedClassId = await resolveClassId(classId);
    if (!resolvedClassId) throw new Error("Class not found");
    const id = generateClassId('ceval');
    const createdAt = new Date().toISOString();
    await sql!`
        INSERT INTO class_evaluations (id, class_id, title, description, prompt, taught_topic, max_score, created_at)
        VALUES (${id}, ${resolvedClassId}, ${title}, ${description ?? null}, ${prompt},
                ${taughtTopic ?? null}, ${maxScore ?? null}, ${createdAt})
    `;
    return { id, classId: resolvedClassId, title, description, prompt, taughtTopic, status: 'draft', maxScore, createdAt };
}

export async function getClassEvaluation(evaluationId: string): Promise<StoredClassEvaluation | null> {
    const rows = await sql!`SELECT * FROM class_evaluations WHERE id = ${evaluationId} LIMIT 1`;
    const r = rows[0] as Record<string, unknown> | undefined;
    if (!r) return null;
    return {
        id: r.id as string,
        classId: r.class_id as string,
        title: r.title as string,
        description: r.description as string | undefined,
        prompt: r.prompt as string,
        taughtTopic: r.taught_topic as string | undefined,
        status: r.status as StoredClassEvaluation['status'],
        maxScore: r.max_score != null ? Number(r.max_score) : undefined,
        createdAt: String(r.created_at),
    };
}

export async function listClassEvaluations(classId: string): Promise<StoredClassEvaluation[]> {
    const resolvedClassId = await resolveClassId(classId);
    if (!resolvedClassId) return [];
    const rows = await sql!`SELECT * FROM class_evaluations WHERE class_id = ${resolvedClassId} ORDER BY created_at ASC`;
    return (rows as Array<Record<string, unknown>>).map(r => ({
        id: r.id as string,
        classId: r.class_id as string,
        title: r.title as string,
        description: r.description as string | undefined,
        prompt: r.prompt as string,
        taughtTopic: r.taught_topic as string | undefined,
        status: r.status as StoredClassEvaluation['status'],
        maxScore: r.max_score != null ? Number(r.max_score) : undefined,
        createdAt: String(r.created_at),
    }));
}

export async function updateClassEvaluation(
    evaluationId: string,
    updates: Partial<Pick<StoredClassEvaluation, 'title' | 'description' | 'prompt' | 'taughtTopic' | 'status' | 'maxScore'>>
): Promise<boolean> {
    if (updates.status !== undefined) {
        await sql!`UPDATE class_evaluations SET status = ${updates.status} WHERE id = ${evaluationId}`;
    }
    if (updates.title !== undefined) {
        await sql!`UPDATE class_evaluations SET title = ${updates.title} WHERE id = ${evaluationId}`;
    }
    if (updates.prompt !== undefined) {
        await sql!`UPDATE class_evaluations SET prompt = ${updates.prompt} WHERE id = ${evaluationId}`;
    }
    if (updates.taughtTopic !== undefined) {
        await sql!`UPDATE class_evaluations SET taught_topic = ${updates.taughtTopic} WHERE id = ${evaluationId}`;
    }
    if (updates.maxScore !== undefined) {
        await sql!`UPDATE class_evaluations SET max_score = ${updates.maxScore} WHERE id = ${evaluationId}`;
    }
    return true;
}

// --- Class Evaluation Results ---

export async function saveClassEvaluationResult(
    evaluationId: string,
    agentId: string,
    response?: string,
    score?: number,
    maxScore?: number,
    resultData?: Record<string, unknown>,
    feedback?: string
): Promise<StoredClassEvaluationResult> {
    const id = generateClassId('cres');
    const completedAt = new Date().toISOString();
    await sql!`
        INSERT INTO class_evaluation_results (id, evaluation_id, agent_id, response, score, max_score, result_data, feedback, completed_at)
        VALUES (${id}, ${evaluationId}, ${agentId}, ${response ?? null},
                ${score ?? null}, ${maxScore ?? null},
                ${resultData ? JSON.stringify(resultData) : null},
                ${feedback ?? null}, ${completedAt})
        ON CONFLICT (evaluation_id, agent_id) DO UPDATE SET
            response = EXCLUDED.response,
            score = EXCLUDED.score,
            max_score = EXCLUDED.max_score,
            result_data = EXCLUDED.result_data,
            feedback = EXCLUDED.feedback,
            completed_at = EXCLUDED.completed_at
    `;
    return { id, evaluationId, agentId, response, score, maxScore, resultData, feedback, completedAt };
}

export async function getClassEvaluationResults(evaluationId: string): Promise<StoredClassEvaluationResult[]> {
    const rows = await sql!`
        SELECT r.id, r.evaluation_id, r.agent_id, r.response, r.score, r.max_score, r.result_data, r.feedback, r.completed_at, a.name as agent_name
        FROM class_evaluation_results r
        LEFT JOIN agents a ON a.id = r.agent_id
        WHERE r.evaluation_id = ${evaluationId}
        ORDER BY r.completed_at ASC
    `;
    return (rows as Array<Record<string, unknown>>).map(r => ({
        id: r.id as string,
        evaluationId: r.evaluation_id as string,
        agentId: r.agent_id as string,
        agentName: r.agent_name as string | undefined,
        response: r.response as string | undefined,
        score: r.score != null ? Number(r.score) : undefined,
        maxScore: r.max_score != null ? Number(r.max_score) : undefined,
        resultData: r.result_data as Record<string, unknown> | undefined,
        feedback: r.feedback as string | undefined,
        completedAt: String(r.completed_at),
    }));
}

export async function getStudentClassResults(classId: string, agentId: string): Promise<StoredClassEvaluationResult[]> {
    const resolvedClassId = await resolveClassId(classId);
    if (!resolvedClassId) return [];
    const rows = await sql!`
        SELECT r.id, r.evaluation_id, r.agent_id, r.response, r.score, r.max_score,
               r.result_data, r.feedback, r.completed_at, a.name as agent_name
        FROM class_evaluation_results r
        JOIN class_evaluations e ON e.id = r.evaluation_id
        LEFT JOIN agents a ON a.id = r.agent_id
        WHERE e.class_id = ${resolvedClassId} AND r.agent_id = ${agentId}
        ORDER BY r.completed_at ASC
    `;
    return (rows as Array<Record<string, unknown>>).map(r => ({
        id: r.id as string,
        evaluationId: r.evaluation_id as string,
        agentId: r.agent_id as string,
        agentName: r.agent_name as string | undefined,
        response: r.response as string | undefined,
        score: r.score != null ? Number(r.score) : undefined,
        maxScore: r.max_score != null ? Number(r.max_score) : undefined,
        resultData: r.result_data as Record<string, unknown> | undefined,
        feedback: r.feedback as string | undefined,
        completedAt: String(r.completed_at),
    }));
}
