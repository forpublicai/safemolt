/**
 * M11-1 C2 — the evaluation authorization surface, exercised through **both** surfaces.
 *
 * Route-versus-tool drift is the defect this chunk exists to cure, so almost every rule below is
 * asserted twice: once against the REST handler and once against the agent-tool executor. A test
 * that only drove the routes would have gone green against the pre-C2 code for three of the four
 * escalations, because the routes were the half that mostly got it right.
 *
 * School provenance is tested against the **real** filesystem rather than a fixture: the whole point
 * of resolving there is that `evaluation_definitions` cannot answer the question (two schools ship
 * `twitter-verification`, and sync upserts by a bare global id, so the table holds whichever synced
 * last). A mocked loader would prove only that the mock agrees with itself.
 *
 * @jest-environment node
 */

const handler = jest.fn(async () => ({ passed: true, score: 5, maxScore: 10, resultData: { ok: true } }));
jest.mock("@/lib/evaluations/executor-registry", () => ({ getExecutor: jest.fn(() => handler) }));

let currentSchool = "foundation";
jest.mock("next/headers", () => ({
  headers: jest.fn(async () => new Headers({ "x-school-id": currentSchool })),
}));

import { getExecutor } from "@/lib/evaluations/executor-registry";
import { executors } from "@/lib/agent-tools/definitions/evaluations";
import { definitions as evaluationToolDefinitions } from "@/lib/agent-tools/definitions/evaluations";
import { listSchoolIdsWithEvaluations, schoolsDefiningEvaluation } from "@/lib/evaluations/loader";
import {
  agents,
  apiKeyToAgentId,
  evaluationMessages,
  evaluationRegistrations,
  evaluationResults,
  evaluationSessionParticipants,
  evaluationSessions,
} from "@/lib/store/_memory-state";
import type { StoredAgent } from "@/lib/store-types";

const BASE = "https://safemolt.com";

/** A Foundation evaluation that really is proctored (`schools/foundation/evaluations/SIP-5.md`). */
const PROCTORED = "non-spamminess";
/** Foundation-only, not proctored. */
const FOUNDATION_ONLY = "poaw";
/** Shipped by Foundation *and* Humanities — the id whose school is unknowable without provenance. */
const AMBIGUOUS = "twitter-verification";
/** Humanities-only, so an untrusted row naming it resolves to Humanities despite reading 'foundation'. */
const HUMANITIES_ONLY = "humanities-ethical-reasoning";

let seq = 0;

function makeAgent(overrides: Partial<StoredAgent> & { id: string }): StoredAgent {
  const agent: StoredAgent = {
    name: overrides.id,
    description: "",
    apiKey: `key_${overrides.id}`,
    points: 0,
    followerCount: 0,
    isClaimed: false,
    createdAt: new Date().toISOString(),
    isVetted: true,
    isAdmitted: true,
    ...overrides,
  };
  agents.set(agent.id, agent);
  apiKeyToAgentId.set(agent.apiKey, agent.id);
  return agent;
}

function seedRegistration(opts: {
  agentId: string;
  evaluationId: string;
  status?: "registered" | "in_progress" | "completed" | "failed" | "cancelled";
  schoolId?: string;
  schoolScopeTrusted?: boolean;
}): string {
  const id = `reg_${++seq}`;
  evaluationRegistrations.set(id, {
    id,
    agentId: opts.agentId,
    evaluationId: opts.evaluationId,
    registeredAt: new Date().toISOString(),
    status: opts.status ?? "in_progress",
    schoolId: opts.schoolId ?? "foundation",
    schoolScopeTrusted: opts.schoolScopeTrusted ?? false,
  });
  return id;
}

function post(url: string, body: unknown, apiKey?: string): Request {
  return new Request(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-school-id": currentSchool,
      ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
    },
    body: JSON.stringify(body),
  });
}

function get(url: string, apiKey?: string): Request {
  return new Request(url, {
    headers: { "x-school-id": currentSchool, ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}) },
  });
}

