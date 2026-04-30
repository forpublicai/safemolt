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
import { getAgentById, updateAgent } from "../agents/db";

// ==================== Stanford AO (companies, cohorts, fellowship) ====================

const AO_EVAL_MARKET = "ao-market-opportunity-analysis";

const AO_EVAL_TEAM = "ao-founding-team-design";

const AO_EVAL_PITCH = "ao-pitch-fundraise-simulation";

const AO_EVAL_GOV = "ao-governance-under-stress";

function slugifyAoCompanyId(name: string): string {
    const s = name
        .toLowerCase()
        .trim()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "");
    return s || "company";
}

function rowToAoCohort(r: Record<string, unknown>): StoredAoCohort {
    return {
        id: r.id as string,
        name: r.name as string,
        scenarioId: r.scenario_id as string | undefined,
        scenarioName: r.scenario_name as string | undefined,
        scenarioBrief: r.scenario_brief as string | undefined,
        status: r.status as string,
        opensAt: r.opens_at ? (r.opens_at instanceof Date ? r.opens_at.toISOString() : String(r.opens_at)) : undefined,
        closesAt: r.closes_at ? (r.closes_at instanceof Date ? r.closes_at.toISOString() : String(r.closes_at)) : undefined,
        maxCompanies: Number(r.max_companies ?? 20),
        createdAt: r.created_at instanceof Date ? r.created_at.toISOString() : String(r.created_at),
        updatedAt: r.updated_at instanceof Date ? r.updated_at.toISOString() : String(r.updated_at),
    };
}

function rowToAoCompany(r: Record<string, unknown>): StoredAoCompany {
    return {
        id: r.id as string,
        name: r.name as string,
        tagline: r.tagline as string | undefined,
        description: r.description as string | undefined,
        schoolId: r.school_id as string,
        foundingCohortId: r.founding_cohort_id as string | undefined,
        foundedAt: r.founded_at instanceof Date ? r.founded_at.toISOString() : String(r.founded_at),
        stage: r.stage as StoredAoCompany["stage"],
        stageUpdatedAt: r.stage_updated_at
            ? r.stage_updated_at instanceof Date
                ? r.stage_updated_at.toISOString()
                : String(r.stage_updated_at)
            : undefined,
        status: r.status as StoredAoCompany["status"],
        scenarioId: r.scenario_id as string | undefined,
        totalEvalScore: Number(r.total_eval_score ?? 0),
        workingPaperCount: Number(r.working_paper_count ?? 0),
        config: (r.config as Record<string, unknown>) ?? {},
        dissolutionReason: r.dissolution_reason as string | undefined,
        createdAt: r.created_at instanceof Date ? r.created_at.toISOString() : String(r.created_at),
        updatedAt: r.updated_at instanceof Date ? r.updated_at.toISOString() : String(r.updated_at),
    };
}

function rowToAoFellowshipApp(r: Record<string, unknown>): StoredAoFellowshipApplication {
    return {
        id: r.id as string,
        schoolId: r.school_id as string,
        sponsorAgentId: r.sponsor_agent_id as string,
        orgSlug: r.org_slug as string,
        orgName: r.org_name as string,
        description: r.description as string | undefined,
        applicationJson: (r.application_json as Record<string, unknown>) ?? {},
        status: r.status as AoFellowshipApplicationStatus,
        cycleId: r.cycle_id as string | undefined,
        scores: r.scores as Record<string, unknown> | undefined,
        staffFeedback: r.staff_feedback as string | undefined,
        reviewedByHumanUserId: r.reviewed_by_human_user_id as string | undefined,
        createdAt: r.created_at instanceof Date ? r.created_at.toISOString() : String(r.created_at),
        updatedAt: r.updated_at instanceof Date ? r.updated_at.toISOString() : String(r.updated_at),
    };
}

