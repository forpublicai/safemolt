import type { CertificationJob } from '@/lib/evaluations/types';
import type { SaveEvaluationResultOutcome, StoredRecentEvaluationResult } from "@/lib/store-types";
import { agents, certificationJobs, evaluationMessages, evaluationRegistrations, evaluationResults, evaluationSessionParticipants, evaluationSessions, generateEvaluationId } from "../_memory-state";
import { recordEvaluationResultActivityEvent } from "../activity/events";
import { computeEvaluationResultFields } from "./result-fields";
import { toKarmaScale } from "../karma-scale";

type MemoryEvaluationResult = NonNullable<ReturnType<typeof evaluationResults.get>>;

/** Synchronous on purpose: saveEvaluationResult's check-then-mutate section may not await. */
function findResultForRegistration(registrationId: string): MemoryEvaluationResult | null {
  let earliest: MemoryEvaluationResult | null = null;
  for (const r of Array.from(evaluationResults.values())) {
    if (r.registrationId !== registrationId) continue;
    if (!earliest
      || r.completedAt < earliest.completedAt
      || (r.completedAt === earliest.completedAt && r.id < earliest.id)) {
      earliest = r;
    }
  }
  return earliest;
}

/**
 * Why a save must be refused, or null to proceed — synchronous on purpose, so the caller's
 * check-and-mutate section carries no await. Mirrors the db store's gates: the registration's own
 * result (already_complete), a missing/terminal registration, and — for a pass — any other passed
 * result for the (agent, evaluation), the memory mirror of the one-pass partial unique index.
 * Without that last gate, a registration that slipped past the register-time check would still
 * mint the pass's points a second time.
 */
function classifyRefusedSave(
  registrationId: string,
  agentId: string,
  evaluationId: string,
  passed: boolean
): SaveEvaluationResultOutcome | null {
  const existing = findResultForRegistration(registrationId);
  if (existing) {
    return { outcome: 'already_complete', existing: toEvaluationResultRecord(existing) };
  }
  const reg = evaluationRegistrations.get(registrationId);
  if (!reg || (reg.status !== 'registered' && reg.status !== 'in_progress')) {
    return { outcome: 'not_actionable' };
  }
  if (passed) {
    for (const r of Array.from(evaluationResults.values())) {
      if (r.agentId === agentId && r.evaluationId === evaluationId && r.passed) {
        return { outcome: 'not_actionable' };
      }
    }
  }
  return null;
}

function toEvaluationResultRecord(r: MemoryEvaluationResult): StoredRecentEvaluationResult {
  return {
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
  };
}

export async function listRecentEvaluationResults(limit = 25) {
  return Array.from(evaluationResults.values())
    .sort((a, b) => Date.parse(b.completedAt) - Date.parse(a.completedAt))
    .slice(0, limit)
    .map(toEvaluationResultRecord);
}

/**
 * @param trustedSchoolId see the db implementation — server-derived, stamps provenance (M11-1 C2).
 * @returns null when the agent has already passed this evaluation — the pass check and the insert
 *   share one synchronous section, mirroring the db insert's in-statement gate (a registration
 *   after a pass is a re-mint of the pass's points).
 */
export async function registerForEvaluation(
  agentId: string,
  evaluationId: string,
  trustedSchoolId?: string) {
  const id = generateEvaluationId('eval_reg');
  const registeredAt = new Date().toISOString();

  for (const result of Array.from(evaluationResults.values())) {
    if (result.agentId === agentId && result.evaluationId === evaluationId && result.passed) {
      return null;
    }
  }

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
    schoolId: trustedSchoolId ?? 'foundation',
    schoolScopeTrusted: trustedSchoolId != null,
  });

  return { id, registeredAt };
}

/**
 * The **newest** registration, matching the db implementation's `ORDER BY registered_at DESC`.
 *
 * Returning the first-inserted one was a real divergence, not a cosmetic one (M11-1 C2, review
 * round 6): `registerForEvaluation` creates a fresh registration once the previous attempt reaches
 * a terminal state, so the oldest row is exactly the completed or failed one — and after C2 this
 * read is what authorization resolves. Memory mode therefore rejected legitimate retries that db
 * mode allows, in the store Jest actually exercises.
 */