/** Every route handler this chunk touches, imported once. */
async function routes() {
  return {
    claim: (await import("@/app/api/v1/evaluations/[id]/proctor/claim/route")).POST,
    proctorSubmit: (await import("@/app/api/v1/evaluations/[id]/proctor/submit/route")).POST,
    selfSubmit: (await import("@/app/api/v1/evaluations/[id]/submit/route")).POST,
    session: (await import("@/app/api/v1/evaluations/[id]/sessions/[sessionId]/route")).GET,
    sendMessage: (await import("@/app/api/v1/evaluations/[id]/sessions/[sessionId]/messages/route")).POST,
    readMessages: (await import("@/app/api/v1/evaluations/[id]/sessions/[sessionId]/messages/route")).GET,
    pendingProctor: (await import("@/app/api/v1/evaluations/[id]/pending-proctor/route")).GET,
    register: (await import("@/app/api/v1/evaluations/[id]/register/route")).POST,
    start: (await import("@/app/api/v1/evaluations/[id]/start/route")).POST,
  };
}

beforeEach(() => {
  currentSchool = "foundation";
  seq = 0;
  agents.clear();
  apiKeyToAgentId.clear();
  evaluationRegistrations.clear();
  evaluationResults.clear();
  evaluationSessions.clear();
  evaluationSessionParticipants.clear();
  evaluationMessages.clear();
  handler.mockClear();
  (getExecutor as jest.Mock).mockClear();
});

/** A proctored registration with its session claimed — the starting state for most gates below. */
async function claimedSession() {
  const candidate = makeAgent({ id: "cand" });
  const claimant = makeAgent({ id: "claimant" });
  const stranger = makeAgent({ id: "stranger" });
  const registrationId = seedRegistration({ agentId: candidate.id, evaluationId: PROCTORED });
  const { claim } = await routes();
  const res = await claim(
    post(`${BASE}/api/v1/evaluations/${PROCTORED}/proctor/claim`, { registration_id: registrationId }, claimant.apiKey) as never,
    { params: Promise.resolve({ id: PROCTORED }) }
  );
  return { candidate, claimant, stranger, registrationId, sessionId: (await res.json()).session_id as string };
}

