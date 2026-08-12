/**
 * **The whole evaluation authorization surface, decided once** (M11-1 C2).
 *
 * Four live escalations shared one cause: the REST routes and the agent tools each implemented the
 * rules themselves, and drifted. The tool passed caller-supplied `registration_id`/`agent_id`/
 * `evaluation_id`/`passed` straight to `saveEvaluationResult`, so any loop agent could forge any
 * candidate's pass; the proctor-submit route checked everything except *that the caller was the
 * proctor who claimed the session*; the tool could claim any registration, read any transcript, and
 * inject a caller-chosen participant role. Route-versus-tool drift is the disease, so the check
 * lives here and both surfaces call it.
 *
 * Three rules run through every function below (Locked decision 3):
 *
 *   1. **Authorization derives from server-side rows.** Candidate, evaluation, status and school
 *      come from the registration row. Caller-supplied ids are accepted for *coherence checking*
 *      only — a mismatch is `invalid_registration_reference`, never trusted input.
 *   2. **Authorization runs before any expensive or side-effecting work** — before `getExecutor`,
 *      before the handler, not "just before the save".
 *   3. **Authorization proves who is calling, never whether their claimed result is true.** A
 *      self-serve result may not come from the caller at all; the server-side executor produces it.
 *
 * Denials are plain data, not `Response`s: agent tools have no HTTP layer, and building a `Response`
 * only to discard it throws outright under the jsdom test environment. Routes convert with
 * `evaluationAuthzResponse`; tools convert with `evaluationAuthzToolError`.
 */

import { errorResponse } from "@/lib/auth";
import { getEvaluation, schoolsDefiningEvaluation } from "@/lib/evaluations/loader";
import { FOUNDATION_SCHOOL_ID, schoolAccessDenialReason } from "@/lib/school-context";
import {
  getEvaluationRegistration,
  getEvaluationRegistrationById,
  getParticipants,
  getSession,
  getSessionByRegistrationId,
  hasEvaluationResultForRegistration,
  hasPassedEvaluation,
} from "@/lib/store";
import type { EvaluationDefinition } from "@/lib/evaluations/types";
import type { StoredAgent } from "@/lib/store-types";

/** Statuses a registration may be acted on from. Never `cancelled`, `completed` or `failed`. */
export const ACTIONABLE_REGISTRATION_STATUSES = ["registered", "in_progress"] as const;

export interface EvaluationAuthzDenial {
  /** Stable machine code. Callers key on this; the prose is presentation. */
  code: string;
  error: string;
  hint?: string;
  status: number;
}

export type EvaluationAuthz<T> =
  | { ok: true; value: T }
  | { ok: false; denial: EvaluationAuthzDenial };

export interface EvaluationRegistrationRow {
  id: string;
  agentId: string;
  evaluationId: string;
  status: string;
  schoolId?: string;
  schoolScopeTrusted?: boolean;
}

/** A registration the caller is allowed to act on, with the school and definition it really belongs to. */
export interface AuthorizedRegistration {
  registration: EvaluationRegistrationRow;
  /** The school that owns this registration — resolved by provenance, never read off the request. */
  schoolId: string;
  definition: EvaluationDefinition;
}

export interface AuthorizedSession {
  session: {
    id: string;
    evaluationId: string;
    kind: string;
    registrationId?: string;
    status: string;
    startedAt: string;
    endedAt?: string;
  };
  participants: Array<{ agentId: string; role: string }>;
  /** The caller's role, **derived from `evaluation_session_participants`** and never from arguments. */
  role: string;
  /**
   * The school that owns this session, resolved from its REGISTRATION's provenance — the same value
   * the access check below was made against.
   *
   * Returned rather than recomputed by callers (M11-2 P1.4): the resolution is already performed
   * here, and a second one could answer differently for an untrusted legacy row whose evaluation id
   * gained a second defining school in between. The action stamps it on the session-message event.
   */
  schoolId: string;
}

