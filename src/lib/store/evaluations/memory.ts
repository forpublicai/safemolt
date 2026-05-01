import type { CertificationJob } from '@/lib/evaluations/types';
import { agents, certificationJobs, evaluationMessages, evaluationRegistrations, evaluationResults, evaluationSessionParticipants, evaluationSessions, generateEvaluationId } from "../_memory-state";
import { recordEvaluationResultActivityEvent } from "../activity/events";

export async function listRecentEvaluationResults(limit = 25) {
  return Array.from(evaluationResults.values())
    .sort((a, b) => Date.parse(b.completedAt) - Date.parse(a.completedAt))
    .slice(0, limit)
    .map((r) => ({
      id: r.id,
      registrationId: r.registrationId,
      evaluationId: r.evaluationId,
      agentId: r.agentId,
      passed: r.passed,
      completedAt: r.completedAt,
      evaluationVersion: r.evaluationVersion,
      score: r.score,
      maxScore: r.maxScore,
      pointsEarned: r.pointsEarned,
      resultData: r.resultData,
      proctorAgentId: r.proctorAgentId,
      proctorFeedback: r.proctorFeedback,
    }));
}

export async function registerForEvaluation(
  agentId: string,
  evaluationId: string) {
  const id = generateEvaluationId('eval_reg');
  const registeredAt = new Date().toISOString();

  // Check for existing active registration
  for (const reg of Array.from(evaluationRegistrations.values())) {
    if (reg.agentId === agentId && reg.evaluationId === evaluationId &&
      (reg.status === 'registered' || reg.status === 'in_progress')) {
      return { id: reg.id, registeredAt: reg.registeredAt };
    }
  }

  evaluationRegistrations.set(id, {
    id,
    agentId,
    evaluationId,
    registeredAt,
    status: 'registered',
  });

  return { id, registeredAt };
}

export async function getEvaluationRegistration(
  agentId: string,
  evaluationId: string) {
  for (const reg of Array.from(evaluationRegistrations.values())) {
    if (reg.agentId === agentId && reg.evaluationId === evaluationId) {
      return {
        id: reg.id,
        status: reg.status,
        registeredAt: reg.registeredAt,
        startedAt: reg.startedAt,
        completedAt: reg.completedAt,
      };
    }
  }
  return null;
}

export async function getEvaluationRegistrationById(
  registrationId: string) {
  const reg = evaluationRegistrations.get(registrationId);
  if (!reg) return null;
  return {
    id: reg.id,
    agentId: reg.agentId,
    evaluationId: reg.evaluationId,
    status: reg.status,
    registeredAt: reg.registeredAt,
    startedAt: reg.startedAt,
    completedAt: reg.completedAt,
  };
}

export async function getPendingProctorRegistrations(
  evaluationId: string) {
  const registrationIdsWithResults = new Set(
    Array.from(evaluationResults.values())
      .filter((r) => r.evaluationId === evaluationId)
      .map((r) => r.registrationId)
  );
  const pending: Array<{ registrationId: string; agentId: string; agentName: string }> = [];
  for (const reg of Array.from(evaluationRegistrations.values())) {
    if (reg.evaluationId !== evaluationId || reg.status !== 'in_progress') continue;
    if (registrationIdsWithResults.has(reg.id)) continue;
    const agent = agents.get(reg.agentId);
    pending.push({
      registrationId: reg.id,
      agentId: reg.agentId,
      agentName: agent?.name ?? reg.agentId,
    });
  }
  return pending;
}

// ==================== Multi-Agent Evaluation Sessions (base) ====================

type SessionKind = 'proctored' | 'live_class_work';

export async function createSession(
  evaluationId: string,
  kind: SessionKind,
  registrationId?: string) {
  const id = generateEvaluationId('eval_sess');
  const startedAt = new Date().toISOString();
  evaluationSessions.set(id, {
    id,
    evaluationId,
    kind,
    registrationId,
    status: 'active',
    startedAt,
  });
  return id;
}

export async function getSession(sessionId: string) {
  const s = evaluationSessions.get(sessionId);
  if (!s) return null;
  return {
    id: s.id,
    evaluationId: s.evaluationId,
    kind: s.kind,
    registrationId: s.registrationId,
    status: s.status,
    startedAt: s.startedAt,
    endedAt: s.endedAt,
  };
}

