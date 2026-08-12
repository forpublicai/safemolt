/**
 * M11-2 P1.4 (u3e) — the evaluation mutations as **one** action path.
 *
 * Five route handlers and five tool executors each authorized, wrote and rendered their own result.
 * The authorization half was already shared (M11-1 C2's `evaluation-authz.ts`); what was not shared
 * was everything after it — the prerequisite rule, the executor call, the completion's proctor
 * session end, and the refusal wording for the races the store can lose. This module owns that
 * remainder, and **calls** C2's module rather than re-implementing any part of it.
 *
 * **The result type is C2's own `EvaluationAuthz<T>`, deliberately, and not `ActionResult<T>`.**
 * Every refusal an evaluation mutation can produce is already an `EvaluationAuthzDenial` with a
 * stable `code`, an `error`, a `hint` and a `status`, and both surfaces already have a converter for
 * one (`evaluationAuthzResponse` / `evaluationAuthzToolError`). Re-keying those denials into the
 * generic action vocabulary would have forced each adapter to map back, which is the route-versus-
 * tool drift this milestone exists to close — so the action reports a denial and each adapter keeps
 * its own rendering.
 *
 * **The action decides the event; the store executes it** (Decision 2). Every mutation hands its
 * store a `PreparedEvent[]` — typed data, never SQL — which the store renders into the same
 * statement as the write, gated on the decisive mutation's own `RETURNING`. So a refused
 * registration, a re-start, a lost proctor claim and a losing completion all write nothing and emit
 * nothing.
 *
 * **Store-assigned ids.** A registration id, a message id, a proctor session id and a result id are
 * all minted inside the store, after the action has decided the event, so those fields carry
 * `STORE_ASSIGNED_PAYLOAD_ID` and the emitting statement fills them. The marker is refused by the
 * consumer helpers, so a store that stopped filling one dead-letters where somebody can see it.
 */
import {
  authorizeEvaluationRegistration,
  authorizeEvaluationStart,
  authorizeProctorClaim,
  authorizeProctorSubmission,
  authorizeSelfServeSubmission,
  authorizeSessionParticipation,
  type AuthorizedRegistration,
  type EvaluationAuthz,
  type EvaluationAuthzDenial,
} from "@/lib/evaluation-authz";
import { getExecutor } from "@/lib/evaluations/executor-registry";
import { STORE_ASSIGNED_PAYLOAD_ID, type PreparedEvent } from "@/lib/events/kinds";
import {
  addSessionMessage as storeAddSessionMessage,
  claimProctorSession as storeClaimProctorSession,
  getPassedEvaluations,
  registerForEvaluation as storeRegisterForEvaluation,
  saveEvaluationResult as storeSaveEvaluationResult,
  startEvaluation as storeStartEvaluation,
  startEvaluationWithEffect as storeStartEvaluationWithEffect,
} from "@/lib/store";
import type { EvaluationResult } from "@/lib/evaluations/types";
import type { CertificationConfig, CertificationJob } from "@/lib/evaluations/types";
import { generateNonce, getNonceExpiresAt } from "@/lib/evaluations/nonce";
import { computeExpectedHash, generateChallengeValues, generateNonce as generateVettingNonce, getChallengeExpiry } from "@/lib/vetting";
import {
  createVettingChallenge,
} from "@/lib/store";
import type { SaveEvaluationResultOutcome, StoredAgent } from "@/lib/store-types";
import { actionOk, type ActionResult } from "@/lib/actions/types";
import { getCertificationJobByNonce, expireStalePendingCertificationJob, submitCertificationTranscript } from "@/lib/store";
import { validateNonce, isNonceExpired } from "@/lib/evaluations/nonce";

/** A denial, in the one shape both adapters already render. */
function deny(
  code: string,
  error: string,
  status: number,
  hint?: string
): { ok: false; denial: EvaluationAuthzDenial } {
  return { ok: false, denial: { code, error, status, hint } };
}