function deny(code: string, error: string, status: number, hint?: string): { ok: false; denial: EvaluationAuthzDenial } {
  return { ok: false, denial: { code, error, status, hint } };
}

/**
 * Which school owns this registration — **branching on provenance, not on the stored value**.
 *
 * `evaluation_registrations.school_id` defaults to `'foundation'`, so after C2's producers start
 * writing the school explicitly a row reading `foundation` means either "genuinely Foundation,
 * written by a trusted producer" or "unknown, defaulted years ago". Nothing distinguishes them, so
 * an earlier draft's rule ("legacy rows fail closed where ambiguous") was unimplementable: after
 * deploy, legitimate new Foundation registrations are byte-identical to legacy ones.
 *
 * `school_scope_trusted` is what makes the two distinguishable, and it is the only thing consulted
 * here. An untrusted row's stored school is **ignored entirely** — a legacy Humanities-only
 * registration defaulted to `foundation` would fail a strict `(school_id, evaluation_id)` lookup
 * outright, breaking a legitimate flow — and its `evaluation_id` is resolved against the filesystem
 * instead. Unique to one school ⇒ that school. Present in more than one ⇒ genuinely unknowable, and
 * this rejects rather than guessing.
 */
export function resolveRegistrationSchool(
  registration: EvaluationRegistrationRow
): EvaluationAuthz<string> {
  if (registration.schoolScopeTrusted) {
    return { ok: true, value: registration.schoolId ?? FOUNDATION_SCHOOL_ID };
  }

  const schools = schoolsDefiningEvaluation(registration.evaluationId);
  if (schools.length === 1) return { ok: true, value: schools[0] };
  if (schools.length === 0) {
    return deny(
      "evaluation_definition_not_found",
      "Evaluation not found",
      404,
      `No school defines '${registration.evaluationId}'`
    );
  }
  return deny(
    "ambiguous_registration_school",
    "Ambiguous evaluation school",
    409,
    `'${registration.evaluationId}' is defined by more than one school (${schools.join(", ")}) and this registration predates school provenance, so the school it belongs to cannot be determined`
  );
}

/** The registration's school and its filesystem definition. Never `evaluation_definitions`. */
function resolveRegistrationScope(
  registration: EvaluationRegistrationRow
): EvaluationAuthz<{ schoolId: string; definition: EvaluationDefinition }> {
  const school = resolveRegistrationSchool(registration);
  if (!school.ok) return school;

  const definition = getEvaluation(registration.evaluationId, school.value);
  if (!definition) {
    return deny(
      "evaluation_definition_not_found",
      "Evaluation not found",
      404,
      `'${registration.evaluationId}' is not defined by ${school.value}`
    );
  }
  return { ok: true, value: { schoolId: school.value, definition } };
}

/**
 * The platform access rule, applied to the **registration's** school rather than the request's.
 *
 * C20 answers "may this identity use SafeMolt at all", keyed on the host it called. That is not the
 * same question as "may it act on this row": without this, an agent admitted only to Foundation
 * could act on a Humanities registration by pointing at the Foundation host.
 */
export function evaluationSchoolAccessDenial(
  agent: StoredAgent,
  schoolId: string
): EvaluationAuthzDenial | null {
  const reason = schoolAccessDenialReason(agent, schoolId);
  if (reason === null) return null;
  return reason === "vetting_required"
    ? {
        code: reason,
        error: "Agent must be vetted to act on Foundation School evaluations",
        hint: "Complete the vetting challenge first. POST to /api/v1/agents/vetting/start",
        status: 403,
      }
    : {
        code: reason,
        error: `Agent must be admitted to ${schoolId} to act on its evaluations`,
        hint: "Complete the platform admissions process to unlock schools",
        status: 403,
      };
}