export async function listAoCohorts(_schoolId = "ao"): Promise<StoredAoCohort[]> {
    const rows = await sql!`
        SELECT * FROM ao_cohorts ORDER BY opens_at DESC NULLS LAST, created_at DESC
    `;
    return (rows as Record<string, unknown>[]).map(rowToAoCohort);
}

export async function getAoCohort(id: string): Promise<StoredAoCohort | null> {
    const rows = await sql!`SELECT * FROM ao_cohorts WHERE id = ${id} LIMIT 1`;
    const r = rows[0] as Record<string, unknown> | undefined;
    return r ? rowToAoCohort(r) : null;
}

export async function createAoCohort(input: Omit<StoredAoCohort, "createdAt" | "updatedAt">): Promise<StoredAoCohort> {
    const now = new Date().toISOString();
    await sql!`
        INSERT INTO ao_cohorts (id, name, scenario_id, scenario_name, scenario_brief, status, opens_at, closes_at, max_companies, created_at, updated_at)
        VALUES (
            ${input.id},
            ${input.name},
            ${input.scenarioId ?? null},
            ${input.scenarioName ?? null},
            ${input.scenarioBrief ?? null},
            ${input.status},
            ${input.opensAt ?? null},
            ${input.closesAt ?? null},
            ${input.maxCompanies},
            ${now},
            ${now}
        )
    `;
    return { ...input, createdAt: now, updatedAt: now };
}

export async function getAoCompany(id: string): Promise<StoredAoCompany | null> {
    const rows = await sql!`SELECT * FROM ao_companies WHERE id = ${id} LIMIT 1`;
    const r = rows[0] as Record<string, unknown> | undefined;
    return r ? rowToAoCompany(r) : null;
}

export async function listAoCompanies(filters: {
    schoolId?: string;
    stage?: string;
    cohortId?: string;
    status?: string;
}): Promise<StoredAoCompany[]> {
    const schoolId = filters.schoolId ?? "ao";
    let rows;
    if (filters.stage && filters.cohortId) {
        rows = await sql!`
            SELECT * FROM ao_companies
            WHERE school_id = ${schoolId} AND stage = ${filters.stage} AND founding_cohort_id = ${filters.cohortId}
            ORDER BY founded_at DESC
        `;
    } else if (filters.stage) {
        rows = await sql!`
            SELECT * FROM ao_companies
            WHERE school_id = ${schoolId} AND stage = ${filters.stage}
            ORDER BY founded_at DESC
        `;
    } else if (filters.cohortId) {
        rows = await sql!`
            SELECT * FROM ao_companies
            WHERE school_id = ${schoolId} AND founding_cohort_id = ${filters.cohortId}
            ORDER BY founded_at DESC
        `;
    } else if (filters.status) {
        rows = await sql!`
            SELECT * FROM ao_companies
            WHERE school_id = ${schoolId} AND status = ${filters.status}
            ORDER BY founded_at DESC
        `;
    } else {
        rows = await sql!`
            SELECT * FROM ao_companies
            WHERE school_id = ${schoolId}
            ORDER BY founded_at DESC
        `;
    }
    return (rows as Record<string, unknown>[]).map(rowToAoCompany);
}

async function ensureUniqueAoCompanyId(base: string): Promise<string> {
    let id = base;
    for (let i = 0; i < 12; i++) {
        const existing = await getAoCompany(id);
        if (!existing) return id;
        id = `${base}-${Math.random().toString(36).slice(2, 6)}`;
    }
    return `${base}-${randomUUID().slice(0, 8)}`;
}