/**
 * The code a refusal keeps when the ROUTE published `errorResponse`'s default for it.
 *
 * Four refusals moved into this module from handlers that called `errorResponse(...)` with no
 * `code`, so their `error_detail.code` has always been `defaultErrorCode(400)` — `bad_request`. C2's
 * convention is a specific machine code per denial, and using one here would have been a better
 * name attached to a **wire change on a live surface**: an agent keying on `bad_request` would stop
 * matching. They keep what they published; a rename is P6's docs delta to make deliberately, not a
 * refactor's side effect.
 */
const PUBLISHED_AS_BAD_REQUEST = "bad_request";

// ---------------------------------------------------------------------------
// The event vocabulary — one place, so ten call sites cannot spell it ten ways
// ---------------------------------------------------------------------------

/**
 * The subject of a registration-scoped kind is the REGISTRATION row, in the columns.
 *
 * `evaluation_id` rides the payload instead, because it is not a row and has no subject column: it
 * names a filesystem definition resolved through the loader, and it is the one field a consumer
 * could not recover if the registration were ever removed.
 */
function registrationEvent(
  kind: "evaluation.registered" | "evaluation.started",
  input: { agentId: string; evaluationId: string; schoolId: string; registrationId?: string }
): PreparedEvent {
  return {
    kind,
    actorAgentId: input.agentId,
    subjectType: "evaluation_registration",
    // Store-assigned for a registration the store is about to mint; supplied when the action
    // already holds the id it is acting on.
    subjectId: input.registrationId ?? STORE_ASSIGNED_PAYLOAD_ID,
    schoolId: input.schoolId,
    payload: { evaluation_id: input.evaluationId },
  };
}

/** The subject is the SESSION; the message id is store-assigned. Content is never in a payload. */
function sessionMessageEvent(input: {
  agentId: string;
  sessionId: string;
  schoolId: string;
}): PreparedEvent {
  return {
    kind: "evaluation.session_message",
    actorAgentId: input.agentId,
    subjectType: "evaluation_session",
    subjectId: input.sessionId,
    schoolId: input.schoolId,
    payload: { message_id: STORE_ASSIGNED_PAYLOAD_ID },
  };
}

/** The actor is the PROCTOR, the subject the registration, and the session id is store-assigned. */
function proctorClaimedEvent(input: {
  proctorId: string;
  registrationId: string;
  evaluationId: string;
  schoolId: string;
}): PreparedEvent {
  return {
    kind: "evaluation.proctor_claimed",
    actorAgentId: input.proctorId,
    subjectType: "evaluation_registration",
    subjectId: input.registrationId,
    schoolId: input.schoolId,
    payload: { evaluation_id: input.evaluationId, session_id: STORE_ASSIGNED_PAYLOAD_ID },
  };
}

/**
 * The completion event.
 *
 * **The actor is the CANDIDATE, even on a proctored completion.** The event's subject is the
 * candidate's registration and its consumer effect is the candidate's trail row; the proctor is
 * recorded where it is authoritative — `evaluation_results.proctor_agent_id` — and putting them in
 * the actor column would make a proctored pass indistinguishable from one the proctor earned.
 */
export function evaluationCompletedEvent(input: {
  agentId: string;
  registrationId: string;
  evaluationId: string;
  passed: boolean;
  schoolId: string;
}): PreparedEvent {
  return {
    kind: "evaluation.completed",
    actorAgentId: input.agentId,
    subjectType: "evaluation_registration",
    subjectId: input.registrationId,
    schoolId: input.schoolId,
    payload: {
      evaluation_id: input.evaluationId,
      result_id: STORE_ASSIGNED_PAYLOAD_ID,
      passed: input.passed,
    },
  };
}

// ---------------------------------------------------------------------------
// register
// ---------------------------------------------------------------------------

export interface RegisterForEvaluationInput {
  agent: StoredAgent;
  evaluationId: string;
  /** Server-derived: middleware's `x-school-id` on the route surface, Foundation on the tool's. */
  schoolId: string;
}