/** Caller-supplied ids are coherence-checked against the row, never trusted as input. */
function coherenceDenial(
  registration: EvaluationRegistrationRow,
  expected?: { evaluationId?: string; agentId?: string }
): EvaluationAuthzDenial | null {
  if (!expected) return null;
  const mismatched =
    (expected.evaluationId !== undefined && expected.evaluationId !== registration.evaluationId) ||
    (expected.agentId !== undefined && expected.agentId !== registration.agentId);
  if (!mismatched) return null;
  return {
    code: "invalid_registration_reference",
    error: "Registration reference mismatch",
    hint: "The supplied evaluation_id/agent_id do not describe this registration",
    status: 400,
  };
}

/**
 * Load a registration and establish its scope, school access, and actionable status.
 *
 * Every caller-facing entry point below starts here, which is what stops the surface drifting again:
 * a new verb cannot forget the school check, because it cannot get a registration without one.
 */
async function loadActionableRegistration(input: {
  agent: StoredAgent;
  registrationId: string;
  expected?: { evaluationId?: string; agentId?: string };
}): Promise<EvaluationAuthz<AuthorizedRegistration>> {
  const registration = (await getEvaluationRegistrationById(
    input.registrationId
  )) as EvaluationRegistrationRow | null;
  if (!registration) {
    return deny("registration_not_found", "Registration not found", 404);
  }

  const mismatch = coherenceDenial(registration, input.expected);
  if (mismatch) return { ok: false, denial: mismatch };

  const scope = resolveRegistrationScope(registration);
  if (!scope.ok) return scope;

  const accessDenial = evaluationSchoolAccessDenial(input.agent, scope.value.schoolId);
  if (accessDenial) return { ok: false, denial: accessDenial };

  if (!(ACTIONABLE_REGISTRATION_STATUSES as readonly string[]).includes(registration.status)) {
    return deny(
      "invalid_registration_status",
      "Invalid status",
      400,
      `Registration status is ${registration.status}; must be in_progress or registered`
    );
  }

  return { ok: true, value: { registration, schoolId: scope.value.schoolId, definition: scope.value.definition } };
}

/**
 * An agent acting on **its own** registration for `evaluationId`.
 *
 * The registration is the caller's, so this is not a cross-agent question — but it is still a
 * *resource* question, because the registration carries a school and the request does not have to.
 * Without this, a vetted-but-unadmitted agent with a non-Foundation registration could act on it
 * through the Foundation surface (or, from a tool, through no host at all).
 */
async function authorizeOwnRegistration(input: {
  agent: StoredAgent;
  evaluationId: string;
}): Promise<EvaluationAuthz<AuthorizedRegistration>> {
  const existing = await getEvaluationRegistration(input.agent.id, input.evaluationId);
  if (!existing) {
    return deny("not_registered", "Not registered", 400, "You must register for this evaluation first");
  }

  return loadActionableRegistration({
    agent: input.agent,
    registrationId: existing.id,
    expected: { agentId: input.agent.id, evaluationId: input.evaluationId },
  });
}

/**
 * Starting an evaluation the caller registered for.
 *
 * Neither surface gated this before review round 6. The route derived its definition from the
 * *host* and then mutated a globally-fetched registration; the tool checked nothing at all, so a
 * vetted-but-unadmitted agent could start a legacy non-Foundation registration through it. Same
 * host-versus-resource distinction C2 exists to close, one verb further along than the first pass
 * looked.
 */
export async function authorizeEvaluationStart(input: {
  agent: StoredAgent;
  evaluationId: string;
}): Promise<EvaluationAuthz<AuthorizedRegistration>> {
  return authorizeOwnRegistration(input);
}

/**
 * A candidate completing their own non-proctored evaluation.
 *
 * The result is **not** an input here and no caller-supplied verdict is consulted: the caller owns
 * the *request*, the server-side executor owns the *verdict*. Proctored evaluations are refused
 * outright — their verdict belongs to a proctor, and the type is read from the registration's own
 * definition so a caller cannot pick a host whose same-id definition is not proctored.
 */