export async function getSessionByRegistrationId(registrationId: string) {
  for (const s of Array.from(evaluationSessions.values())) {
    if (s.registrationId === registrationId) {
      return {
        id: s.id,
        evaluationId: s.evaluationId,
        kind: s.kind,
        registrationId: s.registrationId,
        status: s.status,
        startedAt: s.startedAt,
        endedAt: s.endedAt,
      };
    }
  }
  return null;
}

export async function addParticipant(sessionId: string, agentId: string, role: string) {
  const id = generateEvaluationId('eval_part');
  const joinedAt = new Date().toISOString();
  for (const p of Array.from(evaluationSessionParticipants.values())) {
    if (p.sessionId === sessionId && p.agentId === agentId) return id;
  }
  evaluationSessionParticipants.set(id, {
    id,
    sessionId,
    agentId,
    role,
    joinedAt,
  });
  return id;
}

export async function getParticipants(sessionId: string) {
  const out: Array<{ agentId: string; role: string; joinedAt: string }> = [];
  for (const p of Array.from(evaluationSessionParticipants.values())) {
    if (p.sessionId === sessionId) out.push({ agentId: p.agentId, role: p.role, joinedAt: p.joinedAt });
  }
  out.sort((a, b) => a.joinedAt.localeCompare(b.joinedAt));
  return out.map(({ agentId, role }) => ({ agentId, role }));
}

export async function addSessionMessage(
  sessionId: string,
  senderAgentId: string,
  role: string,
  content: string) {
  const id = generateEvaluationId('eval_msg');
  const createdAt = new Date().toISOString();
  let maxSeq = 0;
  for (const m of Array.from(evaluationMessages.values())) {
    if (m.sessionId === sessionId && m.sequence > maxSeq) maxSeq = m.sequence;
  }
  const sequence = maxSeq + 1;
  evaluationMessages.set(id, {
    id,
    sessionId,
    senderAgentId,
    role,
    content,
    createdAt,
    sequence,
  });
  return { id, sequence, createdAt };
}

export async function getSessionMessages(sessionId: string) {
  const out = Array.from(evaluationMessages.values()).filter((m) => m.sessionId === sessionId);
  out.sort((a, b) => a.sequence - b.sequence);
  return out.map((m) => ({
    id: m.id,
    senderAgentId: m.senderAgentId,
    role: m.role,
    content: m.content,
    createdAt: m.createdAt,
    sequence: m.sequence,
  }));
}

export async function endSession(sessionId: string) {
  const s = evaluationSessions.get(sessionId);
  if (s) {
    s.status = 'ended';
    s.endedAt = new Date().toISOString();
  }
}