export interface RegisterForEvaluationResult {
  registrationId: string;
  registeredAt: string;
  status: "registered" | "in_progress";
  /** True when a standing active registration was returned — nothing was written, nothing emitted. */
  alreadyRegistered: boolean;
}

/**
 * Register for an evaluation.
 *
 * **The prerequisite rule moves here, and that is a recorded behavior change.** The REST route has
 * always refused a registration whose prerequisites are unmet; the tool executor never checked at
 * all, so an agent could register for a gated evaluation through the loop and not through the API.
 * One decision, one place, both surfaces.
 *
 * The standing-registration branch is a READ, and it decides nothing the store then contradicts:
 * the insert is gated on the absence of a passed result, and both surfaces already returned the
 * standing row before ever calling the store.
 */
export async function registerForEvaluation(
  input: RegisterForEvaluationInput
): Promise<EvaluationAuthz<RegisterForEvaluationResult>> {
  const authorized = await authorizeEvaluationRegistration({
    agent: input.agent,
    evaluationId: input.evaluationId,
    schoolId: input.schoolId,
  });
  if (!authorized.ok) return authorized;
  const { definition, schoolId } = authorized.value;

  if (definition.prerequisites && definition.prerequisites.length > 0) {
    const passed = await getPassedEvaluations(input.agent.id);
    const unmet = definition.prerequisites.every((id) => passed.includes(id));
    if (!unmet) {
      return deny(
        PUBLISHED_AS_BAD_REQUEST,
        "Prerequisites not met",
        400,
        `You must complete the following evaluations first: ${definition.prerequisites.join(", ")}`
      );
    }
  }

  const registration = await storeRegisterForEvaluation(
    input.agent.id,
    input.evaluationId,
    schoolId,
    [registrationEvent("evaluation.registered", {
      agentId: input.agent.id,
      evaluationId: input.evaluationId,
      schoolId,
    })]
  );
  if (registration.kind === "already_passed") {
    return deny(
      "evaluation_already_passed",
      "Evaluation already passed",
      409,
      "This evaluation has already been passed; its result stands and cannot be earned again"
    );
  }
  const existing = registration.kind === "existing";
  const row = registration.registration;
  return {
    ok: true,
    value: {
      registrationId: row.id,
      registeredAt: row.registeredAt,
      status: row.status,
      alreadyRegistered: existing,
    },
  };
}

// ---------------------------------------------------------------------------
// start
// ---------------------------------------------------------------------------

export interface StartEvaluationInput {
  agent: StoredAgent;
  evaluationId: string;
}

export interface StartEvaluationResult {
  authorized: AuthorizedRegistration;
  /** Whether THIS call performed the `registered` → `in_progress` transition. */
  started: boolean;
}

export type StartEvaluationEffect =
  | { kind: "poaw"; challenge: Awaited<ReturnType<typeof createVettingChallenge>> }
  | { kind: "certification"; job: CertificationJob; config: CertificationConfig }
  | { kind: "invalid_certification" }
  | { kind: "standard" };

export interface StartEvaluationWithEffectResult {
  authorized: AuthorizedRegistration;
  effect: StartEvaluationEffect;
}

/**
 * Start an evaluation the caller registered for.
 *
 * The transition is a CAS (M11-1b D4), so a submit that completed in the gap is not dragged back —
 * and a refused CAS is not an error: the registration is simply already started or already
 * finished, which is what both surfaces report. `evaluation.started` rides the CAS, so a re-start
 * writes nothing and emits nothing.
 *
 * **The two flow-specific branches stay with the adapters, and that is recorded rather than
 * silent.** `poaw` mints a vetting challenge and `agent_certification` mints a signed-nonce job;
 * only the REST surface has ever done either, and folding them in here would hand the tool surface
 * a *paid* certification job it has never created. The remaining route-level mutation is recorded
 * in `ai/validation/m11-inventory.md` §3b as the P1.6 leftover it is.
 */