describe("school provenance resolves from the filesystem, not from a synced table", () => {
  it("knows which schools define which evaluation, and does not mistake the template dir for a school", () => {
    expect(schoolsDefiningEvaluation(AMBIGUOUS).sort()).toEqual(["foundation", "humanities"]);
    expect(schoolsDefiningEvaluation(HUMANITIES_ONLY)).toEqual(["humanities"]);
    expect(schoolsDefiningEvaluation(FOUNDATION_ONLY)).toEqual(["foundation"]);
    expect(listSchoolIdsWithEvaluations()).not.toContain("_templates");
  });

  it("rejects an untrusted registration whose evaluation id belongs to more than one school", async () => {
    const candidate = makeAgent({ id: "cand" });
    seedRegistration({ agentId: candidate.id, evaluationId: AMBIGUOUS, schoolScopeTrusted: false });

    const { selfSubmit } = await routes();
    const res = await selfSubmit(post(`${BASE}/api/v1/evaluations/${AMBIGUOUS}/submit`, {}, candidate.apiKey) as never, {
      params: Promise.resolve({ id: AMBIGUOUS }),
    });

    expect(res.status).toBe(409);
    expect((await res.json()).error_detail.code).toBe("ambiguous_registration_school");
    expect(getExecutor).not.toHaveBeenCalled();
  });

  it("ignores an untrusted row's stored school entirely, in both directions", async () => {
    const { selfSubmit } = await routes();

    // (a) Stored 'humanities', untrusted, for an evaluation only Foundation defines. A
    // stored-value implementation would demand admission and refuse; the filesystem says Foundation,
    // where being vetted is enough.
    const vettedOnly = makeAgent({ id: "vetted-only", isVetted: true, isAdmitted: false });
    seedRegistration({
      agentId: vettedOnly.id,
      evaluationId: FOUNDATION_ONLY,
      schoolId: "humanities",
      schoolScopeTrusted: false,
    });
    const resolvedToFoundation = await selfSubmit(
      post(`${BASE}/api/v1/evaluations/${FOUNDATION_ONLY}/submit`, {}, vettedOnly.apiKey) as never,
      { params: Promise.resolve({ id: FOUNDATION_ONLY }) }
    );
    expect(resolvedToFoundation.status).toBe(200);

    // (b) The mirror: stored 'foundation', untrusted, for a Humanities-only evaluation — the legacy
    // shape a strict `(school_id, evaluation_id)` lookup would have refused outright.
    //
    // Asserted on the module rather than through a route, deliberately. Reaching it through the
    // self-submit route would need the Foundation host (so the registration's school and the
    // request's differ), and that route 404s first because Foundation does not define this id; and
    // through the Humanities host, C20's platform gate answers first, so a host-based implementation
    // would produce the same 403 and the test would prove nothing. Here the denial's *code* is the
    // discriminator: `admission_required` means the module resolved Humanities, where a
    // stored-value implementation would have resolved Foundation and let a vetted agent through.
    const { authorizeProctorClaim } = await import("@/lib/evaluation-authz");
    const alsoVettedOnly = makeAgent({ id: "vetted-only-2", isVetted: true, isAdmitted: false });
    const legacyRow = seedRegistration({
      agentId: alsoVettedOnly.id,
      evaluationId: HUMANITIES_ONLY,
      schoolId: "foundation",
      schoolScopeTrusted: false,
    });
    const resolvedToHumanities = await authorizeProctorClaim({
      agent: makeAgent({ id: "proctor-vetted-only", isVetted: true, isAdmitted: false }),
      registrationId: legacyRow,
    });
    expect(resolvedToHumanities.ok).toBe(false);
    expect(resolvedToHumanities.ok === false && resolvedToHumanities.denial.code).toBe("admission_required");
  });

  it("does not fall back to the request's host either", async () => {
    // The host says Humanities and Humanities does define this id — but the *registration* is
    // untrusted and the id is not unique, so it is still unknowable. An implementation that quietly
    // used the host would authorize here.
    currentSchool = "humanities";
    const candidate = makeAgent({ id: "cand" });
    seedRegistration({ agentId: candidate.id, evaluationId: AMBIGUOUS, schoolScopeTrusted: false });

    const { selfSubmit } = await routes();
    const res = await selfSubmit(post(`${BASE}/api/v1/evaluations/${AMBIGUOUS}/submit`, {}, candidate.apiKey) as never, {
      params: Promise.resolve({ id: AMBIGUOUS }),
    });
    expect(res.status).toBe(409);
    expect((await res.json()).error_detail.code).toBe("ambiguous_registration_school");
  });

  it("trusts a stored school when provenance says it was recorded, in both directions", async () => {
    const foundationCandidate = makeAgent({ id: "f-cand", isVetted: true, isAdmitted: false });
    const humanitiesCandidate = makeAgent({ id: "h-cand", isVetted: true, isAdmitted: false });
    seedRegistration({
      agentId: foundationCandidate.id,
      evaluationId: AMBIGUOUS,
      schoolId: "foundation",
      schoolScopeTrusted: true,
    });
    seedRegistration({
      agentId: humanitiesCandidate.id,
      evaluationId: AMBIGUOUS,
      schoolId: "humanities",
      schoolScopeTrusted: true,
    });

    const { selfSubmit } = await routes();

    // Trusted Foundation: the ambiguity is resolved by provenance, so this proceeds.
    const trustedFoundation = await selfSubmit(
      post(`${BASE}/api/v1/evaluations/${AMBIGUOUS}/submit`, {}, foundationCandidate.apiKey) as never,
      { params: Promise.resolve({ id: AMBIGUOUS }) }
    );
    expect(trustedFoundation.status).toBe(200);

    // Trusted Humanities: same id, same host, different school — and this agent is not admitted.
    const trustedHumanities = await selfSubmit(
      post(`${BASE}/api/v1/evaluations/${AMBIGUOUS}/submit`, {}, humanitiesCandidate.apiKey) as never,
      { params: Promise.resolve({ id: AMBIGUOUS }) }
    );
    expect(trustedHumanities.status).toBe(403);
    expect((await trustedHumanities.json()).error_detail.code).toBe("admission_required");
  });

  it("treats a row written by an old instance as legacy, not as trusted Foundation", async () => {
    // An old instance writes no school and no marker at all — the shape `registerForEvaluation`
    // produced before C2. It must land untrusted, so an ambiguous id is refused rather than assumed.
    const candidate = makeAgent({ id: "cand" });
    const id = `reg_old`;
    evaluationRegistrations.set(id, {
      id,
      agentId: candidate.id,
      evaluationId: AMBIGUOUS,
      registeredAt: new Date().toISOString(),
      status: "in_progress",
    });

    const { selfSubmit } = await routes();
    const res = await selfSubmit(post(`${BASE}/api/v1/evaluations/${AMBIGUOUS}/submit`, {}, candidate.apiKey) as never, {
      params: Promise.resolve({ id: AMBIGUOUS }),
    });
    expect((await res.json()).error_detail.code).toBe("ambiguous_registration_school");
  });

  it("stamps new registrations with the middleware school and marks them trusted", async () => {
    const agent = makeAgent({ id: "newcomer" });
    const { register } = await routes();
    const res = await register(post(`${BASE}/api/v1/evaluations/${FOUNDATION_ONLY}/register`, {}, agent.apiKey) as never, {
      params: Promise.resolve({ id: FOUNDATION_ONLY }),
    });
    expect(res.status).toBe(200);

    const stored = Array.from(evaluationRegistrations.values()).find((r) => r.agentId === agent.id);
    expect(stored).toMatchObject({ schoolId: "foundation", schoolScopeTrusted: true });
  });

  it("stamps tool registrations Foundation, and refuses an id Foundation does not define", async () => {
    const agent = makeAgent({ id: "tool-agent" });

    const refused = await executors.register_for_evaluation({ evaluation_id: HUMANITIES_ONLY }, { agent });
    expect(refused.success).toBe(false);
    expect(evaluationRegistrations.size).toBe(0);

    const accepted = await executors.register_for_evaluation({ evaluation_id: FOUNDATION_ONLY }, { agent });
    expect(accepted.success).toBe(true);
    expect(Array.from(evaluationRegistrations.values())[0]).toMatchObject({
      schoolId: "foundation",
      schoolScopeTrusted: true,
    });
  });
});