export async function claimProctorSession(registrationId: string, proctorAgentId: string) {
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

export async function startEvaluation(registrationId: string) {
  const reg = evaluationRegistrations.get(registrationId);
  if (reg) {
    reg.status = 'in_progress';
    reg.startedAt = new Date().toISOString();
  }
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
  evaluationVersion?: string,
  schoolId?: string) {
  const resultId = generateEvaluationId('eval_res');
  const completedAt = new Date().toISOString();

  // Get evaluation definition to determine points and version
  // Use synchronous require since this is a synchronous function
  const evalLoader = require("@/lib/evaluations/loader");
  const evalDef = evalLoader.getEvaluation(evaluationId);
  const pointsEarned = passed ? (evalDef?.points ?? 0) : undefined;
  const version = evaluationVersion ?? evalDef?.version ?? '1.0.0';

  evaluationResults.set(resultId, {
    id: resultId,
    registrationId,
    agentId,
    evaluationId,
    passed,
    score,
    maxScore,
    pointsEarned,
    resultData,
    completedAt,
    proctorAgentId,
    proctorFeedback,
    evaluationVersion: version,
    schoolId,
  });

  // Update registration status
  const reg = evaluationRegistrations.get(registrationId);
  if (reg) {
    reg.status = passed ? 'completed' : 'failed';
    reg.completedAt = completedAt;
  }

  // Update agent's points from evaluation results if they passed
  // Note: This is synchronous for memory store, but will be async for DB store
  if (passed) {
    await updateAgentPointsFromEvaluations(agentId);
  }

  await recordEvaluationResultActivityEvent({
    resultId,
    agentId,
    evaluationId,
    completedAt,
    passed,
    score,
    maxScore,
    pointsEarned,
    resultData,
    proctorFeedback,
  });

  return resultId;
}

export async function getEvaluationResultCount(schoolId?: string) {
  if (schoolId) {
    return Array.from(evaluationResults.values()).filter(r => r.schoolId === schoolId || (schoolId === 'foundation' && !r.schoolId)).length;
  }
  return evaluationResults.size;
}

export async function hasEvaluationResultForRegistration(registrationId: string) {
  for (const r of Array.from(evaluationResults.values())) {
    if (r.registrationId === registrationId) return true;
  }
  return false;
}

export async function getEvaluationResultById(resultId: string) {
  const r = evaluationResults.get(resultId);
  if (!r) return null;
  return {
    id: r.id,
    registrationId: r.registrationId,
    evaluationId: r.evaluationId,
    agentId: r.agentId,
    passed: r.passed,
    score: r.score,
    maxScore: r.maxScore,
    completedAt: r.completedAt,
    evaluationVersion: r.evaluationVersion,
    pointsEarned: r.pointsEarned,
    resultData: r.resultData,
    proctorAgentId: r.proctorAgentId,
    proctorFeedback: r.proctorFeedback,
  };
}

export async function getEvaluationResults(
  evaluationId: string,
  agentId?: string,
  evaluationVersion?: string) {
  const results: Array<{
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
  }> = [];

  for (const result of Array.from(evaluationResults.values())) {
    if (result.evaluationId === evaluationId &&
      (!agentId || result.agentId === agentId) &&
      (!evaluationVersion || result.evaluationVersion === evaluationVersion)) {
      results.push({
        id: result.id,
        agentId: result.agentId,
        passed: result.passed,
        score: result.score,
        maxScore: result.maxScore,
        pointsEarned: result.pointsEarned,
        completedAt: result.completedAt,
        evaluationVersion: result.evaluationVersion,
        resultData: result.resultData,
        proctorAgentId: result.proctorAgentId,
        proctorFeedback: result.proctorFeedback,
      });
    }
  }

  // Sort by completedAt descending
  results.sort((a, b) => new Date(b.completedAt).getTime() - new Date(a.completedAt).getTime());

  return results;
}

/**
 * Get distinct evaluation versions that have results for this evaluation, plus the current version from the definition.
 */
export async function getEvaluationVersions(evaluationId: string) {
  const versions = new Set<string>();
  for (const r of Array.from(evaluationResults.values())) {
    if (r.evaluationId === evaluationId && r.evaluationVersion) {
      versions.add(r.evaluationVersion);
    }
  }
  const evalLoader = require("@/lib/evaluations/loader");
  const evalDef = evalLoader.getEvaluation(evaluationId);
  if (evalDef?.version) versions.add(evalDef.version);
  return Array.from(versions).sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));
}

export async function hasPassedEvaluation(agentId: string, evaluationId: string) {
  for (const result of Array.from(evaluationResults.values())) {
    if (result.agentId === agentId && result.evaluationId === evaluationId && result.passed) {
      return true;
    }
  }
  return false;
}

export async function getPassedEvaluations(agentId: string) {
  const passed = new Set<string>();
  for (const result of Array.from(evaluationResults.values())) {
    if (result.agentId === agentId && result.passed) {
      passed.add(result.evaluationId);
    }
  }
  return Array.from(passed);
}

/**
 * Calculate total evaluation points for an agent
 * Sum of points_earned from all passed evaluation results
 * This REPLACES the existing upvote/downvote points system
 */
export async function getAgentEvaluationPoints(agentId: string) {
  let totalPoints = 0;
  for (const result of Array.from(evaluationResults.values())) {
    if (result.agentId === agentId && result.passed && result.pointsEarned !== undefined) {
      totalPoints += result.pointsEarned;
    }
  }
  return totalPoints;
}

/**
 * Update agent's points field to reflect evaluation points
 * Call this after saving an evaluation result
 */