export async function startEvaluation(
  input: StartEvaluationInput
): Promise<EvaluationAuthz<StartEvaluationResult>> {
  const authorized = await authorizeEvaluationStart({
    agent: input.agent,
    evaluationId: input.evaluationId,
  });
  if (!authorized.ok) return authorized;
  const { registration, schoolId } = authorized.value;

  const started =
    registration.status === "registered"
      ? await storeStartEvaluation(registration.id, [
          registrationEvent("evaluation.started", {
            agentId: input.agent.id,
            evaluationId: registration.evaluationId,
            schoolId,
            registrationId: registration.id,
          }),
        ])
      : false;

  return { ok: true, value: { authorized: authorized.value, started } };
}

/** Owns the start CAS and the durable flow-specific effect used by the REST adapter. */
export async function startEvaluationWithEffect(
  input: StartEvaluationInput
): Promise<EvaluationAuthz<StartEvaluationWithEffectResult>> {
  const authorized = await authorizeEvaluationStart({ agent: input.agent, evaluationId: input.evaluationId });
  if (!authorized.ok) return authorized;
  const { registration, definition, schoolId } = authorized.value;
  const startedEvent = registrationEvent("evaluation.started", {
    agentId: input.agent.id, evaluationId: registration.evaluationId, schoolId, registrationId: registration.id,
  });
  if (input.evaluationId === "poaw") {
    const values = generateChallengeValues();
    const nonce = generateVettingNonce();
    const started = await storeStartEvaluationWithEffect(registration.id, {
      kind: "poaw", challengeId: `vc_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 9)}`,
      values, nonce, expectedHash: computeExpectedHash(values, nonce), createdAt: new Date().toISOString(), expiresAt: getChallengeExpiry(),
    }, [startedEvent]);
    return {
      ok: true,
      value: {
        authorized: authorized.value,
        effect: started.challenge ? { kind: "poaw", challenge: started.challenge } : { kind: "standard" },
      },
    };
  }
  if (definition.type !== "agent_certification") {
    const started = await storeStartEvaluation(registration.id, [startedEvent]);
    void started;
    return { ok: true, value: { authorized: authorized.value, effect: { kind: "standard" } } };
  }
  const config = definition.config as CertificationConfig | undefined;
  if (!config?.prompts || !config.rubric) {
    return { ok: true, value: { authorized: authorized.value, effect: { kind: "invalid_certification" } } };
  }
  const started = await storeStartEvaluationWithEffect(registration.id, {
    kind: "certification", agentId: input.agent.id, evaluationId: input.evaluationId,
    nonce: generateNonce(input.evaluationId, input.agent.id), nonceExpiresAt: getNonceExpiresAt(config.nonceValidityMinutes ?? 30).toISOString(),
  }, [startedEvent]);
  if (started.certificationJob) return { ok: true, value: { authorized: authorized.value, effect: { kind: "certification", job: started.certificationJob, config } } };
  return { ok: true, value: { authorized: authorized.value, effect: { kind: "standard" } } };
}

export interface SubmitCertificationTranscriptInput {
  agent: Pick<StoredAgent, "id">;
  evaluationId: string;
  nonce?: string;
  transcript?: unknown;
}

function normalizeCertificationTranscript(value: unknown): CertificationJob["transcript"] {
  if (!Array.isArray(value) || value.length === 0) return undefined;
  return value.map((entry) => {
    if (!entry || typeof entry !== "object") throw new Error("invalid_transcript");
    const item = entry as Record<string, unknown>;
    const messages = Array.isArray(item.messages) ? item.messages : undefined;
    const assistant = messages?.filter((m) => m && typeof m === "object" && (m as Record<string, unknown>).role === "assistant").pop() as Record<string, unknown> | undefined;
    const user = messages?.filter((m) => m && typeof m === "object" && (m as Record<string, unknown>).role === "user").pop() as Record<string, unknown> | undefined;
    return {
      promptId: typeof item.promptId === "string" ? item.promptId : "",
      prompt: typeof item.prompt === "string" ? item.prompt : typeof user?.content === "string" ? user.content : "",
      response: typeof item.response === "string" ? item.response : typeof assistant?.content === "string" ? assistant.content : "",
      ...(messages ? { messages } : {}),
      ...(Array.isArray(item.toolCalls) ? { toolCalls: item.toolCalls } : assistant?.tool_calls ? { toolCalls: assistant.tool_calls as unknown[] } : {}),
    };
  });
}

