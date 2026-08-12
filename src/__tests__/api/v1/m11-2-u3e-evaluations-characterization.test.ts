/**
 * M11-2 u3e (P1.4) — CHARACTERIZATION. The exact wire shapes the evaluation and agent-lifecycle
 * surfaces answer with **today**, pinned before any of them becomes an adapter.
 *
 * u3e turns eight route handlers and five tool executors into adapters over
 * `src/lib/actions/evaluations.ts` and the lifecycle half of `src/lib/actions/agents.ts`. The value
 * of that refactor rests entirely on nothing an agent can observe changing, and "nothing changed" is
 * not a claim a diff can make: these bodies are assembled from `errorResponse`'s envelope, C2's
 * denial envelope and hand-written success shapes, and the tools are a third shape again. So they
 * are pinned here, field for field, **before** the refactor — and this file is then re-run against
 * the adapters.
 *
 * **Every pin below was derived from the PRE-u3e source**: none of `src/app/api/v1/evaluations/**`,
 * `src/app/api/v1/agents/{register,claim,verify,vetting}/**` or
 * `src/lib/agent-tools/definitions/evaluations.ts` is touched by u1–u3d, so the provenance is exact.
 * A characterization suite written by reading the *refactored* code proves the refactor is
 * self-consistent and nothing more.
 *
 * **Three wire behaviors change on purpose**, and each has its own test at the bottom rather than a
 * silently adjusted pin — see `describe("recorded behavior changes")`.
 *
 * `request_id` and `X-Request-Id` are generated per response and are the only fields excluded.
 *
 * No mocks for the store: Jest runs with no database, so `@/lib/store` *is* the memory store.
 *
 * @jest-environment node
 */
const executorResult: { value: Record<string, unknown> } = {
  value: { passed: true, score: 5, maxScore: 10, resultData: { ok: true } },
};
const handler = jest.fn(async () => executorResult.value);
jest.mock("@/lib/evaluations/executor-registry", () => ({ getExecutor: jest.fn(() => handler) }));

jest.mock("next/headers", () => ({
  headers: jest.fn(async () => new Headers({ "x-school-id": "foundation" })),
}));

import { POST as REGISTER_AGENT } from "@/app/api/v1/agents/register/route";
import { POST as VETTING_START } from "@/app/api/v1/agents/vetting/start/route";
import { POST as EVAL_REGISTER } from "@/app/api/v1/evaluations/[id]/register/route";
import { POST as EVAL_START } from "@/app/api/v1/evaluations/[id]/start/route";
import { POST as EVAL_SUBMIT } from "@/app/api/v1/evaluations/[id]/submit/route";
import { POST as PROCTOR_CLAIM } from "@/app/api/v1/evaluations/[id]/proctor/claim/route";
import { POST as PROCTOR_SUBMIT } from "@/app/api/v1/evaluations/[id]/proctor/submit/route";
import { POST as SESSION_MESSAGE } from "@/app/api/v1/evaluations/[id]/sessions/[sessionId]/messages/route";
import { executors as evaluationTools } from "@/lib/agent-tools/definitions/evaluations";
import { registerForEvaluation as actionRegisterForEvaluation } from "@/lib/actions/evaluations";
import {
  agents,
  apiKeyToAgentId,
  evaluationMessages,
  evaluationRegistrations,
  evaluationResults,
  evaluationSessionParticipants,
  evaluationSessions,
  eventLog,
  rateWindows,
  vettingChallenges,
} from "@/lib/store/_memory-state";
import { clearRateWindows } from "@/__tests__/helpers/store-fixtures";
import type { StoredAgent } from "@/lib/store-types";

const BASE = "https://safemolt.com";
/** A Foundation evaluation that really is proctored (`schools/foundation/evaluations/SIP-5.md`). */
const PROCTORED = "non-spamminess";
/** Foundation-only, active, not proctored, 10 points. */
const SELF_SERVE = "poaw";

let seq = 0;
const nextId = (label: string) => `u3e_${label}_${Date.now().toString(36)}_${(seq += 1)}`;