export async function createAoCompany(input: {
    id?: string;
    name: string;
    tagline?: string;
    description?: string;
    schoolId?: string;
    foundingCohortId?: string;
    scenarioId?: string;
    founderAgentIds: string[];
}): Promise<StoredAoCompany | null> {
    if (!input.name?.trim() || input.founderAgentIds.length === 0) return null;
    const schoolId = input.schoolId ?? "ao";
    const baseId = input.id?.trim() ? slugifyAoCompanyId(input.id.trim()) : slugifyAoCompanyId(input.name);
    const id = await ensureUniqueAoCompanyId(baseId);
    const now = new Date().toISOString();
    await sql!`
        INSERT INTO ao_companies (
            id, name, tagline, description, school_id, founding_cohort_id, founded_at,
            stage, status, scenario_id, total_eval_score, working_paper_count, config, created_at, updated_at
        ) VALUES (
            ${id},
            ${input.name.trim()},
            ${input.tagline ?? null},
            ${input.description ?? null},
            ${schoolId},
            ${input.foundingCohortId ?? null},
            ${now},
            'seed',
            'active',
            ${input.scenarioId ?? null},
            0,
            0,
            '{}'::jsonb,
            ${now},
            ${now}
        )
    `;
    for (const agentId of input.founderAgentIds) {
        await sql!`
            INSERT INTO ao_company_agents (company_id, agent_id, role, joined_at)
            VALUES (${id}, ${agentId}, 'founder', ${now})
            ON CONFLICT (company_id, agent_id) DO NOTHING
        `;
    }
    return getAoCompany(id);
}

export async function listAoCompanyTeam(companyId: string): Promise<StoredAoCompanyAgent[]> {
    const rows = await sql!`
        SELECT company_id, agent_id, role, title, joined_at, departed_at, equity_notes
        FROM ao_company_agents WHERE company_id = ${companyId}
        ORDER BY joined_at ASC
    `;
    return (rows as Record<string, unknown>[]).map((r) => ({
        companyId: r.company_id as string,
        agentId: r.agent_id as string,
        role: r.role as string | undefined,
        title: r.title as string | undefined,
        joinedAt: r.joined_at instanceof Date ? r.joined_at.toISOString() : String(r.joined_at),
        departedAt: r.departed_at
            ? r.departed_at instanceof Date
                ? r.departed_at.toISOString()
                : String(r.departed_at)
            : undefined,
        equityNotes: r.equity_notes as string | undefined,
    }));
}

export async function addAoCompanyTeamMember(
    companyId: string,
    agentId: string,
    role: string,
    title?: string
): Promise<boolean> {
    const now = new Date().toISOString();
    try {
        await sql!`
            INSERT INTO ao_company_agents (company_id, agent_id, role, title, joined_at)
            VALUES (${companyId}, ${agentId}, ${role}, ${title ?? null}, ${now})
            ON CONFLICT (company_id, agent_id) DO UPDATE SET
                role = EXCLUDED.role,
                title = EXCLUDED.title,
                departed_at = NULL
        `;
        return true;
    } catch {
        return false;
    }
}

export async function getAoCompanyEvaluations(companyId: string): Promise<StoredAoCompanyEvaluation[]> {
    const rows = await sql!`
        SELECT id::text, company_id, evaluation_id, result_id, score, max_score, passed, completed_at, cohort_id
        FROM ao_company_evaluations WHERE company_id = ${companyId}
        ORDER BY completed_at DESC NULLS LAST
    `;
    return (rows as Record<string, unknown>[]).map((r) => ({
        id: String(r.id),
        companyId: r.company_id as string,
        evaluationId: r.evaluation_id as string,
        resultId: r.result_id as string | undefined,
        score: r.score != null ? Number(r.score) : undefined,
        maxScore: r.max_score != null ? Number(r.max_score) : undefined,
        passed: r.passed != null ? Boolean(r.passed) : undefined,
        completedAt: r.completed_at
            ? r.completed_at instanceof Date
                ? r.completed_at.toISOString()
                : String(r.completed_at)
            : undefined,
        cohortId: r.cohort_id as string | undefined,
    }));
}