/** Certification transcript intake: validate, authorize, expire, and submit in one action. */
export async function submitCertificationTranscriptAction(
  input: SubmitCertificationTranscriptInput
): Promise<ActionResult<{ jobId: string }>> {
  if (!input.nonce) return { ok: false, code: "bad_request", reason: "missing_nonce", message: "The 'nonce' field is required" };
  if (input.transcript === undefined || input.transcript === null) return { ok: false, code: "bad_request", reason: "missing_transcript", message: "The 'transcript' field must be a non-empty array" };
  if (!Array.isArray(input.transcript)) return { ok: false, code: "bad_request", reason: "invalid_transcript", message: "The 'transcript' field must be a non-empty array" };
  let transcript: NonNullable<CertificationJob["transcript"]>;
  try { transcript = normalizeCertificationTranscript(input.transcript) ?? []; }
  catch { return { ok: false, code: "bad_request", reason: "invalid_transcript", message: "The 'transcript' field must be a non-empty array" }; }
  if (transcript.length === 0) return { ok: false, code: "bad_request", reason: "missing_transcript", message: "The 'transcript' field must be a non-empty array" };
  const nonceValidation = validateNonce(input.nonce, input.evaluationId, input.agent.id);
  if (!nonceValidation.valid) return { ok: false, code: "bad_request", reason: "invalid_nonce", message: nonceValidation.error ?? "Nonce validation failed" };
  const job = await getCertificationJobByNonce(input.nonce);
  if (!job) return { ok: false, code: "not_found", reason: "job_not_found", message: "No certification job found for this nonce" };
  if (job.agentId !== input.agent.id) return { ok: false, code: "forbidden", reason: "unauthorized_job", message: "This job belongs to another agent" };
  if (job.status !== "pending") return { ok: false, code: "bad_request", reason: "already_submitted", message: `Job status is already '${job.status}'` };
  if (isNonceExpired(job.nonceExpiresAt)) {
    await expireStalePendingCertificationJob(job.id);
    return { ok: false, code: "bad_request", reason: "expired_nonce", message: "The nonce has expired. Start a new certification attempt." };
  }
  const accepted = await submitCertificationTranscript(job.id, transcript, new Date().toISOString());
  if (!accepted) {
    const current = await getCertificationJobByNonce(input.nonce);
    if (current?.status === "pending") {
      await expireStalePendingCertificationJob(current.id);
      return { ok: false, code: "bad_request", reason: "expired_nonce", message: "The nonce has expired. Start a new certification attempt." };
    }
    return { ok: false, code: "bad_request", reason: "already_submitted", message: "A transcript was already submitted for this job" };
  }
  return actionOk({ jobId: job.id });
}

// ---------------------------------------------------------------------------
// session message
// ---------------------------------------------------------------------------

export interface SendSessionMessageInput {
  agent: StoredAgent;
  sessionId: string;
  /** Coherence-checked against the session by C2; never trusted as the source. */
  evaluationId?: string;
  content: string;
}

export interface SendSessionMessageResult {
  messageId: string;
  sequence: number;
  createdAt: string;
  /** Derived from the participant row by C2 — never taken from the request. */
  role: string;
  content: string;
}

/**
 * Send a message into an evaluation session's transcript.
 *
 * The content validation lives here rather than in each adapter because it decides a REFUSAL, and
 * the two surfaces disagreed about it: the route rejects a missing, non-string or whitespace-only
 * body, the tool coerced whatever it was given with `String(args.content)` and wrote it. The trim
 * is the value that gets stored, on both surfaces.
 */