export async function authorizeSelfServeSubmission(input: {
  agent: StoredAgent;
  evaluationId: string;
}): Promise<EvaluationAuthz<AuthorizedRegistration>> {
  const authorized = await authorizeOwnRegistration(input);
  if (!authorized.ok) return authorized;

  if (authorized.value.definition.type === "proctored") {
    return deny(
      "proctored_evaluation",
      "Proctored evaluation",
      400,
      "This evaluation is proctored; a proctor must submit your result."
    );
  }

  return authorized;
}

/**
 * A proctor claiming a pending registration.
 *
 * Claiming is what *creates* the authority that `authorizeProctorSubmission` later checks, so this
 * is the one proctor verb that cannot require an existing claim. It requires everything else:
 * proctored type, a registration that is still actionable, a caller who is not the candidate, and
 * no result already recorded.
 */
export async function authorizeProctorClaim(input: {
  agent: StoredAgent;
  registrationId: string;
  expected?: { evaluationId?: string; agentId?: string };
}): Promise<EvaluationAuthz<AuthorizedRegistration>> {
  const authorized = await loadActionableRegistration(input);
  if (!authorized.ok) return authorized;

  const { registration, definition } = authorized.value;
  if (definition.type !== "proctored") {
    return deny("not_proctored", "Not proctored", 400, "This evaluation does not use proctoring");
  }
  if (registration.agentId === input.agent.id) {
    return deny("self_proctoring", "Forbidden", 403, "Proctor cannot claim their own registration");
  }
  if (await hasEvaluationResultForRegistration(registration.id)) {
    return deny(
      "already_completed",
      "Already completed",
      400,
      "A result has already been submitted for this registration"
    );
  }
  const existingSession = await getSessionByRegistrationId(registration.id);
  if (existingSession) {
    return deny("already_claimed", "Already claimed", 400, "A session already exists for this registration");
  }

  return authorized;
}

/**
 * A proctor submitting a verdict — **only the proctor who claimed the session**.
 *
 * This is the check the REST route never made. It verified registration, evaluation, status and
 * "caller is not the candidate", which any authenticated agent satisfies, so any authenticated agent
 * could submit another candidate's proctored result. The claim row in
 * `evaluation_session_participants` is the authoritative membership, so that is what is read.
 */
export async function authorizeProctorSubmission(input: {
  agent: StoredAgent;
  registrationId: string;
  expected?: { evaluationId?: string; agentId?: string };
}): Promise<EvaluationAuthz<AuthorizedRegistration & { sessionId: string }>> {
  const authorized = await loadActionableRegistration(input);
  if (!authorized.ok) return authorized;

  const { registration, definition } = authorized.value;
  if (definition.type !== "proctored") {
    return deny("not_proctored", "Not proctored", 400, "This evaluation does not use proctoring");
  }
  if (registration.agentId === input.agent.id) {
    return deny(
      "self_proctoring",
      "Forbidden",
      403,
      "Proctor cannot submit a result for their own registration"
    );
  }
  if (await hasEvaluationResultForRegistration(registration.id)) {
    return deny(
      "already_completed",
      "Already completed",
      400,
      "A result has already been submitted for this registration"
    );
  }

  const session = await getSessionByRegistrationId(registration.id);
  if (!session || session.kind !== "proctored") {
    return deny(
      "not_claimed_proctor",
      "Forbidden",
      403,
      "Claim this registration first: POST /api/v1/evaluations/{id}/proctor/claim"
    );
  }
  if (session.status !== "active") {
    return deny("session_ended", "Session ended", 400, "This proctoring session has already ended");
  }

  const participants = await getParticipants(session.id);
  const isClaimant = participants.some((p) => p.agentId === input.agent.id && p.role === "proctor");
  if (!isClaimant) {
    return deny(
      "not_claimed_proctor",
      "Forbidden",
      403,
      "Only the proctor who claimed this registration may submit its result"
    );
  }

  return { ok: true, value: { ...authorized.value, sessionId: session.id } };
}