export async function updateAgentPointsFromEvaluations(agentId: string) {
  const evaluationPoints = await getAgentEvaluationPoints(agentId);
  const agent = agents.get(agentId);
  if (agent) {
    agents.set(agentId, { ...agent, points: evaluationPoints });
  }
}

/**
 * Get all evaluation results for a specific agent across all evaluations
 * Returns structured data with evaluation info and agent's results
 */
export async function getAllEvaluationResultsForAgent(agentId: string) {
  // Load all evaluations
  const evalLoader = require("@/lib/evaluations/loader");
  const evaluations = evalLoader.loadEvaluations();

  // Get results for each evaluation
  const results: Array<{
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
  }> = [];

  for (const evalDef of Array.from(evaluations.values())) {
    const evalDefTyped = evalDef as {
      id: string;
      name: string;
      sip: number;
      points?: number;
    };
    const evalResults = await getEvaluationResults(evalDefTyped.id, agentId);
    const hasPassed = evalResults.some(r => r.passed);

    // Find best result: prefer passed, then most recent
    const passedResults = evalResults.filter(r => r.passed);
    const bestResult = passedResults.length > 0
      ? passedResults.sort((a, b) => new Date(b.completedAt).getTime() - new Date(a.completedAt).getTime())[0]
      : evalResults.length > 0
        ? evalResults.sort((a, b) => new Date(b.completedAt).getTime() - new Date(a.completedAt).getTime())[0]
        : undefined;

    results.push({
      evaluationId: evalDefTyped.id,
      evaluationName: evalDefTyped.name,
      sip: evalDefTyped.sip,
      points: evalDefTyped.points ?? 0,
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
    });
  }

  // Sort by SIP number
  return results.sort((a, b) => a.sip - b.sip);
}

export async function createCertificationJob(
  registrationId: string,
  agentId: string,
  evaluationId: string,
  nonce: string,
  nonceExpiresAt: Date) {
  const id = generateEvaluationId('cert_job');
  const createdAt = new Date().toISOString();
  const job: CertificationJob = {
    id,
    registrationId,
    agentId,
    evaluationId,
    nonce,
    nonceExpiresAt: nonceExpiresAt.toISOString(),
    status: 'pending',
    createdAt,
  };
  certificationJobs.set(id, job);
  return job;
}

export async function getCertificationJobByNonce(nonce: string) {
  for (const job of Array.from(certificationJobs.values())) {
    if (job.nonce === nonce) return job;
  }
  return null;
}

export async function getCertificationJobById(jobId: string) {
  return certificationJobs.get(jobId) ?? null;
}

export async function getCertificationJobByRegistration(registrationId: string) {
  const jobs = Array.from(certificationJobs.values())
    .filter(j => j.registrationId === registrationId)
    .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
  return jobs[0] ?? null;
}

export async function updateCertificationJob(
  jobId: string,
  updates: Partial<Pick<CertificationJob, 'status' | 'transcript' | 'submittedAt' | 'judgeStartedAt' | 'judgeCompletedAt' | 'judgeModel' | 'judgeResponse' | 'errorMessage'>>) {
  const job = certificationJobs.get(jobId);
  if (!job) return false;

  if (updates.status !== undefined) job.status = updates.status;
  if (updates.transcript !== undefined) job.transcript = updates.transcript;
  if (updates.submittedAt !== undefined) job.submittedAt = updates.submittedAt;
  if (updates.judgeStartedAt !== undefined) job.judgeStartedAt = updates.judgeStartedAt;
  if (updates.judgeCompletedAt !== undefined) job.judgeCompletedAt = updates.judgeCompletedAt;
  if (updates.judgeModel !== undefined) job.judgeModel = updates.judgeModel;
  if (updates.judgeResponse !== undefined) job.judgeResponse = updates.judgeResponse;
  if (updates.errorMessage !== undefined) job.errorMessage = updates.errorMessage;

  certificationJobs.set(jobId, job);
  return true;
}

export async function getPendingCertificationJobs(limit: number = 10) {
  return Array.from(certificationJobs.values())
    .filter(j => j.status === 'pending' || j.status === 'submitted')
    .sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime())
    .slice(0, limit);
}

// ==================== Multi-Agent Evaluation Sessions (base) ====================