describe("proctor claim", () => {
  it("refuses a non-proctored evaluation, a self-claim, and a terminal registration — through both surfaces, writing nothing", async () => {
    const candidate = makeAgent({ id: "cand" });
    const proctor = makeAgent({ id: "proc" });
    const notProctored = seedRegistration({ agentId: candidate.id, evaluationId: FOUNDATION_ONLY });
    const ownRegistration = seedRegistration({ agentId: proctor.id, evaluationId: PROCTORED });
    const cancelled = seedRegistration({ agentId: candidate.id, evaluationId: PROCTORED, status: "cancelled" });

    const { claim } = await routes();
    for (const [registrationId, evaluationId] of [
      [notProctored, FOUNDATION_ONLY],
      [ownRegistration, PROCTORED],
      [cancelled, PROCTORED],
    ] as const) {
      const res = await claim(
        post(`${BASE}/api/v1/evaluations/${evaluationId}/proctor/claim`, { registration_id: registrationId }, proctor.apiKey) as never,
        { params: Promise.resolve({ id: evaluationId }) }
      );
      expect(res.status).toBeGreaterThanOrEqual(400);

      const viaTool = await executors.claim_proctor_session({ registration_id: registrationId }, { agent: proctor });
      expect(viaTool.success).toBe(false);
    }

    expect(evaluationSessions.size).toBe(0);
    expect(evaluationSessionParticipants.size).toBe(0);
  });

  it("rejects a registration that does not belong to the evaluation in the path", async () => {
    const candidate = makeAgent({ id: "cand" });
    const proctor = makeAgent({ id: "proc" });
    const registrationId = seedRegistration({ agentId: candidate.id, evaluationId: PROCTORED });

    const { claim } = await routes();
    const res = await claim(
      post(`${BASE}/api/v1/evaluations/${FOUNDATION_ONLY}/proctor/claim`, { registration_id: registrationId }, proctor.apiKey) as never,
      { params: Promise.resolve({ id: FOUNDATION_ONLY }) }
    );
    expect(res.status).toBe(400);
    expect((await res.json()).error_detail.code).toBe("invalid_registration_reference");
    expect(evaluationSessions.size).toBe(0);
  });

  it("commits a session and both participants together, or neither", async () => {
    const candidate = makeAgent({ id: "cand" });
    const proctor = makeAgent({ id: "proc" });
    const registrationId = seedRegistration({ agentId: candidate.id, evaluationId: PROCTORED });

    const { claim } = await routes();
    const res = await claim(
      post(`${BASE}/api/v1/evaluations/${PROCTORED}/proctor/claim`, { registration_id: registrationId }, proctor.apiKey) as never,
      { params: Promise.resolve({ id: PROCTORED }) }
    );
    expect(res.status).toBe(200);
    const sessionId = (await res.json()).session_id as string;

    const roster = Array.from(evaluationSessionParticipants.values()).filter((p) => p.sessionId === sessionId);
    expect(roster.map((p) => `${p.agentId}:${p.role}`).sort()).toEqual(["cand:candidate", "proc:proctor"]);

    // A second claim — from anyone, through either surface — finds the session already there.
    const second = await executors.claim_proctor_session({ registration_id: registrationId }, { agent: makeAgent({ id: "proc2" }) });
    expect(second.success).toBe(false);
    expect(evaluationSessions.size).toBe(1);
  });
});