async function recomputeAoCompanyStage(companyId: string): Promise<void> {
    const rows = await sql!`
        SELECT evaluation_id FROM ao_company_evaluations
        WHERE company_id = ${companyId} AND passed = true
    `;
    const passed = new Set((rows as { evaluation_id: string }[]).map((x) => x.evaluation_id));
    const company = await getAoCompany(companyId);
    if (!company || company.status !== "active") return;
    let stage = company.stage;
    if (stage === "seed" && passed.has(AO_EVAL_MARKET) && passed.has(AO_EVAL_TEAM)) stage = "operating";
    if (stage === "operating" && passed.has(AO_EVAL_PITCH) && passed.has(AO_EVAL_GOV)) stage = "scaling";
    if (stage !== company.stage) {
        const now = new Date().toISOString();
        await sql!`
            UPDATE ao_companies
            SET stage = ${stage}, stage_updated_at = ${now}, updated_at = ${now}
            WHERE id = ${companyId}
        `;
    }
}

export async function recordAoCompanyEvaluation(input: {
    companyId: string;
    evaluationId: string;
    resultId?: string;
    score?: number;
    maxScore?: number;
    passed?: boolean;
    cohortId?: string;
}): Promise<StoredAoCompanyEvaluation | null> {
    const company = await getAoCompany(input.companyId);
    if (!company) return null;
    const ed = await sql!`
        SELECT points FROM evaluation_definitions WHERE id = ${input.evaluationId} AND school_id = ${company.schoolId}
        LIMIT 1
    `;
    const pointsRow = ed[0] as { points: unknown } | undefined;
    const evalPoints = pointsRow?.points != null ? Number(pointsRow.points) : 0;
    const completedAt = new Date().toISOString();
    const rows = await sql!`
        INSERT INTO ao_company_evaluations (
            company_id, evaluation_id, result_id, score, max_score, passed, completed_at, cohort_id
        ) VALUES (
            ${input.companyId},
            ${input.evaluationId},
            ${input.resultId ?? null},
            ${input.score ?? null},
            ${input.maxScore ?? null},
            ${input.passed ?? null},
            ${completedAt},
            ${input.cohortId ?? null}
        )
        RETURNING id::text, company_id, evaluation_id, result_id, score, max_score, passed, completed_at, cohort_id
    `;
    const r = rows[0] as Record<string, unknown>;
    if (input.passed) {
        await sql!`
            UPDATE ao_companies
            SET total_eval_score = total_eval_score + ${evalPoints}, updated_at = ${completedAt}
            WHERE id = ${input.companyId}
        `;
    }
    await recomputeAoCompanyStage(input.companyId);
    return {
        id: String(r.id),
        companyId: r.company_id as string,
        evaluationId: r.evaluation_id as string,
        resultId: r.result_id as string | undefined,
        score: r.score != null ? Number(r.score) : undefined,
        maxScore: r.max_score != null ? Number(r.max_score) : undefined,
        passed: r.passed != null ? Boolean(r.passed) : undefined,
        completedAt: r.completed_at instanceof Date ? r.completed_at.toISOString() : String(r.completed_at),
        cohortId: r.cohort_id as string | undefined,
    };
}

export async function dissolveAoCompany(companyId: string, reason?: string): Promise<boolean> {
    const now = new Date().toISOString();
    const rows = await sql!`
        UPDATE ao_companies
        SET status = 'dissolved', stage = 'dissolved', dissolution_reason = ${reason ?? null}, updated_at = ${now}
        WHERE id = ${companyId} AND status = 'active'
        RETURNING id
    `;
    return rows.length > 0;
}

export async function getAoCompanyLeaderboard(view: "all-time" | "cohort", cohortId?: string): Promise<StoredAoCompany[]> {
    if (view === "cohort" && cohortId) {
        const rows = await sql!`
            SELECT * FROM ao_companies
            WHERE school_id = 'ao' AND founding_cohort_id = ${cohortId} AND status = 'active'
            ORDER BY total_eval_score DESC, founded_at ASC
        `;
        return (rows as Record<string, unknown>[]).map(rowToAoCompany);
    }
    const rows = await sql!`
        SELECT * FROM ao_companies
        WHERE school_id = 'ao' AND status = 'active'
        ORDER BY total_eval_score DESC, founded_at ASC
    `;
    return (rows as Record<string, unknown>[]).map(rowToAoCompany);
}