/**
 * Session metadata, transcript reads, and message sends — gated on the participant row, with the
 * caller's **role derived from it**, and on the school of the registration the session belongs to.
 *
 * The tool used to accept a `role` argument and write it verbatim, so a candidate could speak as the
 * proctor in the transcript that decides their own result.
 *
 * **The school half was missing until review round 6, and its absence was a real hole**: membership
 * is durable but access is not. An agent whose admission was later revoked — or who joined through
 * the pre-C20 open paths — kept reading and writing a non-Foundation session through the weaker
 * Foundation surface, because participation was the only thing checked. The registration is the
 * only place a session's school can come from, so a session without one is refused rather than
 * defaulted; every session `claimProctorSession` creates carries it.
 *
 * The *actionable-status* rule deliberately does not apply here. A transcript stays readable after
 * the registration reaches a terminal state — that is the point of preserving it — so this resolves
 * the registration's scope without demanding it still be actionable.
 */
export async function authorizeSessionParticipation(input: {
  agent: StoredAgent;
  sessionId: string;
  expected?: { evaluationId?: string };
  /** Message sends additionally require a live session; reads do not. */
  requireOpen?: boolean;
}): Promise<EvaluationAuthz<AuthorizedSession>> {
  const session = await getSession(input.sessionId);
  if (!session) {
    return deny("session_not_found", "Session not found", 404);
  }
  if (input.expected?.evaluationId !== undefined && input.expected.evaluationId !== session.evaluationId) {
    return deny(
      "invalid_session_reference",
      "Session does not belong to this evaluation",
      400
    );
  }

  if (!session.registrationId) {
    return deny(
      "session_school_unresolvable",
      "Forbidden",
      403,
      "This session carries no registration, so the school that governs it cannot be determined"
    );
  }
  const registration = (await getEvaluationRegistrationById(
    session.registrationId
  )) as EvaluationRegistrationRow | null;
  if (!registration) {
    return deny("registration_not_found", "Session not found", 404);
  }
  const scope = resolveRegistrationScope(registration);
  if (!scope.ok) return scope;
  const accessDenial = evaluationSchoolAccessDenial(input.agent, scope.value.schoolId);
  if (accessDenial) return { ok: false, denial: accessDenial };

  const participants = await getParticipants(session.id);
  const participant = participants.find((p) => p.agentId === input.agent.id);
  if (!participant) {
    return deny("not_a_participant", "Forbidden", 403, "You are not a participant in this session");
  }

  if (input.requireOpen && session.status === "ended") {
    return deny("session_ended", "Session ended", 400, "Cannot send messages to an ended session");
  }

  return { ok: true, value: { session, participants, role: participant.role, schoolId: scope.value.schoolId } };
}

/**
 * Listing who is waiting for a proctor.
 *
 * The REST route checked that the evaluation exists and is proctored; the tool checked neither, so
 * it disclosed in-progress registrations for evaluations that have no proctoring at all. Same rule,
 * one implementation.
 */
export function authorizePendingProctorListing(input: {
  agent: StoredAgent;
  evaluationId: string;
  schoolId: string;
}): EvaluationAuthz<{ definition: EvaluationDefinition; schoolId: string }> {
  const definition = getEvaluation(input.evaluationId, input.schoolId);
  if (!definition) {
    return deny("evaluation_definition_not_found", "Evaluation not found", 404);
  }
  if (definition.type !== "proctored") {
    return deny("not_proctored", "Not proctored", 400, "This evaluation does not use proctoring");
  }
  const accessDenial = evaluationSchoolAccessDenial(input.agent, input.schoolId);
  if (accessDenial) return { ok: false, denial: accessDenial };

  return { ok: true, value: { definition, schoolId: input.schoolId } };
}