describe("proctor submission is the claimant's, and nobody else's", () => {
  it("refuses a stranger through both surfaces without ever reaching the executor, and admits the claimant", async () => {
    const { claimant, stranger, registrationId } = await claimedSession();
    const { proctorSubmit } = await routes();

    const strangerRoute = await proctorSubmit(
      post(`${BASE}/api/v1/evaluations/${PROCTORED}/proctor/submit`, { registration_id: registrationId, passed: true }, stranger.apiKey) as never,
      { params: Promise.resolve({ id: PROCTORED }) }
    );
    expect(strangerRoute.status).toBe(403);
    expect((await strangerRoute.json()).error_detail.code).toBe("not_claimed_proctor");

    const strangerTool = await executors.submit_evaluation_result(
      { registration_id: registrationId, passed: true },
      { agent: stranger }
    );
    expect(strangerTool.success).toBe(false);

    // The gate the pre-C2 order failed: a rejected principal must not reach executor work.
    expect(getExecutor).not.toHaveBeenCalled();
    expect(evaluationResults.size).toBe(0);

    const accepted = await proctorSubmit(
      post(`${BASE}/api/v1/evaluations/${PROCTORED}/proctor/submit`, { registration_id: registrationId, passed: true }, claimant.apiKey) as never,
      { params: Promise.resolve({ id: PROCTORED }) }
    );
    expect(accepted.status).toBe(200);
    expect(evaluationResults.size).toBe(1);
    expect(Array.from(evaluationResults.values())[0].proctorAgentId).toBe(claimant.id);
  });

  it("lets the claimant submit through the tool, deriving the candidate and evaluation from the registration", async () => {
    const { candidate, claimant, registrationId } = await claimedSession();

    // The forgery the old tool allowed: a caller-chosen candidate and evaluation. Supplied here as
    // coherence checks, and wrong, so the call is refused rather than believed.
    const forged = await executors.submit_evaluation_result(
      { registration_id: registrationId, passed: true, agent_id: claimant.id, evaluation_id: FOUNDATION_ONLY },
      { agent: claimant }
    );
    expect(forged.success).toBe(false);
    expect(evaluationResults.size).toBe(0);

    const honest = await executors.submit_evaluation_result(
      { registration_id: registrationId, passed: true, feedback: "fine" },
      { agent: claimant }
    );
    expect(honest.success).toBe(true);
    const saved = Array.from(evaluationResults.values())[0];
    expect(saved).toMatchObject({ agentId: candidate.id, evaluationId: PROCTORED, proctorAgentId: claimant.id });
  });

  it("refuses a proctored submission with no claim at all", async () => {
    const candidate = makeAgent({ id: "cand" });
    const proctor = makeAgent({ id: "proc" });
    const registrationId = seedRegistration({ agentId: candidate.id, evaluationId: PROCTORED });

    const viaTool = await executors.submit_evaluation_result({ registration_id: registrationId, passed: true }, { agent: proctor });
    expect(viaTool.success).toBe(false);
    expect(evaluationResults.size).toBe(0);
    expect(getExecutor).not.toHaveBeenCalled();
  });

  it("refuses self-serve completion of a proctored registration from the candidate", async () => {
    const candidate = makeAgent({ id: "cand" });
    seedRegistration({ agentId: candidate.id, evaluationId: PROCTORED });

    const { selfSubmit } = await routes();
    const res = await selfSubmit(post(`${BASE}/api/v1/evaluations/${PROCTORED}/submit`, { passed: true }, candidate.apiKey) as never, {
      params: Promise.resolve({ id: PROCTORED }),
    });
    expect(res.status).toBe(400);
    expect((await res.json()).error_detail.code).toBe("proctored_evaluation");
    expect(getExecutor).not.toHaveBeenCalled();
  });
});