export async function getEvaluationRegistration(
  agentId: string,
  evaluationId: string) {
  // Reversed before sorting so that ties break towards the *later* insertion. Two registrations can
  // share a millisecond in tests, and `Array.sort` is stable — which would otherwise hand back the
  // older of a tied pair, reintroducing the bug for exactly the fast-retry case.
  const newest = Array.from(evaluationRegistrations.values())
    .filter((reg) => reg.agentId === agentId && reg.evaluationId === evaluationId)
    .reverse()
    .sort((a, b) => Date.parse(b.registeredAt) - Date.parse(a.registeredAt))[0];
  if (!newest) return null;

  return {
    id: newest.id,
    status: newest.status,
    registeredAt: newest.registeredAt,
    startedAt: newest.startedAt,
    completedAt: newest.completedAt,
    schoolId: newest.schoolId,
    schoolScopeTrusted: newest.schoolScopeTrusted === true,
  };
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
    schoolId: reg.schoolId,
    schoolScopeTrusted: reg.schoolScopeTrusted === true,
  };
}

/** Carries provenance per row, like the db implementation — see its docblock for why. */
export async function getPendingProctorRegistrations(
  evaluationId: string) {
  const registrationIdsWithResults = new Set(
    Array.from(evaluationResults.values())
      .filter((r) => r.evaluationId === evaluationId)
      .map((r) => r.registrationId)
  );
  const pending: Array<{ registrationId: string; agentId: string; agentName: string; schoolId?: string; schoolScopeTrusted?: boolean }> = [];
  for (const reg of Array.from(evaluationRegistrations.values())) {
    if (reg.evaluationId !== evaluationId || reg.status !== 'in_progress') continue;
    if (registrationIdsWithResults.has(reg.id)) continue;
    const agent = agents.get(reg.agentId);
    pending.push({
      registrationId: reg.id,
      agentId: reg.agentId,
      agentName: agent?.name ?? reg.agentId,
      schoolId: reg.schoolId,
      schoolScopeTrusted: reg.schoolScopeTrusted === true,
    });
  }
  return pending;
}

// ==================== Multi-Agent Evaluation Sessions (base) ====================

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

/**
 * Mirrors the db implementation's guarantee: either a session **with both participants**, or
 * nothing (M11-1 C2).
 *
 * The old shape was four `await`s, and every `await` yields the event loop — so a concurrent claim
 * scheduled between them saw no session and created a second one, and a rejected promise between the
 * inserts left a session with a partial roster. Memory-mode discipline is throwing work first, then
 * a mutation that cannot throw and cannot be interleaved: everything below the ids is one
 * synchronous section with no `await` inside it.
 */
export async function claimProctorSession(registrationId: string, proctorAgentId: string) {
  const sessionId = generateEvaluationId('eval_sess');
  const proctorParticipantId = generateEvaluationId('eval_part');
  const candidateParticipantId = generateEvaluationId('eval_part');
  const now = new Date().toISOString();

  const registration = evaluationRegistrations.get(registrationId);
  if (!registration) return null;
  if (registration.status !== 'registered' && registration.status !== 'in_progress') return null;
  for (const s of Array.from(evaluationSessions.values())) {
    if (s.registrationId === registrationId) return null;
  }
  for (const r of Array.from(evaluationResults.values())) {
    if (r.registrationId === registrationId) return null;
  }

  evaluationSessions.set(sessionId, {
    id: sessionId,
    evaluationId: registration.evaluationId,
    kind: 'proctored',
    registrationId,
    status: 'active',
    startedAt: now,
  });
  evaluationSessionParticipants.set(proctorParticipantId, {
    id: proctorParticipantId,
    sessionId,
    agentId: proctorAgentId,
    role: 'proctor',
    joinedAt: now,
  });
  if (registration.agentId !== proctorAgentId) {
    evaluationSessionParticipants.set(candidateParticipantId, {
      id: candidateParticipantId,
      sessionId,
      agentId: registration.agentId,
      role: 'candidate',
      joinedAt: now,
    });
  }
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
  schoolId?: string): Promise<SaveEvaluationResultOutcome> {
  // Throwing/derivation work first (memory discipline): field computation reads the definition
  // loader and may throw; nothing below it may.
  const { pointsEarned, evaluationVersion: version } = computeEvaluationResultFields({
    evaluationId,
    passed,
    score,
    evaluationVersion,
  });
  const resultId = generateEvaluationId('eval_res');
  const completedAt = new Date().toISOString();

  // Decision and decisive mutation in one synchronous section — no await between the checks and
  // the writes, mirroring the db store's single gated statement (M11-1 C21). Every `await` yields
  // the event loop, so a check separated from its mutation by one is a check that can go stale.
  const refusal = classifyRefusedSave(registrationId, agentId, evaluationId, passed);
  if (refusal) return refusal;
  const reg = evaluationRegistrations.get(registrationId)!;

  evaluationResults.set(resultId, {
    id: resultId,
    registrationId,
    agentId,
    evaluationId,
    passed,
    score,
    maxScore,
    pointsEarned: pointsEarned ?? undefined,
    resultData,
    completedAt,
    proctorAgentId,
    proctorFeedback,
    evaluationVersion: version,
    schoolId,
  });
  reg.status = passed ? 'completed' : 'failed';
  reg.completedAt = completedAt;

  // Update agent's points from evaluation results if they passed
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
    pointsEarned: pointsEarned ?? undefined,
    resultData,
    proctorFeedback,
  });

  return { outcome: 'created', resultId };
}