export async function createAoFellowshipApplication(input: {
    sponsorAgentId: string;
    orgSlug: string;
    orgName: string;
    description?: string;
    applicationJson: Record<string, unknown>;
    cycleId?: string;
    schoolId?: string;
}): Promise<StoredAoFellowshipApplication> {
    const id = `fapp_${randomUUID().replace(/-/g, "")}`;
    const schoolId = input.schoolId ?? "ao";
    const now = new Date().toISOString();
    await sql!`
        INSERT INTO ao_fellowship_applications (
            id, school_id, sponsor_agent_id, org_slug, org_name, description, application_json, status, cycle_id, created_at, updated_at
        ) VALUES (
            ${id},
            ${schoolId},
            ${input.sponsorAgentId},
            ${input.orgSlug},
            ${input.orgName},
            ${input.description ?? null},
            ${JSON.stringify(input.applicationJson)}::jsonb,
            'pending',
            ${input.cycleId ?? null},
            ${now},
            ${now}
        )
    `;
    const row = await sql!`SELECT * FROM ao_fellowship_applications WHERE id = ${id} LIMIT 1`;
    return rowToAoFellowshipApp(row[0] as Record<string, unknown>);
}

export async function listAoFellowshipApplications(filters?: { status?: AoFellowshipApplicationStatus }): Promise<StoredAoFellowshipApplication[]> {
    let rows;
    if (filters?.status) {
        rows = await sql!`
            SELECT * FROM ao_fellowship_applications WHERE status = ${filters.status}
            ORDER BY created_at DESC
        `;
    } else {
        rows = await sql!`SELECT * FROM ao_fellowship_applications ORDER BY created_at DESC`;
    }
    return (rows as Record<string, unknown>[]).map(rowToAoFellowshipApp);
}

export async function getAoFellowshipApplication(id: string): Promise<StoredAoFellowshipApplication | null> {
    const rows = await sql!`SELECT * FROM ao_fellowship_applications WHERE id = ${id} LIMIT 1`;
    const r = rows[0] as Record<string, unknown> | undefined;
    return r ? rowToAoFellowshipApp(r) : null;
}

export async function updateAoFellowshipApplication(
    id: string,
    updates: Partial<{
        status: AoFellowshipApplicationStatus;
        scores: Record<string, unknown>;
        staffFeedback: string;
        reviewedByHumanUserId: string;
    }>
): Promise<boolean> {
    const existing = await getAoFellowshipApplication(id);
    if (!existing) return false;
    const now = new Date().toISOString();
    const scores = updates.scores !== undefined ? updates.scores : existing.scores;
    await sql!`
        UPDATE ao_fellowship_applications SET
            status = ${updates.status ?? existing.status},
            scores = ${JSON.stringify(scores ?? {})}::jsonb,
            staff_feedback = ${updates.staffFeedback !== undefined ? updates.staffFeedback : existing.staffFeedback ?? null},
            reviewed_by_human_user_id = ${updates.reviewedByHumanUserId !== undefined ? updates.reviewedByHumanUserId : existing.reviewedByHumanUserId ?? null},
            updated_at = ${now}
        WHERE id = ${id}
    `;
    return true;
}

/** Sets AO Fellow credential on an agent's metadata (merge). */
export async function setAgentAoFellowCredential(
    agentId: string,
    cohortLabel: string,
    orgSlug: string
): Promise<boolean> {
    const agent = await getAgentById(agentId);
    if (!agent) return false;
    const meta = { ...(agent.metadata ?? {}) };
    meta.ao_fellow = true;
    meta.ao_fellowship_cohort = cohortLabel;
    meta.ao_fellow_org_slug = orgSlug;
    await updateAgent(agentId, { metadata: meta });
    return true;
}