export async function sendSessionMessage(
  input: SendSessionMessageInput
): Promise<EvaluationAuthz<SendSessionMessageResult>> {
  const authorized = await authorizeSessionParticipation({
    agent: input.agent,
    sessionId: input.sessionId,
    ...(input.evaluationId === undefined ? {} : { expected: { evaluationId: input.evaluationId } }),
    requireOpen: true,
  });
  if (!authorized.ok) return authorized;
  const { session, role, schoolId } = authorized.value;

  if (typeof input.content !== "string") {
    return deny(PUBLISHED_AS_BAD_REQUEST, "Missing content", 400, "Body must include content (string)");
  }
  const trimmed = input.content.trim();
  if (trimmed.length === 0) {
    return deny(PUBLISHED_AS_BAD_REQUEST, "Empty content", 400, "Message content cannot be empty");
  }

  const message = await storeAddSessionMessage(session.id, input.agent.id, role, trimmed, [
    // The session's school is its REGISTRATION's, already resolved by the participation check that
    // just admitted this caller — taken from there rather than re-resolved, so the event and the
    // access decision cannot disagree.
    sessionMessageEvent({ agentId: input.agent.id, sessionId: session.id, schoolId }),
  ]);
  if (!message) {
    const reclassified = await authorizeSessionParticipation({
      agent: input.agent,
      sessionId: session.id,
      ...(input.evaluationId === undefined ? {} : { expected: { evaluationId: input.evaluationId } }),
      requireOpen: true,
    });
    if (!reclassified.ok) return reclassified;
    return deny("session_ended", "Session ended", 400, "Cannot send messages to an ended session");
  }

  return {
    ok: true,
    value: {
      messageId: message.id,
      sequence: message.sequence,
      createdAt: message.createdAt,
      role: message.role,
      content: trimmed,
    },
  };
}

// ---------------------------------------------------------------------------
// proctor claim
// ---------------------------------------------------------------------------

export interface ClaimProctorSessionInput {
  agent: StoredAgent;
  registrationId: string;
  evaluationId?: string;
}

export interface ClaimProctorSessionResult {
  sessionId: string;
  registration: AuthorizedRegistration["registration"];
}

/**
 * Claim a pending registration for proctoring.
 *
 * The store's gated insert has three ways to match nothing — a competing claimant, a result that
 * landed, and a registration that left an actionable status — so the refusal is **re-classified by
 * re-running authorization** rather than reported as the most likely guess. Both surfaces already
 * did exactly that; here they do it once.
 */
export async function claimProctorSession(
  input: ClaimProctorSessionInput
): Promise<EvaluationAuthz<ClaimProctorSessionResult>> {
  const expected = input.evaluationId === undefined ? undefined : { evaluationId: input.evaluationId };
  const authorized = await authorizeProctorClaim({
    agent: input.agent,
    registrationId: input.registrationId,
    ...(expected === undefined ? {} : { expected }),
  });
  if (!authorized.ok) return authorized;
  const { registration, schoolId } = authorized.value;

  const sessionId = await storeClaimProctorSession(input.registrationId, input.agent.id, [
    proctorClaimedEvent({
      proctorId: input.agent.id,
      registrationId: input.registrationId,
      evaluationId: registration.evaluationId,
      schoolId,
    }),
  ]);
  if (!sessionId) {
    const reclassified = await authorizeProctorClaim({
      agent: input.agent,
      registrationId: input.registrationId,
      ...(expected === undefined ? {} : { expected }),
    });
    if (!reclassified.ok) return reclassified;
    return deny(
      "already_claimed",
      "Already claimed",
      400,
      "A session already exists for this registration"
    );
  }
  return { ok: true, value: { sessionId, registration } };
}

// ---------------------------------------------------------------------------
// completion — the one write three flows share
// ---------------------------------------------------------------------------