function makeAgent(overrides: Partial<StoredAgent> = {}): StoredAgent {
  const id = overrides.id ?? nextId("agent");
  const agent: StoredAgent = {
    id,
    name: overrides.name ?? id,
    description: "",
    apiKey: `key_${id}`,
    points: 0,
    votePoints: 0,
    evaluationPoints: 0,
    legacyUnattributedPoints: 0,
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

function evaluationStateSnapshot() {
  return JSON.stringify({
    agents: Array.from(agents.entries()).map(([id, agent]) => [id, { ...agent, lastActiveAt: undefined }]),
    registrations: Array.from(evaluationRegistrations.entries()),
    results: Array.from(evaluationResults.entries()),
    sessions: Array.from(evaluationSessions.entries()),
    participants: Array.from(evaluationSessionParticipants.entries()),
    messages: Array.from(evaluationMessages.entries()),
    challenges: Array.from(vettingChallenges.entries()),
    apiKeys: Array.from(apiKeyToAgentId.entries()),
    rateWindows: Array.from(rateWindows.entries()),
    events: eventLog.rows,
  });
}

function seedRegistration(opts: {
  agentId: string;
  evaluationId: string;
  status?: "registered" | "in_progress" | "completed" | "failed" | "cancelled";
}): string {
  const id = nextId("reg");
  evaluationRegistrations.set(id, {
    id,
    agentId: opts.agentId,
    evaluationId: opts.evaluationId,
    registeredAt: new Date().toISOString(),
    status: opts.status ?? "in_progress",
    schoolId: "foundation",
    schoolScopeTrusted: true,
  });
  return id;
}

function post(url: string, body: unknown, apiKey?: string): Request {
  return new Request(`${BASE}${url}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-school-id": "foundation",
      ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
    },
    body: JSON.stringify(body),
  });
}

/** The response body minus the per-response request id. */
async function body(response: Response): Promise<Record<string, unknown>> {
  const parsed = (await response.json()) as Record<string, unknown>;
  delete parsed.request_id;
  return parsed;
}

beforeEach(() => {
  agents.clear();
  apiKeyToAgentId.clear();
  evaluationRegistrations.clear();
  evaluationResults.clear();
  evaluationSessions.clear();
  evaluationSessionParticipants.clear();
  evaluationMessages.clear();
  vettingChallenges.clear();
  eventLog.rows.length = 0;
  eventLog.nextId = 1;
  // `POST /agents/register` is unauthenticated and IP-limited (M11-1 C13a) through a DURABLE
  // window keyed by address, so a suite that registers more than the hourly budget starts
  // answering 429 to itself. `clearRateWindows` covers the per-agent cooldowns; the public windows
  // live in their own map.
  clearRateWindows();
  rateWindows.clear();
  handler.mockClear();
  executorResult.value = { passed: true, score: 5, maxScore: 10, resultData: { ok: true } };
});

describe("POST /api/v1/agents/register", () => {
  it("answers the api key, claim url and verification code", async () => {
    const response = await REGISTER_AGENT(post("/api/v1/agents/register", { name: nextId("fresh") }));
    const parsed = await body(response);
    expect(response.status).toBe(200);
    expect(parsed.success).toBe(true);
    expect(parsed.important).toBe("⚠️ SAVE YOUR API KEY!");
    const agent = parsed.agent as Record<string, unknown>;
    expect(Object.keys(agent).sort()).toEqual(["api_key", "claim_url", "verification_code"]);
    expect(typeof agent.api_key).toBe("string");
    expect(String(agent.claim_url)).toContain("/claim/");
  });

  it("refuses a missing name with the shared 400 envelope", async () => {
    const response = await REGISTER_AGENT(post("/api/v1/agents/register", {}));
    expect(response.status).toBe(400);
    expect(await body(response)).toEqual({
      success: false,
      error: "name is required",
      hint: "Provide agent name",
      error_detail: { code: "bad_request", message: "name is required", hint: "Provide agent name" },
    });
  });

  it("refuses a duplicate name as a 400, case-insensitively", async () => {
    const name = nextId("dup");
    await REGISTER_AGENT(post("/api/v1/agents/register", { name }));
    const response = await REGISTER_AGENT(
      post("/api/v1/agents/register", { name: name.toUpperCase() })
    );
    expect(response.status).toBe(400);
    expect(await body(response)).toEqual({
      success: false,
      error: "A bot with this name already exists. Choose a different name.",
      hint: undefined,
      error_detail: {
        code: "bad_request",
        message: "A bot with this name already exists. Choose a different name.",
        hint: undefined,
      },
    });
  });
});

describe("POST /api/v1/agents/vetting/start", () => {
  it("answers a challenge id, a fetch url and an expiry", async () => {
    const agent = makeAgent({ isVetted: false });
    const response = await VETTING_START(
      post("/api/v1/agents/vetting/start", {}, agent.apiKey) as never
    );
    const parsed = await body(response);
    expect(response.status).toBe(200);
    expect(parsed.success).toBe(true);
    expect(String(parsed.challenge_id)).toMatch(/^vc_/);
    expect(String(parsed.fetch_url)).toContain("/api/v1/agents/vetting/challenge/");
    expect(typeof parsed.expires_at).toBe("string");
    expect(parsed.hint).toBe(
      "You have 15 seconds to complete the challenge. Fetch the payload, sort the values, compute the hash, and submit."
    );
  });

  it("answers already_vetted as a success that writes nothing", async () => {
    const agent = makeAgent({ isVetted: true });
    const response = await VETTING_START(
      post("/api/v1/agents/vetting/start", {}, agent.apiKey) as never
    );
    expect(await body(response)).toEqual({
      success: true,
      already_vetted: true,
      message: "This agent has already been vetted.",
    });
    expect(vettingChallenges.size).toBe(0);
  });
});

describe("POST /api/v1/evaluations/{id}/register", () => {
  const params = (id: string) => ({ params: Promise.resolve({ id }) });

  it("answers the registration it created", async () => {
    const agent = makeAgent();
    const response = await EVAL_REGISTER(
      post(`/api/v1/evaluations/${SELF_SERVE}/register`, {}, agent.apiKey) as never,
      params(SELF_SERVE)
    );
    const parsed = await body(response);
    expect(response.status).toBe(200);
    expect(parsed.success).toBe(true);
    expect(parsed.message).toBe("Successfully registered for evaluation");
    const registration = parsed.registration as Record<string, unknown>;
    expect(Object.keys(registration).sort()).toEqual([
      "evaluation_id",
      "id",
      "registered_at",
      "status",
    ]);
    expect(registration.evaluation_id).toBe(SELF_SERVE);
    expect(registration.status).toBe("registered");
  });

  it("answers a standing active registration with 'Already registered' and writes nothing", async () => {
    const agent = makeAgent();
    const registrationId = seedRegistration({ agentId: agent.id, evaluationId: SELF_SERVE, status: "registered" });
    const before = evaluationRegistrations.size;
    const response = await EVAL_REGISTER(
      post(`/api/v1/evaluations/${SELF_SERVE}/register`, {}, agent.apiKey) as never,
      params(SELF_SERVE)
    );
    const parsed = await body(response);
    expect(parsed.message).toBe("Already registered");
    expect((parsed.registration as Record<string, unknown>).id).toBe(registrationId);
    expect(evaluationRegistrations.size).toBe(before);
  });

  it("refuses an unknown evaluation with C2's 404 envelope", async () => {
    const agent = makeAgent();
    const response = await EVAL_REGISTER(
      post("/api/v1/evaluations/not-an-evaluation/register", {}, agent.apiKey) as never,
      params("not-an-evaluation")
    );
    expect(response.status).toBe(404);
    expect(await body(response)).toEqual({
      success: false,
      error: "Evaluation not found",
      hint: undefined,
      error_detail: {
        code: "evaluation_definition_not_found",
        message: "Evaluation not found",
        hint: undefined,
      },
    });
  });

  it("refuses an unvetted agent with the vetting_required envelope", async () => {
    const agent = makeAgent({ isVetted: false });
    const response = await EVAL_REGISTER(
      post(`/api/v1/evaluations/${SELF_SERVE}/register`, {}, agent.apiKey) as never,
      params(SELF_SERVE)
    );
    expect(response.status).toBe(403);
    const parsed = await body(response);
    // **The PLATFORM gate answers first, not C2's evaluation-scoped one.** `requireAgent` applies
    // `requireSchoolAccess` before the handler runs, so an unvetted caller never reaches
    // `authorizeEvaluationRegistration` and sees its wording ("…to access the Foundation School")
    // rather than the evaluation wording ("…to act on Foundation School evaluations"). Pinned as
    // found: C2's message is reachable only for an agent the platform admits and the registration's
    // own school does not.
    expect(parsed.error).toBe("Agent must be vetted to access the Foundation School");
    expect(parsed.vetting_required).toBe(true);
  });
});

describe("POST /api/v1/evaluations/{id}/start", () => {
  const params = (id: string) => ({ params: Promise.resolve({ id }) });

  it("refuses an unregistered caller with C2's not_registered envelope", async () => {
    const agent = makeAgent();
    const response = await EVAL_START(
      post(`/api/v1/evaluations/${PROCTORED}/start`, {}, agent.apiKey) as never,
      params(PROCTORED)
    );
    expect(response.status).toBe(400);
    expect(await body(response)).toEqual({
      success: false,
      error: "Not registered",
      hint: "You must register for this evaluation first",
      error_detail: {
        code: "not_registered",
        message: "Not registered",
        hint: "You must register for this evaluation first",
      },
    });
  });

  it("answers the plain success shape for a non-poaw, non-certification evaluation", async () => {
    const agent = makeAgent();
    const registrationId = seedRegistration({ agentId: agent.id, evaluationId: PROCTORED, status: "registered" });
    const response = await EVAL_START(
      post(`/api/v1/evaluations/${PROCTORED}/start`, {}, agent.apiKey) as never,
      params(PROCTORED)
    );
    expect(await body(response)).toEqual({
      success: true,
      evaluation_id: PROCTORED,
      message: "Evaluation started",
      registration_id: registrationId,
    });
    expect(evaluationRegistrations.get(registrationId)!.status).toBe("in_progress");
  });

  it("mints a poaw challenge and answers its fetch url", async () => {
    const agent = makeAgent();
    seedRegistration({ agentId: agent.id, evaluationId: SELF_SERVE, status: "registered" });
    const response = await EVAL_START(
      post(`/api/v1/evaluations/${SELF_SERVE}/start`, {}, agent.apiKey) as never,
      params(SELF_SERVE)
    );
    const parsed = await body(response);
    expect(parsed.success).toBe(true);
    const challenge = parsed.challenge as Record<string, unknown>;
    expect(Object.keys(challenge).sort()).toEqual(["expires_at", "fetch_url", "id", "instructions"]);
    expect(String(challenge.fetch_url)).toContain(`/api/v1/evaluations/poaw/challenge/`);
    expect(vettingChallenges.size).toBe(1);
  });
});

describe("POST /api/v1/evaluations/{id}/submit", () => {
  const params = (id: string) => ({ params: Promise.resolve({ id }) });

  it("answers the created result", async () => {
    const agent = makeAgent();
    seedRegistration({ agentId: agent.id, evaluationId: SELF_SERVE, status: "in_progress" });
    const response = await EVAL_SUBMIT(
      post(`/api/v1/evaluations/${SELF_SERVE}/submit`, { anything: true }, agent.apiKey) as never,
      params(SELF_SERVE)
    );
    const parsed = await body(response);
    expect(response.status).toBe(200);
    expect(parsed.success).toBe(true);
    const result = parsed.result as Record<string, unknown>;
    expect(Object.keys(result).sort()).toEqual([
      "completed_at",
      "id",
      "max_score",
      "passed",
      "score",
    ]);
    expect(result.passed).toBe(true);
    expect(result.score).toBe(5);
    expect(result.max_score).toBe(10);
  });

  it("replays the standing result for a registration that already completed", async () => {
    const agent = makeAgent();
    const registrationId = seedRegistration({ agentId: agent.id, evaluationId: SELF_SERVE, status: "in_progress" });
    await EVAL_SUBMIT(
      post(`/api/v1/evaluations/${SELF_SERVE}/submit`, {}, agent.apiKey) as never,
      params(SELF_SERVE)
    );
    const response = await EVAL_SUBMIT(
      post(`/api/v1/evaluations/${SELF_SERVE}/submit`, {}, agent.apiKey) as never,
      params(SELF_SERVE)
    );
    const parsed = await body(response);
    expect(parsed.success).toBe(true);
    // The replay body is `existingResultBody`'s five fields — the same shape a fresh submission
    // answers, so an idempotent retry is indistinguishable from the first call (M11-1 C21).
    const replayed = parsed.result as Record<string, unknown>;
    expect(Object.keys(replayed).sort()).toEqual([
      "completed_at",
      "id",
      "max_score",
      "passed",
      "score",
    ]);
    expect(replayed.id).toBe(Array.from(evaluationResults.values())[0].id);
    expect(Array.from(evaluationResults.values())[0].registrationId).toBe(registrationId);
    // Exactly one result, whatever the caller did.
    expect(evaluationResults.size).toBe(1);
  });

  it("refuses a proctored evaluation through the self-serve surface", async () => {
    const agent = makeAgent();
    seedRegistration({ agentId: agent.id, evaluationId: PROCTORED, status: "in_progress" });
    const response = await EVAL_SUBMIT(
      post(`/api/v1/evaluations/${PROCTORED}/submit`, {}, agent.apiKey) as never,
      params(PROCTORED)
    );
    expect(response.status).toBe(400);
    expect(await body(response)).toEqual({
      success: false,
      error: "Proctored evaluation",
      hint: "This evaluation is proctored; a proctor must submit your result.",
      error_detail: {
        code: "proctored_evaluation",
        message: "Proctored evaluation",
        hint: "This evaluation is proctored; a proctor must submit your result.",
      },
    });
    expect(evaluationResults.size).toBe(0);
  });
});

describe("POST /api/v1/evaluations/{id}/proctor/claim", () => {
  const params = (id: string) => ({ params: Promise.resolve({ id }) });

  it("answers the session it created plus the candidate's identity", async () => {
    const candidate = makeAgent({ name: nextId("cand") });
    const proctor = makeAgent({ name: nextId("proc") });
    const registrationId = seedRegistration({ agentId: candidate.id, evaluationId: PROCTORED });
    const response = await PROCTOR_CLAIM(
      post(
        `/api/v1/evaluations/${PROCTORED}/proctor/claim`,
        { registration_id: registrationId },
        proctor.apiKey
      ) as never,
      params(PROCTORED)
    );
    const parsed = await body(response);
    expect(response.status).toBe(200);
    expect(parsed.success).toBe(true);
    expect(parsed.registration_id).toBe(registrationId);
    expect(parsed.candidate_agent_id).toBe(candidate.id);
    expect(parsed.candidate_name).toBe(candidate.name);
    expect(String(parsed.session_id)).toMatch(/^eval_sess/);
  });

  it("refuses self-proctoring with C2's 403", async () => {
    const candidate = makeAgent();
    const registrationId = seedRegistration({ agentId: candidate.id, evaluationId: PROCTORED });
    const response = await PROCTOR_CLAIM(
      post(
        `/api/v1/evaluations/${PROCTORED}/proctor/claim`,
        { registration_id: registrationId },
        candidate.apiKey
      ) as never,
      params(PROCTORED)
    );
    expect(response.status).toBe(403);
    expect((await body(response)).error_detail).toEqual({
      code: "self_proctoring",
      message: "Forbidden",
      hint: "Proctor cannot claim their own registration",
    });
    expect(evaluationSessions.size).toBe(0);
  });

  it("refuses a second claim with already_claimed", async () => {
    const candidate = makeAgent();
    const first = makeAgent();
    const second = makeAgent();
    const registrationId = seedRegistration({ agentId: candidate.id, evaluationId: PROCTORED });
    await PROCTOR_CLAIM(
      post(`/api/v1/evaluations/${PROCTORED}/proctor/claim`, { registration_id: registrationId }, first.apiKey) as never,
      params(PROCTORED)
    );
    const response = await PROCTOR_CLAIM(
      post(`/api/v1/evaluations/${PROCTORED}/proctor/claim`, { registration_id: registrationId }, second.apiKey) as never,
      params(PROCTORED)
    );
    expect(response.status).toBe(400);
    expect((await body(response)).error_detail).toEqual({
      code: "already_claimed",
      message: "Already claimed",
      hint: "A session already exists for this registration",
    });
    expect(evaluationSessions.size).toBe(1);
  });
});

describe("POST /api/v1/evaluations/{id}/proctor/submit", () => {
  const params = (id: string) => ({ params: Promise.resolve({ id }) });

  async function claimed(): Promise<{ candidate: StoredAgent; proctor: StoredAgent; registrationId: string }> {
    const candidate = makeAgent();
    const proctor = makeAgent();
    const registrationId = seedRegistration({ agentId: candidate.id, evaluationId: PROCTORED });
    await PROCTOR_CLAIM(
      post(`/api/v1/evaluations/${PROCTORED}/proctor/claim`, { registration_id: registrationId }, proctor.apiKey) as never,
      params(PROCTORED)
    );
    return { candidate, proctor, registrationId };
  }

  it("answers the created result with the proctor's attribution", async () => {
    const { proctor, registrationId } = await claimed();
    const response = await PROCTOR_SUBMIT(
      post(
        `/api/v1/evaluations/${PROCTORED}/proctor/submit`,
        { registration_id: registrationId, passed: true, proctor_feedback: "fine" },
        proctor.apiKey
      ) as never,
      params(PROCTORED)
    );
    const parsed = await body(response);
    expect(response.status).toBe(200);
    const result = parsed.result as Record<string, unknown>;
    expect(Object.keys(result).sort()).toEqual([
      "completed_at",
      "id",
      "max_score",
      "passed",
      "proctor_agent_id",
      "score",
    ]);
    expect(result.proctor_agent_id).toBe(proctor.id);
  });

  it("refuses an agent who did not claim the session", async () => {
    const { registrationId } = await claimed();
    const stranger = makeAgent();
    const response = await PROCTOR_SUBMIT(
      post(
        `/api/v1/evaluations/${PROCTORED}/proctor/submit`,
        { registration_id: registrationId, passed: true },
        stranger.apiKey
      ) as never,
      params(PROCTORED)
    );
    expect(response.status).toBe(403);
    expect((await body(response)).error_detail).toEqual({
      code: "not_claimed_proctor",
      message: "Forbidden",
      hint: "Only the proctor who claimed this registration may submit its result",
    });
    expect(evaluationResults.size).toBe(0);
  });

  it("refuses a body with no registration_id", async () => {
    const proctor = makeAgent();
    const response = await PROCTOR_SUBMIT(
      post(`/api/v1/evaluations/${PROCTORED}/proctor/submit`, { passed: true }, proctor.apiKey) as never,
      params(PROCTORED)
    );
    expect(response.status).toBe(400);
    expect(await body(response)).toEqual({
      success: false,
      error: "Missing registration_id",
      hint: "Body must include registration_id (string)",
      error_detail: {
        code: "bad_request",
        message: "Missing registration_id",
        hint: "Body must include registration_id (string)",
      },
    });
  });
});

describe("POST /api/v1/evaluations/{id}/sessions/{sessionId}/messages", () => {
  const params = (id: string, sessionId: string) => ({ params: Promise.resolve({ id, sessionId }) });

  async function session(): Promise<{ candidate: StoredAgent; proctor: StoredAgent; sessionId: string }> {
    const candidate = makeAgent();
    const proctor = makeAgent();
    const registrationId = seedRegistration({ agentId: candidate.id, evaluationId: PROCTORED });
    const response = await PROCTOR_CLAIM(
      post(`/api/v1/evaluations/${PROCTORED}/proctor/claim`, { registration_id: registrationId }, proctor.apiKey) as never,
      { params: Promise.resolve({ id: PROCTORED }) }
    );
    const sessionId = String((await body(response)).session_id);
    return { candidate, proctor, sessionId };
  }

  it("answers the message with the role DERIVED from the participant row", async () => {
    const { candidate, sessionId } = await session();
    const response = await SESSION_MESSAGE(
      post(
        `/api/v1/evaluations/${PROCTORED}/sessions/${sessionId}/messages`,
        { content: "  hello  ", role: "proctor" },
        candidate.apiKey
      ) as never,
      params(PROCTORED, sessionId)
    );
    const parsed = await body(response);
    expect(response.status).toBe(200);
    expect(parsed.success).toBe(true);
    expect(parsed.role).toBe("candidate");
    expect(parsed.content).toBe("hello");
    expect(parsed.sequence).toBe(1);
    expect(String(parsed.id)).toMatch(/^eval_msg/);
  });

  it("refuses empty content", async () => {
    const { candidate, sessionId } = await session();
    const response = await SESSION_MESSAGE(
      post(
        `/api/v1/evaluations/${PROCTORED}/sessions/${sessionId}/messages`,
        { content: "   " },
        candidate.apiKey
      ) as never,
      params(PROCTORED, sessionId)
    );
    expect(response.status).toBe(400);
    expect(await body(response)).toEqual({
      success: false,
      error: "Empty content",
      hint: "Message content cannot be empty",
      error_detail: {
        code: "bad_request",
        message: "Empty content",
        hint: "Message content cannot be empty",
      },
    });
    expect(evaluationMessages.size).toBe(0);
  });

  it("refuses a non-participant", async () => {
    const { sessionId } = await session();
    const stranger = makeAgent();
    const response = await SESSION_MESSAGE(
      post(
        `/api/v1/evaluations/${PROCTORED}/sessions/${sessionId}/messages`,
        { content: "hi" },
        stranger.apiKey
      ) as never,
      params(PROCTORED, sessionId)
    );
    expect(response.status).toBe(403);
    expect((await body(response)).error_detail).toEqual({
      code: "not_a_participant",
      message: "Forbidden",
      hint: "You are not a participant in this session",
    });
  });
});

describe("the agent-tool surface", () => {
  it("register_for_evaluation answers the registration id and its timestamp", async () => {
    const agent = makeAgent();
    const result = await evaluationTools.register_for_evaluation(
      { evaluation_id: SELF_SERVE },
      { agent } as never
    );
    expect(result.success).toBe(true);
    expect(Object.keys(result.data as object).sort()).toEqual(["registered_at", "registration_id"]);
  });

  it("register_for_evaluation answers a standing registration with its note", async () => {
    const agent = makeAgent();
    const registrationId = seedRegistration({ agentId: agent.id, evaluationId: SELF_SERVE, status: "registered" });
    const result = await evaluationTools.register_for_evaluation(
      { evaluation_id: SELF_SERVE },
      { agent } as never
    );
    expect(result.data).toEqual({
      registration_id: registrationId,
      status: "registered",
      note: "Already registered",
    });
  });

  it("register_for_evaluation renders a C2 denial as '<code>: <error>: <hint>'", async () => {
    const agent = makeAgent({ isVetted: false });
    const result = await evaluationTools.register_for_evaluation(
      { evaluation_id: SELF_SERVE },
      { agent } as never
    );
    expect(result).toEqual({
      success: false,
      error:
        "vetting_required: Agent must be vetted to act on Foundation School evaluations: " +
        "Complete the vetting challenge first. POST to /api/v1/agents/vetting/start",
    });
  });

  it("start_evaluation reports a refused CAS as the already-in-progress shape", async () => {
    const agent = makeAgent();
    const registrationId = seedRegistration({ agentId: agent.id, evaluationId: PROCTORED, status: "in_progress" });
    const result = await evaluationTools.start_evaluation(
      { evaluation_id: PROCTORED },
      { agent } as never
    );
    expect(result.data).toEqual({
      registration_id: registrationId,
      status: "in_progress",
      note: "Already in progress",
    });
  });

  it("start_evaluation answers the started shape", async () => {
    const agent = makeAgent();
    const registrationId = seedRegistration({ agentId: agent.id, evaluationId: PROCTORED, status: "registered" });
    const result = await evaluationTools.start_evaluation(
      { evaluation_id: PROCTORED },
      { agent } as never
    );
    expect(result.data).toEqual({
      registration_id: registrationId,
      status: "in_progress",
      note: "Evaluation started. Follow the evaluation-specific flow to complete it.",
    });
  });

  it("claim_proctor_session answers only the session id", async () => {
    const candidate = makeAgent();
    const proctor = makeAgent();
    const registrationId = seedRegistration({ agentId: candidate.id, evaluationId: PROCTORED });
    const result = await evaluationTools.claim_proctor_session(
      { registration_id: registrationId },
      { agent: proctor } as never
    );
    expect(Object.keys(result.data as object)).toEqual(["session_id"]);
  });

  it("send_eval_session_message answers the id and sequence, and never the role", async () => {
    const candidate = makeAgent();
    const proctor = makeAgent();
    const registrationId = seedRegistration({ agentId: candidate.id, evaluationId: PROCTORED });
    const claim = await evaluationTools.claim_proctor_session(
      { registration_id: registrationId },
      { agent: proctor } as never
    );
    const sessionId = (claim.data as { session_id: string }).session_id;
    const result = await evaluationTools.send_eval_session_message(
      { session_id: sessionId, content: "hello" },
      { agent: candidate } as never
    );
    expect(Object.keys(result.data as object).sort()).toEqual(["message_id", "sequence"]);
    expect(evaluationMessages.size).toBe(1);
    expect(Array.from(evaluationMessages.values())[0].role).toBe("candidate");
  });

  it("submit_evaluation_result answers { submitted, passed } and ends the session", async () => {
    const candidate = makeAgent();
    const proctor = makeAgent();
    const registrationId = seedRegistration({ agentId: candidate.id, evaluationId: PROCTORED });
    const claim = await evaluationTools.claim_proctor_session(
      { registration_id: registrationId },
      { agent: proctor } as never
    );
    const sessionId = (claim.data as { session_id: string }).session_id;
    const result = await evaluationTools.submit_evaluation_result(
      { registration_id: registrationId, passed: true },
      { agent: proctor } as never
    );
    expect(result).toEqual({ success: true, data: { submitted: true, passed: true } });
    expect(evaluationSessions.get(sessionId)!.status).toBe("ended");
  });

  it("submit_evaluation_result refuses a stranger", async () => {
    const candidate = makeAgent();
    const proctor = makeAgent();
    const stranger = makeAgent();
    const registrationId = seedRegistration({ agentId: candidate.id, evaluationId: PROCTORED });
    await evaluationTools.claim_proctor_session(
      { registration_id: registrationId },
      { agent: proctor } as never
    );
    const result = await evaluationTools.submit_evaluation_result(
      { registration_id: registrationId, passed: true },
      { agent: stranger } as never
    );
    expect(result).toEqual({
      success: false,
      error:
        "not_claimed_proctor: Forbidden: Only the proctor who claimed this registration may submit its result",
    });
    expect(evaluationResults.size).toBe(0);
  });
});

describe("C2 denial parity through both adapters", () => {
  it.each([
    {
      name: "registration requires vetting",
      runRoute: async (agent: StoredAgent) => body(await EVAL_REGISTER(
        post(`/api/v1/evaluations/${SELF_SERVE}/register`, {}, agent.apiKey) as never,
        { params: Promise.resolve({ id: SELF_SERVE }) }
      )),
      runTool: (agent: StoredAgent) => evaluationTools.register_for_evaluation(
        { evaluation_id: SELF_SERVE }, { agent } as never
      ),
      setup: () => ({ isVetted: false }),
      expectedRoute: "Agent must be vetted to access the Foundation School",
      expectedTool: "vetting_required",
    },
    {
      name: "start requires registration",
      runRoute: async (agent: StoredAgent) => body(await EVAL_START(
        post(`/api/v1/evaluations/${PROCTORED}/start`, {}, agent.apiKey) as never,
        { params: Promise.resolve({ id: PROCTORED }) }
      )),
      runTool: (agent: StoredAgent) => evaluationTools.start_evaluation(
        { evaluation_id: PROCTORED }, { agent } as never
      ),
      setup: () => ({}),
      expectedRoute: "not_registered",
      expectedTool: "not_registered",
    },
  ])("$name has one denial decision in route and tool", async ({ runRoute, runTool, setup, expectedRoute, expectedTool }) => {
    const agent = makeAgent(setup());
    const routeBefore = evaluationStateSnapshot();
    const routeResult = await runRoute(agent);
    expect(evaluationStateSnapshot()).toBe(routeBefore);
    const toolBefore = evaluationStateSnapshot();
    const toolResult = await runTool(agent);
    expect(evaluationStateSnapshot()).toBe(toolBefore);
    expect(JSON.stringify(routeResult)).toContain(expectedRoute);
    expect(JSON.stringify(toolResult)).toContain(expectedTool);
  });

  it.each([
    {
      name: "proctor claim",
      route: (agent: StoredAgent) => PROCTOR_CLAIM(post("/api/v1/evaluations/non-spamminess/proctor/claim", { registration_id: "missing" }, agent.apiKey) as never, { params: Promise.resolve({ id: PROCTORED }) }),
      tool: (agent: StoredAgent) => evaluationTools.claim_proctor_session({ registration_id: "missing" }, { agent } as never),
    },
    {
      name: "session message",
      route: (agent: StoredAgent) => SESSION_MESSAGE(post("/api/v1/evaluations/non-spamminess/sessions/missing/messages", { content: "hello" }, agent.apiKey) as never, { params: Promise.resolve({ id: PROCTORED, sessionId: "missing" }) }),
      tool: (agent: StoredAgent) => evaluationTools.send_eval_session_message({ session_id: "missing", content: "hello" }, { agent } as never),
    },
    {
      name: "proctor submission",
      route: (agent: StoredAgent) => PROCTOR_SUBMIT(post("/api/v1/evaluations/non-spamminess/proctor/submit", { registration_id: "missing", passed: true }, agent.apiKey) as never, { params: Promise.resolve({ id: PROCTORED }) }),
      tool: (agent: StoredAgent) => evaluationTools.submit_evaluation_result({ registration_id: "missing", passed: true }, { agent } as never),
    },
  ])("$name has matching denial and no mutation", async ({ route, tool }) => {
    const agent = makeAgent();
    const before = { registrations: evaluationRegistrations.size, sessions: evaluationSessions.size, messages: evaluationMessages.size, results: evaluationResults.size };
    const routeBefore = evaluationStateSnapshot();
    const routeResponse = await route(agent);
    expect(evaluationStateSnapshot()).toBe(routeBefore);
    const toolBefore = evaluationStateSnapshot();
    const toolResult = await tool(agent);
    expect(evaluationStateSnapshot()).toBe(toolBefore);
    expect(routeResponse.status).toBeGreaterThanOrEqual(400);
    expect(JSON.stringify(await routeResponse.json())).toContain("not_found");
    expect(JSON.stringify(toolResult)).toContain("not_found");
    expect({ registrations: evaluationRegistrations.size, sessions: evaluationSessions.size, messages: evaluationMessages.size, results: evaluationResults.size }).toEqual(before);
  });
});

/**
 * The wire and behavior changes u3e makes **on purpose**, recorded here rather than absorbed into a
 * silently adjusted pin above.
 *
 * Every one of them is the same shape: the REST surface and the tool surface disagreed, the action
 * layer forces one decision, and the surface that was WRONGER moves. None of them changes a success
 * body's field set.
 */
describe("recorded behavior changes", () => {
  /**
   * The route has always refused a registration whose prerequisites are unmet; the tool executor
   * never checked at all, so an agent could register for a gated evaluation through the loop and
   * not through the API. The rule now lives in the action, so both surfaces make it.
   *
   * Driven at the ACTION rather than through the tool because the tool is Foundation-only by
   * design (M11-1 C2) and **no active Foundation evaluation has prerequisites** — the one that does
   * (`non-spamminess`) is `draft`, so registration refuses on status first. AO's
   * `ao-founding-team-design` is active and gated, which is what makes the branch reachable at all.
   */
  it("the prerequisite rule is the ACTION's, so both surfaces apply it", async () => {
    const agent = makeAgent({ isAdmitted: true });
    const denied = await actionRegisterForEvaluation({
      agent,
      evaluationId: "ao-founding-team-design",
      schoolId: "ao",
    });
    expect(denied.ok).toBe(false);
    if (denied.ok) throw new Error("unreachable");
    expect(denied.denial).toEqual({
      code: "bad_request",
      error: "Prerequisites not met",
      status: 400,
      hint: "You must complete the following evaluations first: ao-market-opportunity-analysis",
    });
    expect(evaluationRegistrations.size).toBe(0);
  });

  /**
   * The tool called `endSession` AFTER `saveEvaluationResult` returned, so a failure between them
   * left a completed registration with an active proctor session — the state M11-1b D4 removed from
   * the route. The session now ends inside the completion transaction on both surfaces, and the
   * observable consequence is that a completion which writes NOTHING no longer ends the session.
   */
  it("the submit TOOL ends the proctor session inside the completion, not after it", async () => {
    const candidate = makeAgent();
    const proctor = makeAgent();
    const registrationId = seedRegistration({ agentId: candidate.id, evaluationId: PROCTORED });
    const claim = await evaluationTools.claim_proctor_session(
      { registration_id: registrationId },
      { agent: proctor } as never
    );
    const sessionId = (claim.data as { session_id: string }).session_id;
    // A registration dragged terminal between the claim and the submit: the completion writes
    // nothing, so the session must survive for whoever really completed it.
    evaluationRegistrations.get(registrationId)!.status = "cancelled";
    const result = await evaluationTools.submit_evaluation_result(
      { registration_id: registrationId, passed: true },
      { agent: proctor } as never
    );
    expect(result.success).toBe(false);
    expect(evaluationSessions.get(sessionId)!.status).toBe("active");
  });

  /**
   * `Boolean(args.passed)` turned any non-boolean into a silent `false` on the tool surface while
   * the route handed the body to the executor, whose whole job is to validate it. One behavior now,
   * and it is the strict one.
   */
  it("the submit TOOL no longer coerces a non-boolean verdict", async () => {
    executorResult.value = { passed: false, error: "Invalid submission: passed must be a boolean" };
    const candidate = makeAgent();
    const proctor = makeAgent();
    const registrationId = seedRegistration({ agentId: candidate.id, evaluationId: PROCTORED });
    await evaluationTools.claim_proctor_session(
      { registration_id: registrationId },
      { agent: proctor } as never
    );
    const result = await evaluationTools.submit_evaluation_result(
      { registration_id: registrationId, passed: "yes" },
      { agent: proctor } as never
    );
    expect(result.success).toBe(false);
    expect(String(result.error)).toContain("passed must be a boolean");
    expect(evaluationResults.size).toBe(0);
  });

  /**
   * `String(args.content)` wrote `"undefined"` into a transcript when the argument was missing.
   * The content rule is the action's now, so the tool shares the route's refusal.
   */
  it("the message TOOL no longer coerces a missing body into the transcript", async () => {
    const candidate = makeAgent();
    const proctor = makeAgent();
    const registrationId = seedRegistration({ agentId: candidate.id, evaluationId: PROCTORED });
    const claim = await evaluationTools.claim_proctor_session(
      { registration_id: registrationId },
      { agent: proctor } as never
    );
    const sessionId = (claim.data as { session_id: string }).session_id;
    const result = await evaluationTools.send_eval_session_message(
      { session_id: sessionId },
      { agent: candidate } as never
    );
    expect(result.success).toBe(false);
    expect(String(result.error)).toContain("Missing content");
    expect(evaluationMessages.size).toBe(0);
  });

  /**
   * The tool published its own sentence for a lost claim; it now renders C2's denial like every
   * other refusal on this surface, so the two channels say the same thing.
   */
  it("the claim TOOL renders already_claimed through C2's envelope", async () => {
    const candidate = makeAgent();
    const first = makeAgent();
    const second = makeAgent();
    const registrationId = seedRegistration({ agentId: candidate.id, evaluationId: PROCTORED });
    await evaluationTools.claim_proctor_session(
      { registration_id: registrationId },
      { agent: first } as never
    );
    const result = await evaluationTools.claim_proctor_session(
      { registration_id: registrationId },
      { agent: second } as never
    );
    expect(result).toEqual({
      success: false,
      error: "already_claimed: Already claimed: A session already exists for this registration",
    });
  });

  /**
   * P6.1's grammar window opens as a WARNING (Decision 11 — never an immediate break): the
   * registration still succeeds, and the notice is machine-readable. A conforming name carries no
   * `meta` key at all, so nothing changes for a caller already inside the grammar.
   */
  it("registration warns about a nonconforming name and still registers it", async () => {
    const response = await REGISTER_AGENT(
      post("/api/v1/agents/register", { name: "a name with spaces" })
    );
    const parsed = await body(response);
    expect(response.status).toBe(200);
    expect(parsed.success).toBe(true);
    expect(parsed.meta).toEqual({
      deprecations: [
        {
          field: "name",
          replacement_grammar: "^[a-zA-Z0-9_-]{2,64}$",
          enforce_after: "M11b",
        },
      ],
    });
  });

  it("registration carries no meta at all for a conforming name", async () => {
    const response = await REGISTER_AGENT(post("/api/v1/agents/register", { name: nextId("ok") }));
    expect(await body(response)).not.toHaveProperty("meta");
  });
});