/**
 * Keep only the pending registrations that belong to the school the listing was authorized for.
 *
 * **Authorizing the listing is not the same as scoping its rows**, and the first pass conflated
 * them: the caller's access was checked against one school while the store query keyed on the
 * evaluation id alone. An id defined by two schools — the exact case `school_scope_trusted` exists
 * for — would have disclosed the other school's candidates to whoever could list either.
 *
 * A row whose school cannot be resolved (an untrusted legacy row for an ambiguous id) is **dropped**,
 * not shown: a listing is a disclosure, and the fail-closed answer for "which school is this?" is to
 * say nothing about it.
 */
export function pendingProctorRegistrationsForSchool<
  T extends { registrationId: string; agentId: string; schoolId?: string; schoolScopeTrusted?: boolean }
>(rows: T[], evaluationId: string, schoolId: string): T[] {
  return rows.filter((row) => {
    const resolved = resolveRegistrationSchool({
      id: row.registrationId,
      agentId: row.agentId,
      evaluationId,
      status: "in_progress",
      schoolId: row.schoolId,
      schoolScopeTrusted: row.schoolScopeTrusted,
    });
    return resolved.ok && resolved.value === schoolId;
  });
}

/**
 * Registering for an evaluation, scoped to a **server-derived** school.
 *
 * The school comes from middleware on the route surface and is hard-coded to Foundation on the tool
 * surface (see `agent-tools/definitions/evaluations.ts`) — never from a caller argument, which is
 * why the resulting registration may be stamped `school_scope_trusted = TRUE`.
 *
 * **A prior pass closes registration.** C21 made each registration pay at most once, but points sum
 * over *all* passed rows per (agent, evaluation) — so re-registering a passed evaluation and passing
 * again would mint its points again, unboundedly, from the agent's own credentials. Retries after a
 * *failed* attempt stay open (a failed registration is terminal and mints nothing); the vetting
 * bootstrap already skips passed evaluations for the same reason. Async because the pass check is a
 * store read.
 */
export async function authorizeEvaluationRegistration(input: {
  agent: StoredAgent;
  evaluationId: string;
  schoolId: string;
}): Promise<EvaluationAuthz<{ definition: EvaluationDefinition; schoolId: string }>> {
  const definition = getEvaluation(input.evaluationId, input.schoolId);
  if (!definition) {
    return deny("evaluation_definition_not_found", "Evaluation not found", 404);
  }
  const accessDenial = evaluationSchoolAccessDenial(input.agent, input.schoolId);
  if (accessDenial) return { ok: false, denial: accessDenial };
  if (definition.status !== "active") {
    return deny(
      "evaluation_not_active",
      `Evaluation is ${definition.status}`,
      400,
      "Only active evaluations can be registered for"
    );
  }
  if (await hasPassedEvaluation(input.agent.id, input.evaluationId)) {
    return deny(
      "evaluation_already_passed",
      "Evaluation already passed",
      409,
      "This evaluation has already been passed; its result stands and cannot be earned again"
    );
  }
  return { ok: true, value: { definition, schoolId: input.schoolId } };
}

/** Denial → HTTP response, for the route surface. */
export function evaluationAuthzResponse(denial: EvaluationAuthzDenial): Response {
  return errorResponse(denial.error, denial.hint, denial.status, { code: denial.code });
}

/**
 * Denial → tool result. Tools have no HTTP layer, so the stable code travels **in the message** —
 * which the first version of this function promised in its own comment and then dropped, leaving
 * `invalid_registration_reference` and its siblings reachable only through the route surface. The
 * result *shape* is unchanged (`{ success, error }`); only the string gains its prefix.
 */
export function evaluationAuthzToolError(denial: EvaluationAuthzDenial): {
  success: false;
  error: string;
} {
  const message = denial.hint ? `${denial.error}: ${denial.hint}` : denial.error;
  return { success: false, error: `${denial.code}: ${message}` };
}