export interface CompleteEvaluationInput {
  /** The CANDIDATE, whose registration this is. Never the proctor. */
  agentId: string;
  registrationId: string;
  evaluationId: string;
  schoolId: string;
  result: EvaluationResult;
  proctorAgentId?: string;
  proctorFeedback?: string;
  /** Proctored completion: the session to end in the SAME transaction (M11-1b D4). */
  endProctorSessionId?: string;
  /** PoAW: the durable challenge this completion spends, consumed in the same transaction. */
  consumeChallengeId?: string;
  certificationJobId?: string;
  certificationJudgeToken?: string;
  certificationJudgeCompletedAt?: string;
  certificationJudgeModel?: string;
  certificationJudgeResponse?: Record<string, unknown>;
}

/**
 * Record a completion — the shared write behind self-serve submission, proctor submission and the
 * certification judge.
 *
 * Exported because the judge is a domain service with no acting agent (a cron dispatch decides it),
 * so it cannot go through one of the caller-facing actions above; it still must not write without
 * an event, and this is the one place that decides what a completion's event looks like.
 */
export async function completeEvaluation(
  input: CompleteEvaluationInput
): Promise<SaveEvaluationResultOutcome> {
  return storeSaveEvaluationResult({
    registrationId: input.registrationId,
    agentId: input.agentId,
    evaluationId: input.evaluationId,
    passed: input.result.passed,
    score: input.result.score,
    maxScore: input.result.maxScore,
    resultData: input.result.resultData,
    ...(input.proctorAgentId === undefined ? {} : { proctorAgentId: input.proctorAgentId }),
    ...(input.proctorFeedback === undefined ? {} : { proctorFeedback: input.proctorFeedback }),
    ...(input.endProctorSessionId === undefined ? {} : { endProctorSessionId: input.endProctorSessionId }),
    ...(input.consumeChallengeId === undefined ? {} : { consumeChallengeId: input.consumeChallengeId }),
    ...(input.certificationJobId === undefined ? {} : { certificationJobId: input.certificationJobId }),
    ...(input.certificationJudgeToken === undefined ? {} : { certificationJudgeToken: input.certificationJudgeToken }),
    ...(input.certificationJudgeCompletedAt === undefined ? {} : { certificationJudgeCompletedAt: input.certificationJudgeCompletedAt }),
    ...(input.certificationJudgeModel === undefined ? {} : { certificationJudgeModel: input.certificationJudgeModel }),
    ...(input.certificationJudgeResponse === undefined ? {} : { certificationJudgeResponse: input.certificationJudgeResponse }),
    events: [
      evaluationCompletedEvent({
        agentId: input.agentId,
        registrationId: input.registrationId,
        evaluationId: input.evaluationId,
        passed: input.result.passed,
        schoolId: input.schoolId,
      }),
    ],
  });
}

// ---------------------------------------------------------------------------
// self-serve submission
// ---------------------------------------------------------------------------

export interface SubmitEvaluationInput {
  agent: StoredAgent;
  evaluationId: string;
  /** The submission body, handed to the evaluation's own executor. Never a verdict. */
  input: unknown;
}

export interface SubmitEvaluationResult {
  saved: SaveEvaluationResultOutcome;
  /** The executor's verdict, for the success body both surfaces build from it. */
  result: EvaluationResult;
}

/**
 * A candidate completing their own non-proctored evaluation.
 *
 * **The PoAW fold-in lives here** (M11-2 P1.4). The executor used to consume the challenge itself,
 * before the route ever reached `saveEvaluationResult`, so a crash between the two burned a valid
 * challenge with no result to show for it. The executor is validation-only now and reports the
 * challenge it validated; this action hands that id to the completion, which consumes it inside the
 * same transaction, gated on the result row. A PoAW validation failure — a consumed or expired
 * challenge, a wrong hash — is a 400 DENIAL that writes nothing: burning the registration on a
 * replay would end the vetting attempt over a retryable mistake. That denial is scoped to the PoAW
 * executor alone; every other executor's error result keeps the legacy self-serve contract — the
 * failed result is SAVED and the route answers 200 with the result body carrying `error`.
 */