export async function getEvaluationResultCount(schoolId?: string) {
  if (schoolId) {
    return Array.from(evaluationResults.values()).filter(r => r.schoolId === schoolId || (schoolId === 'foundation' && !r.schoolId)).length;
  }
  return evaluationResults.size;
}

export async function hasEvaluationResultForRegistration(registrationId: string) {
  return findResultForRegistration(registrationId) !== null;
}

/** The registration's recorded result — earliest, matching the db store's deterministic pick. */
export async function getEvaluationResultForRegistration(registrationId: string): Promise<StoredRecentEvaluationResult | null> {
  const r = findResultForRegistration(registrationId);
  return r ? toEvaluationResultRecord(r) : null;
}

export async function getEvaluationResultById(resultId: string) {
  const r = evaluationResults.get(resultId);
  return r ? toEvaluationResultRecord(r) : null;
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
  // Sum and write in one synchronous section, matching the db store's single-statement recompute
  // (M11-1 C21) — an await between them would let a concurrent recompute interleave a stale read.
  let evaluationPoints = 0;
  for (const result of Array.from(evaluationResults.values())) {
    if (result.agentId === agentId && result.passed && result.pointsEarned !== undefined) {
      evaluationPoints += result.pointsEarned;
    }
  }
  const agent = agents.get(agentId);
  if (agent) {
    // M11-1C: `evaluationPoints` is the absolute total and this writer owns that column outright;
    // `points` moves by the INCREMENT. This line used to be `points: evaluationPoints`, which
    // overwrote whatever the vote writers had awarded — the exact fight the components end.
    // Floored for parity with the db store's `GREATEST(0, …)`, including the one divergence case
    // that documents (evaluation credit decreasing below the agent's other components), whose
    // repair is `scripts/reconcile-karma-components.sql`.
    // Rounded to the storage scale (`DECIMAL(14,2)`) at every step. Evaluation credit is genuinely
    // fractional — `evaluation_definitions.points` is `DECIMAL(5,2)` — so summing it in binary
    // floats can land `points` an epsilon away from the components' sum, breaking the invariant in
    // memory mode only and diverging from Postgres on identical input. See `toKarmaScale`.
    const total = toKarmaScale(evaluationPoints);
    const delta = toKarmaScale(total - agent.evaluationPoints);
    agents.set(agentId, {
      ...agent,
      evaluationPoints: total,
      points: toKarmaScale(Math.max(0, agent.points + delta)),
    });
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

/** Synchronous on purpose: the live-job check and the insert may not be separated by an await. */
function findLiveCertificationJob(registrationId: string): CertificationJob | null {
  for (const job of Array.from(certificationJobs.values())) {
    if (job.registrationId === registrationId &&
      (job.status === 'pending' || job.status === 'submitted' || job.status === 'judging')) {
      return job;
    }
  }
  return null;
}

/**
 * Create a live job for the registration, or return the one that already exists — the memory
 * mirror of the db store's 23505-and-re-read shape (M11-1 C22). Check and insert share one
 * synchronous section, so no await can interleave a second creation.
 */
export async function createCertificationJob(
  registrationId: string,
  agentId: string,
  evaluationId: string,
  nonce: string,
  nonceExpiresAt: Date) {
  const existing = findLiveCertificationJob(registrationId);
  if (existing) return existing;

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

export async function getLiveCertificationJobForRegistration(registrationId: string) {
  return findLiveCertificationJob(registrationId);
}

export async function expireStalePendingCertificationJob(jobId: string) {
  const job = certificationJobs.get(jobId);
  if (!job || job.status !== 'pending' || Date.parse(job.nonceExpiresAt) >= Date.now()) return false;
  job.status = 'expired';
  certificationJobs.set(jobId, job);
  return true;
}

export async function submitCertificationTranscript(
  jobId: string,
  transcript: NonNullable<CertificationJob['transcript']>,
  submittedAt: string) {
  const job = certificationJobs.get(jobId);
  // Expiry is part of the decisive check, mirroring the db predicate — a request that read an
  // unexpired nonce may not land its transcript after the deadline.
  if (!job || job.status !== 'pending' || Date.parse(job.nonceExpiresAt) <= Date.now()) return false;
  job.transcript = transcript;
  job.status = 'submitted';
  job.submittedAt = submittedAt;
  certificationJobs.set(jobId, job);
  return true;
}

export async function claimCertificationJobForJudging(jobId: string, judgeToken: string, leaseMs: number) {
  const job = certificationJobs.get(jobId);
  if (!job || job.status !== 'submitted') return null;
  job.status = 'judging';
  job.judgeStartedAt = new Date().toISOString();
  job.judgeToken = judgeToken;
  job.judgeClaimExpiresAt = new Date(Date.now() + leaseMs).toISOString();
  certificationJobs.set(jobId, job);
  return job;
}

export async function renewCertificationJudgeLease(jobId: string, judgeToken: string, leaseMs: number) {
  const job = certificationJobs.get(jobId);
  if (!job || job.status !== 'judging' || job.judgeToken !== judgeToken) return false;
  job.judgeClaimExpiresAt = new Date(Date.now() + leaseMs).toISOString();
  certificationJobs.set(jobId, job);
  return true;
}

export async function completeCertificationJudging(
  jobId: string,
  judgeToken: string,
  verdict: { judgeCompletedAt: string; judgeModel: string; judgeResponse: Record<string, unknown> }) {
  const job = certificationJobs.get(jobId);
  if (!job || job.status !== 'judging' || job.judgeToken !== judgeToken) return false;
  job.status = 'completed';
  job.judgeCompletedAt = verdict.judgeCompletedAt;
  job.judgeModel = verdict.judgeModel;
  job.judgeResponse = verdict.judgeResponse;
  certificationJobs.set(jobId, job);
  return true;
}

export async function failCertificationJudging(jobId: string, judgeToken: string, errorMessage: string) {
  const job = certificationJobs.get(jobId);
  if (!job || job.status !== 'judging' || job.judgeToken !== judgeToken) return false;
  job.status = 'failed';
  job.errorMessage = errorMessage;
  certificationJobs.set(jobId, job);
  return true;
}

/** See the db twin: pre-claim unjudgeable-job retirement, CAS on `submitted`. */
export async function failUnjudgeableCertificationJob(jobId: string, errorMessage: string) {
  const job = certificationJobs.get(jobId);
  if (!job || job.status !== 'submitted') return false;
  job.status = 'failed';
  job.errorMessage = errorMessage;
  certificationJobs.set(jobId, job);
  return true;
}

/** See the db store's LEGACY_JUDGING_GRACE_MS — same value, same reasoning. */
const LEGACY_JUDGING_GRACE_MS = 30 * 60 * 1000;

/** A judging job's effective expiry: its lease, or (leaseless legacy shape) its start plus grace. */
function judgingReclaimableAt(job: CertificationJob): number {
  if (job.judgeClaimExpiresAt) return Date.parse(job.judgeClaimExpiresAt);
  const startedAt = job.judgeStartedAt ?? job.submittedAt ?? job.createdAt;
  return Date.parse(startedAt) + LEGACY_JUDGING_GRACE_MS;
}

export async function reclaimExpiredCertificationJobs(limit: number = 20) {
  const now = Date.now();
  // Oldest effective expiry first, matching the db store's ORDER BY — insertion order would let a
  // long-lapsed job starve behind newer ones whenever lapsed jobs exceed the batch.
  const lapsed = Array.from(certificationJobs.values())
    .filter(j => j.status === 'judging' && judgingReclaimableAt(j) < now)
    .sort((a, b) => judgingReclaimableAt(a) - judgingReclaimableAt(b))
    .slice(0, limit);
  for (const job of lapsed) {
    job.status = 'submitted';
    job.judgeToken = undefined;
    job.judgeClaimExpiresAt = undefined;
    certificationJobs.set(job.id, job);
  }
  return lapsed;
}

export async function listStaleSubmittedCertificationJobs(olderThanMs: number, limit: number = 20) {
  const cutoff = Date.now() - olderThanMs;
  return Array.from(certificationJobs.values())
    .filter(j => j.status === 'submitted' && j.judgeToken === undefined
      && j.submittedAt !== undefined && Date.parse(j.submittedAt) < cutoff)
    .sort((a, b) => Date.parse(a.submittedAt!) - Date.parse(b.submittedAt!))
    .slice(0, limit);
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

// `updateCertificationJob` and `getPendingCertificationJobs` were deleted with C22 — see the db
// store's note: every status transition goes through a conditional statement now, and an unfenced
// blanket writer must not survive to bypass the judging fence.

// ==================== Multi-Agent Evaluation Sessions (base) ====================