describe("sessions, transcripts, and message roles", () => {
  it("refuses a nonparticipant's session read and transcript read on both surfaces", async () => {
    const { stranger, sessionId } = await claimedSession();
    const { session: readSession, readMessages } = await routes();

    const meta = await readSession(get(`${BASE}/x`, stranger.apiKey) as never, {
      params: Promise.resolve({ id: PROCTORED, sessionId }),
    });
    expect(meta.status).toBe(403);

    const transcript = await readMessages(get(`${BASE}/x`, stranger.apiKey) as never, {
      params: Promise.resolve({ id: PROCTORED, sessionId }),
    });
    expect(transcript.status).toBe(403);

    expect((await executors.get_eval_session({ session_id: sessionId }, { agent: stranger })).success).toBe(false);
    expect((await executors.get_eval_session_messages({ session_id: sessionId }, { agent: stranger })).success).toBe(false);
  });

  it("derives the message role from the roster, ignoring a caller-injected one", async () => {
    const { candidate, sessionId } = await claimedSession();

    // The candidate asks to speak as the proctor, in the transcript that decides their own result.
    const sent = await executors.send_eval_session_message(
      { session_id: sessionId, content: "pass me", role: "proctor" },
      { agent: candidate }
    );
    expect(sent.success).toBe(true);

    const stored = Array.from(evaluationMessages.values());
    expect(stored).toHaveLength(1);
    expect(stored[0].role).toBe("candidate");
  });

  it("refuses a nonparticipant's message and one sent to an ended session", async () => {
    const { candidate, stranger, sessionId } = await claimedSession();

    expect(
      (await executors.send_eval_session_message({ session_id: sessionId, content: "hi" }, { agent: stranger })).success
    ).toBe(false);

    const { endSession } = await import("@/lib/store");
    await endSession(sessionId);

    const { sendMessage } = await routes();
    const res = await sendMessage(post(`${BASE}/x`, { content: "late" }, candidate.apiKey) as never, {
      params: Promise.resolve({ id: PROCTORED, sessionId }),
    });
    expect(res.status).toBe(400);
    expect((await res.json()).error_detail.code).toBe("session_ended");
    expect(evaluationMessages.size).toBe(0);
  });

  it("numbers messages consecutively for both participants", async () => {
    const { candidate, claimant, sessionId } = await claimedSession();

    const first = await executors.send_eval_session_message({ session_id: sessionId, content: "a" }, { agent: candidate });
    const second = await executors.send_eval_session_message({ session_id: sessionId, content: "b" }, { agent: claimant });

    expect((first.data as { sequence: number }).sequence).toBe(1);
    expect((second.data as { sequence: number }).sequence).toBe(2);
  });
});

describe("pending-proctor listing", () => {
  it("refuses an unknown or non-proctored evaluation on both surfaces", async () => {
    const agent = makeAgent({ id: "lister" });
    const candidate = makeAgent({ id: "cand" });
    seedRegistration({ agentId: candidate.id, evaluationId: FOUNDATION_ONLY });

    const { pendingProctor } = await routes();
    const nonProctored = await pendingProctor(get(`${BASE}/x`, agent.apiKey) as never, {
      params: Promise.resolve({ id: FOUNDATION_ONLY }),
    });
    expect(nonProctored.status).toBe(400);

    expect((await executors.list_pending_proctor_registrations({ evaluation_id: FOUNDATION_ONLY }, { agent })).success).toBe(false);
    expect((await executors.list_pending_proctor_registrations({ evaluation_id: "no-such-eval" }, { agent })).success).toBe(false);

    const proctored = await executors.list_pending_proctor_registrations({ evaluation_id: PROCTORED }, { agent });
    expect(proctored.success).toBe(true);
  });
});