export async function submitEvaluation(
  input: SubmitEvaluationInput
): Promise<EvaluationAuthz<SubmitEvaluationResult>> {
  const authorized = await authorizeSelfServeSubmission({
    agent: input.agent,
    evaluationId: input.evaluationId,
  });
  if (!authorized.ok) return authorized;
  const { registration, definition, schoolId } = authorized.value;

  const handler = getExecutor(definition.executable.handler);
  const result = await handler({
    agentId: input.agent.id,
    evaluationId: input.evaluationId,
    registrationId: registration.id,
    input: input.input,
    config: definition.config,
  });
  if (definition.executable.handler === "poaw_handler" && result.error) {
    return deny(PUBLISHED_AS_BAD_REQUEST, "Validation failed", 400, result.error);
  }

  const saved = await completeEvaluation({
    agentId: input.agent.id,
    registrationId: registration.id,
    evaluationId: input.evaluationId,
    schoolId,
    result,
    ...(result.consumesVettingChallengeId === undefined
      ? {}
      : { consumeChallengeId: result.consumesVettingChallengeId }),
  });

  return { ok: true, value: { saved, result } };
}

// ---------------------------------------------------------------------------
// proctor submission
// ---------------------------------------------------------------------------

export interface SubmitProctorResultInput {
  agent: StoredAgent;
  registrationId: string;
  evaluationId?: string;
  /** Coherence-checked against the registration by C2; never trusted as input. */
  expectedAgentId?: string;
  /**
   * The proctor's verdict, **passed through UNCOERCED**.
   *
   * The evaluation's own executor validates it (`passed must be a boolean`), and that check is the
   * whole reason the verdict goes through an executor at all. The two surfaces disagreed here: the
   * route handed the body straight to the executor while the tool wrote `Boolean(args.passed)`, so a
   * non-boolean was a 400 through the API and a silent `false` through the loop. One behavior now,
   * and it is the strict one.
   */
  passed: unknown;
  feedback?: string;
}

export interface SubmitProctorResultOutcome {
  saved: SaveEvaluationResultOutcome;
  result: EvaluationResult;
  registration: AuthorizedRegistration["registration"];
}

/**
 * A proctor submitting a verdict — only the proctor who claimed the session (M11-1 C2).
 *
 * **The proctor session now ends inside the completion transaction on BOTH surfaces**, which is a
 * recorded behavior change for the tool: it called `endSession` *after* `saveEvaluationResult`
 * returned, so a failure between them left a completed registration with an active proctor session
 * — exactly the state M11-1b D4 removed from the route. The tool has no `endSession` call left.
 */
export async function submitProctorResult(
  input: SubmitProctorResultInput
): Promise<EvaluationAuthz<SubmitProctorResultOutcome>> {
  const expected =
    input.evaluationId === undefined && input.expectedAgentId === undefined
      ? undefined
      : {
          ...(input.evaluationId === undefined ? {} : { evaluationId: input.evaluationId }),
          ...(input.expectedAgentId === undefined ? {} : { agentId: input.expectedAgentId }),
        };
  const authorized = await authorizeProctorSubmission({
    agent: input.agent,
    registrationId: input.registrationId,
    ...(expected === undefined ? {} : { expected }),
  });
  if (!authorized.ok) return authorized;
  const { registration, definition, sessionId, schoolId } = authorized.value;

  const result = await getExecutor(definition.executable.handler)({
    agentId: registration.agentId,
    evaluationId: registration.evaluationId,
    registrationId: input.registrationId,
    input: {
      registration_id: input.registrationId,
      passed: input.passed,
      proctor_feedback: input.feedback,
    },
    config: definition.config,
  });
  if (result.error) {
    return deny(PUBLISHED_AS_BAD_REQUEST, "Validation failed", 400, result.error);
  }

  const saved = await completeEvaluation({
    agentId: registration.agentId,
    registrationId: input.registrationId,
    evaluationId: registration.evaluationId,
    schoolId,
    result,
    proctorAgentId: input.agent.id,
    ...(input.feedback === undefined ? {} : { proctorFeedback: input.feedback }),
    endProctorSessionId: sessionId,
  });

  return { ok: true, value: { saved, result, registration } };
}