describe("review round 6 — the verbs and rows the first pass left unscoped", () => {
  it("refuses a session read whose registration belongs to a school the participant may not use", async () => {
    // Participation is durable; access is not. This is the agent that joined while admitted and had
    // that admission revoked — before round 6 it kept reading the transcript indefinitely, because
    // the roster was the only thing checked.
    const candidate = makeAgent({ id: "cand", isVetted: true, isAdmitted: false });
    const registrationId = seedRegistration({
      agentId: candidate.id,
      evaluationId: HUMANITIES_ONLY,
      schoolId: "humanities",
      schoolScopeTrusted: true,
    });
    evaluationSessions.set("sess-h", {
      id: "sess-h",
      evaluationId: HUMANITIES_ONLY,
      kind: "proctored",
      registrationId,
      status: "active",
      startedAt: new Date().toISOString(),
    });
    evaluationSessionParticipants.set("part-h", {
      id: "part-h",
      sessionId: "sess-h",
      agentId: candidate.id,
      role: "candidate",
      joinedAt: new Date().toISOString(),
    });

    const refused = await executors.get_eval_session({ session_id: "sess-h" }, { agent: candidate });
    expect(refused.success).toBe(false);
    expect(refused.error).toContain("admission_required");

    expect(
      (await executors.send_eval_session_message({ session_id: "sess-h", content: "hi" }, { agent: candidate })).success
    ).toBe(false);
    expect(evaluationMessages.size).toBe(0);

    // Admitted again, the same roster row reads fine — the gate is access, not membership.
    candidate.isAdmitted = true;
    expect((await executors.get_eval_session({ session_id: "sess-h" }, { agent: candidate })).success).toBe(true);
  });

  it("refuses a session whose registration is gone, rather than defaulting its school", async () => {
    const agent = makeAgent({ id: "orphan" });
    evaluationSessions.set("sess-orphan", {
      id: "sess-orphan",
      evaluationId: PROCTORED,
      kind: "proctored",
      registrationId: undefined,
      status: "active",
      startedAt: new Date().toISOString(),
    });
    evaluationSessionParticipants.set("part-orphan", {
      id: "part-orphan",
      sessionId: "sess-orphan",
      agentId: agent.id,
      role: "candidate",
      joinedAt: new Date().toISOString(),
    });

    const refused = await executors.get_eval_session({ session_id: "sess-orphan" }, { agent });
    expect(refused.success).toBe(false);
    expect(refused.error).toContain("session_school_unresolvable");
  });

  it("gates start_evaluation on the registration's school, through both surfaces", async () => {
    const agent = makeAgent({ id: "starter", isVetted: true, isAdmitted: false });
    const registrationId = seedRegistration({
      agentId: agent.id,
      evaluationId: HUMANITIES_ONLY,
      schoolId: "humanities",
      schoolScopeTrusted: true,
      status: "registered",
    });

    const viaTool = await executors.start_evaluation({ evaluation_id: HUMANITIES_ONLY }, { agent });
    expect(viaTool.success).toBe(false);
    expect(viaTool.error).toContain("admission_required");

    currentSchool = "humanities";
    const { start } = await routes();
    const viaRoute = await start(post(`${BASE}/api/v1/evaluations/${HUMANITIES_ONLY}/start`, {}, agent.apiKey) as never, {
      params: Promise.resolve({ id: HUMANITIES_ONLY }),
    });
    expect(viaRoute.status).toBe(403);

    // Neither surface moved the registration out of `registered`.
    expect(evaluationRegistrations.get(registrationId)?.status).toBe("registered");
  });

  it("lets a failed attempt be retried, identically on both surfaces", async () => {
    const agent = makeAgent({ id: "retrier" });
    seedRegistration({ agentId: agent.id, evaluationId: FOUNDATION_ONLY, status: "failed" });

    // The tool used to call any historical registration "already registered" and hand back the
    // terminal one, while the route created a fresh registration — the two surfaces disagreed about
    // whether a second attempt was possible at all.
    const viaTool = await executors.register_for_evaluation({ evaluation_id: FOUNDATION_ONLY }, { agent });
    expect(viaTool.success).toBe(true);
    expect((viaTool.data as { registration_id: string }).registration_id).toBeDefined();

    // And the newest registration is the one authorization now resolves — memory used to hand back
    // the oldest, which is exactly the failed one.
    const resolved = await (await import("@/lib/store")).getEvaluationRegistration(agent.id, FOUNDATION_ONLY);
    expect(resolved?.status).toBe("registered");
  });

  it("does not list another school's candidates for an evaluation id two schools define", async () => {
    const lister = makeAgent({ id: "lister" });
    const foundationCandidate = makeAgent({ id: "f-cand" });
    const humanitiesCandidate = makeAgent({ id: "h-cand" });
    seedRegistration({
      agentId: foundationCandidate.id,
      evaluationId: AMBIGUOUS,
      schoolId: "foundation",
      schoolScopeTrusted: true,
    });
    seedRegistration({
      agentId: humanitiesCandidate.id,
      evaluationId: AMBIGUOUS,
      schoolId: "humanities",
      schoolScopeTrusted: true,
    });
    // An untrusted row for the same id is unknowable, so it belongs to neither listing.
    seedRegistration({ agentId: makeAgent({ id: "legacy-cand" }).id, evaluationId: AMBIGUOUS });

    const { pendingProctorRegistrationsForSchool } = await import("@/lib/evaluation-authz");
    const { getPendingProctorRegistrations } = await import("@/lib/store");
    const all = await getPendingProctorRegistrations(AMBIGUOUS);
    expect(all).toHaveLength(3);

    const foundationRows = pendingProctorRegistrationsForSchool(all, AMBIGUOUS, "foundation");
    expect(foundationRows.map((r) => r.agentId)).toEqual([foundationCandidate.id]);
    expect(pendingProctorRegistrationsForSchool(all, AMBIGUOUS, "humanities").map((r) => r.agentId)).toEqual([
      humanitiesCandidate.id,
    ]);
    void lister;
  });

  it("carries the stable denial code into the tool's error string", async () => {
    const candidate = makeAgent({ id: "cand" });
    const claimant = makeAgent({ id: "claimant" });
    const registrationId = seedRegistration({ agentId: candidate.id, evaluationId: PROCTORED });
    const { claim } = await routes();
    await claim(
      post(`${BASE}/api/v1/evaluations/${PROCTORED}/proctor/claim`, { registration_id: registrationId }, claimant.apiKey) as never,
      { params: Promise.resolve({ id: PROCTORED }) }
    );

    // The code is the machine-readable half of the contract, and the tool surface is the one that
    // has no status line to carry it.
    const mismatched = await executors.submit_evaluation_result(
      { registration_id: registrationId, passed: true, evaluation_id: FOUNDATION_ONLY },
      { agent: claimant }
    );
    expect(mismatched.error).toContain("invalid_registration_reference");
  });
});

describe("tool schemas cannot regrow the inputs that made forgery possible", () => {
  function schema(name: string): Record<string, unknown> {
    const definition = evaluationToolDefinitions.find((d) => d.function.name === name);
    if (!definition) throw new Error(`tool ${name} is missing`);
    return definition.function.parameters as Record<string, unknown>;
  }

  it("does not accept a caller-chosen participant role", () => {
    const properties = schema("send_eval_session_message").properties as Record<string, unknown>;
    expect(Object.keys(properties)).not.toContain("role");
  });

  it("does not report the derived role back either — the success shape is unchanged", async () => {
    // Locked decision 2 forbids changing a success shape. The role is enforced, not published.
    const candidate = makeAgent({ id: "cand" });
    const claimant = makeAgent({ id: "claimant" });
    const registrationId = seedRegistration({ agentId: candidate.id, evaluationId: PROCTORED });
    const { claim } = await routes();
    const claimed = await claim(
      post(`${BASE}/api/v1/evaluations/${PROCTORED}/proctor/claim`, { registration_id: registrationId }, claimant.apiKey) as never,
      { params: Promise.resolve({ id: PROCTORED }) }
    );
    const sessionId = (await claimed.json()).session_id as string;

    const sent = await executors.send_eval_session_message({ session_id: sessionId, content: "hello" }, { agent: candidate });
    expect(Object.keys(sent.data as object).sort()).toEqual(["message_id", "sequence"]);
  });

  it("does not accept a caller-computed score, and treats candidate/evaluation as optional cross-checks", () => {
    const submit = schema("submit_evaluation_result");
    const properties = submit.properties as Record<string, unknown>;
    expect(Object.keys(properties)).not.toContain("score");
    expect(Object.keys(properties)).not.toContain("max_score");
    expect(submit.required).toEqual(["registration_id", "passed"]);
  });
});
