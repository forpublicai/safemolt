/**
 * M11-1 C21 — one result, one payout, per registration (memory mode).
 *
 * The mint was in the points model: `agents.points` is recomputed as SUM(points_earned) over
 * passed rows, so a second result row for one registration doubled the agent's points. These
 * tests drive the memory store and both public surfaces; the db-mode races and the migration
 * fixtures are `[integration]` gates in `src/__tests__/integration/c21-result-uniqueness.test.ts`.
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
import * as mem from "@/lib/store/evaluations/memory";
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

/** Foundation-only, not proctored (`schools/foundation/evaluations/SIP-2.md`). */
const FOUNDATION_ONLY = "poaw";
/** A Foundation evaluation that really is proctored (`schools/foundation/evaluations/SIP-5.md`). */
const PROCTORED = "non-spamminess";

let seq = 0;

function makeAgent(overrides: Partial<StoredAgent> & { id: string }): StoredAgent {
  const agent: StoredAgent = {
    name: overrides.id,
    description: "",
    apiKey: `key_${overrides.id}`,
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

function seedRegistration(opts: {
  agentId: string;
  evaluationId: string;
  status?: "registered" | "in_progress" | "completed" | "failed" | "cancelled";
}): string {
  const id = `reg_${++seq}`;
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

async function routes() {
  return {
    claim: (await import("@/app/api/v1/evaluations/[id]/proctor/claim/route")).POST,
    proctorSubmit: (await import("@/app/api/v1/evaluations/[id]/proctor/submit/route")).POST,
    selfSubmit: (await import("@/app/api/v1/evaluations/[id]/submit/route")).POST,
    register: (await import("@/app/api/v1/evaluations/[id]/register/route")).POST,
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

describe("store: the save is gated and pays at most once", () => {
  it("records once, then classifies the second save as already_complete with no second payout", async () => {
    const agent = makeAgent({ id: "cand" });
    const registrationId = seedRegistration({ agentId: agent.id, evaluationId: FOUNDATION_ONLY });

    const first = await mem.saveEvaluationResult(registrationId, agent.id, FOUNDATION_ONLY, true, 5, 10);
    if (first.outcome !== "created") throw new Error(`expected created, got ${first.outcome}`);
    const pointsAfterFirst = agents.get(agent.id)!.points;
    expect(pointsAfterFirst).toBe(5);
    expect(evaluationRegistrations.get(registrationId)!.status).toBe("completed");

    const second = await mem.saveEvaluationResult(registrationId, agent.id, FOUNDATION_ONLY, true, 5, 10);
    expect(second.outcome).toBe("already_complete");
    if (second.outcome === "already_complete") {
      expect(second.existing.id).toBe(first.resultId);
    }

    // Asserted on the points, not merely the row count — the count can be right while the sum is
    // wrong, and the sum is the mint.
    expect(agents.get(agent.id)!.points).toBe(pointsAfterFirst);
    expect(Array.from(evaluationResults.values()).filter((r) => r.registrationId === registrationId)).toHaveLength(1);
  });

  it("two simultaneous saves for one registration yield exactly one row and one payout", async () => {
    const agent = makeAgent({ id: "cand" });
    const registrationId = seedRegistration({ agentId: agent.id, evaluationId: FOUNDATION_ONLY });

    const outcomes = await Promise.all([
      mem.saveEvaluationResult(registrationId, agent.id, FOUNDATION_ONLY, true, 5, 10),
      mem.saveEvaluationResult(registrationId, agent.id, FOUNDATION_ONLY, true, 5, 10),
    ]);

    expect(outcomes.filter((o) => o.outcome === "created")).toHaveLength(1);
    expect(outcomes.filter((o) => o.outcome === "already_complete")).toHaveLength(1);
    expect(Array.from(evaluationResults.values()).filter((r) => r.registrationId === registrationId)).toHaveLength(1);
    expect(agents.get(agent.id)!.points).toBe(5);
  });

  it("refuses a registration with no result to return (cancelled) as not_actionable, writing nothing", async () => {
    const agent = makeAgent({ id: "cand" });
    const registrationId = seedRegistration({ agentId: agent.id, evaluationId: FOUNDATION_ONLY, status: "cancelled" });

    const saved = await mem.saveEvaluationResult(registrationId, agent.id, FOUNDATION_ONLY, true, 5, 10);

    expect(saved.outcome).toBe("not_actionable");
    expect(evaluationResults.size).toBe(0);
    expect(evaluationRegistrations.get(registrationId)!.status).toBe("cancelled");
    expect(agents.get(agent.id)!.points).toBe(0);
  });

  it("records a failed result exactly once and awards nothing", async () => {
    const agent = makeAgent({ id: "cand" });
    const registrationId = seedRegistration({ agentId: agent.id, evaluationId: FOUNDATION_ONLY });

    const first = await mem.saveEvaluationResult(registrationId, agent.id, FOUNDATION_ONLY, false, 0, 10);
    if (first.outcome !== "created") throw new Error(`expected created, got ${first.outcome}`);
    expect(evaluationRegistrations.get(registrationId)!.status).toBe("failed");
    expect(agents.get(agent.id)!.points).toBe(0);

    const second = await mem.saveEvaluationResult(registrationId, agent.id, FOUNDATION_ONLY, false, 0, 10);
    expect(second.outcome).toBe("already_complete");
    expect(Array.from(evaluationResults.values())).toHaveLength(1);
  });
});

describe("self-serve route: a re-submit is idempotent, not a 500 and not a second mint", () => {
  it("returns the standing result on re-submit, without re-invoking the executor", async () => {
    const agent = makeAgent({ id: "cand" });
    seedRegistration({ agentId: agent.id, evaluationId: FOUNDATION_ONLY });
    const { selfSubmit } = await routes();

    const first = await selfSubmit(post(`${BASE}/api/v1/evaluations/${FOUNDATION_ONLY}/submit`, {}, agent.apiKey) as never, {
      params: Promise.resolve({ id: FOUNDATION_ONLY }),
    });
    expect(first.status).toBe(200);
    const firstBody = await first.json();
    const pointsAfterFirst = agents.get(agent.id)!.points;
    const executorCalls = handler.mock.calls.length;

    const second = await selfSubmit(post(`${BASE}/api/v1/evaluations/${FOUNDATION_ONLY}/submit`, {}, agent.apiKey) as never, {
      params: Promise.resolve({ id: FOUNDATION_ONLY }),
    });
    expect(second.status).toBe(200);
    const secondBody = await second.json();

    expect(secondBody.result.id).toBe(firstBody.result.id);
    expect(secondBody.result.passed).toBe(firstBody.result.passed);
    expect(agents.get(agent.id)!.points).toBe(pointsAfterFirst);
    // The replay never reaches the executor — a repeat that still runs handler work would be the
    // cost-before-authorization failure class all over again.
    expect(handler.mock.calls.length).toBe(executorCalls);
  });
});

describe("a prior pass closes registration — the surviving mint the review found", () => {
  it("refuses re-registration of a passed evaluation on both surfaces; a failed attempt stays retryable", async () => {
    const agent = makeAgent({ id: "repeat" });
    const registrationId = seedRegistration({ agentId: agent.id, evaluationId: FOUNDATION_ONLY });
    const first = await mem.saveEvaluationResult(registrationId, agent.id, FOUNDATION_ONLY, true, 5, 10);
    if (first.outcome !== "created") throw new Error(`expected created, got ${first.outcome}`);
    const pointsAfterPass = agents.get(agent.id)!.points;

    // Route surface: without this gate, register → start → submit would mint the pass's points
    // again, unboundedly, from the agent's own credentials.
    const { register } = await routes();
    const denied = await register(post(`${BASE}/api/v1/evaluations/${FOUNDATION_ONLY}/register`, {}, agent.apiKey) as never, {
      params: Promise.resolve({ id: FOUNDATION_ONLY }),
    });
    expect(denied.status).toBe(409);
    expect((await denied.json()).error_detail.code).toBe("evaluation_already_passed");

    // Tool surface: same rule, same module.
    const toolDenied = await executors.register_for_evaluation({ evaluation_id: FOUNDATION_ONLY }, { agent });
    expect(toolDenied.success).toBe(false);
    expect(String(toolDenied.error)).toContain("evaluation_already_passed");

    expect(Array.from(evaluationRegistrations.values()).filter((r) => r.agentId === agent.id)).toHaveLength(1);
    expect(agents.get(agent.id)!.points).toBe(pointsAfterPass);

    // A *failed* attempt keeps the retry open — failure is terminal and mints nothing, so a fresh
    // registration is the documented path back in.
    const failer = makeAgent({ id: "failer" });
    const failedReg = seedRegistration({ agentId: failer.id, evaluationId: FOUNDATION_ONLY });
    await mem.saveEvaluationResult(failedReg, failer.id, FOUNDATION_ONLY, false, 0, 10);
    const retry = await register(post(`${BASE}/api/v1/evaluations/${FOUNDATION_ONLY}/register`, {}, failer.apiKey) as never, {
      params: Promise.resolve({ id: FOUNDATION_ONLY }),
    });
    expect(retry.status).toBe(200);
    expect((await retry.json()).registration.status).toBe("registered");
  });
});

describe("the one-payout invariant holds below the authorization layer", () => {
  it("the store's registration insert itself refuses a prior pass — the pre-check cannot go stale", async () => {
    // The authorization check is a read; a completion can land between it and the insert. The
    // insert is gated in the same decisive section, so calling the store directly — as a stale
    // pre-check effectively does — still refuses.
    const agent = makeAgent({ id: "toctou" });
    const registrationId = seedRegistration({ agentId: agent.id, evaluationId: FOUNDATION_ONLY });
    const saved = await mem.saveEvaluationResult(registrationId, agent.id, FOUNDATION_ONLY, true, 5, 10);
    if (saved.outcome !== "created") throw new Error(`expected created, got ${saved.outcome}`);

    expect(await mem.registerForEvaluation(agent.id, FOUNDATION_ONLY)).toBeNull();
  });

  it("a second passing save for the same (agent, evaluation) refuses even on a different registration", async () => {
    // The last concurrent sliver: a registration that slipped in before the pass committed. The
    // save itself enforces one passed result per (agent, evaluation) — the memory mirror of the
    // partial unique index — so the slipped-through registration cannot mint.
    const agent = makeAgent({ id: "sliver" });
    const first = seedRegistration({ agentId: agent.id, evaluationId: FOUNDATION_ONLY });
    const saved = await mem.saveEvaluationResult(first, agent.id, FOUNDATION_ONLY, true, 5, 10);
    if (saved.outcome !== "created") throw new Error(`expected created, got ${saved.outcome}`);
    const pointsAfterPass = agents.get(agent.id)!.points;

    const slipped = seedRegistration({ agentId: agent.id, evaluationId: FOUNDATION_ONLY });
    const second = await mem.saveEvaluationResult(slipped, agent.id, FOUNDATION_ONLY, true, 5, 10);

    expect(second.outcome).toBe("not_actionable");
    expect(evaluationRegistrations.get(slipped)!.status).toBe("in_progress");
    expect(agents.get(agent.id)!.points).toBe(pointsAfterPass);
    // A *failed* second attempt on another registration still records — the invariant covers
    // passes (the payout), not verdicts.
    const failed = await mem.saveEvaluationResult(slipped, agent.id, FOUNDATION_ONLY, false, 0, 10);
    expect(failed.outcome).toBe("created");
  });
});

describe("proctor surfaces: the loser and the re-submitter get the standing verdict", () => {
  async function claimedSession() {
    const candidate = makeAgent({ id: "cand" });
    const claimant = makeAgent({ id: "claimant" });
    const registrationId = seedRegistration({ agentId: candidate.id, evaluationId: PROCTORED });
    const { claim } = await routes();
    const res = await claim(
      post(`${BASE}/api/v1/evaluations/${PROCTORED}/proctor/claim`, { registration_id: registrationId }, claimant.apiKey) as never,
      { params: Promise.resolve({ id: PROCTORED }) }
    );
    expect(res.status).toBe(200);
    return { candidate, claimant, registrationId };
  }

  it("route re-submit by the recorded proctor replays the result; a stranger keeps the denial", async () => {
    const { claimant, registrationId } = await claimedSession();
    const { proctorSubmit } = await routes();

    const first = await proctorSubmit(
      post(`${BASE}/api/v1/evaluations/${PROCTORED}/proctor/submit`, { registration_id: registrationId, passed: true }, claimant.apiKey) as never,
      { params: Promise.resolve({ id: PROCTORED }) }
    );
    expect(first.status).toBe(200);
    const firstBody = await first.json();

    const replay = await proctorSubmit(
      post(`${BASE}/api/v1/evaluations/${PROCTORED}/proctor/submit`, { registration_id: registrationId, passed: true }, claimant.apiKey) as never,
      { params: Promise.resolve({ id: PROCTORED }) }
    );
    expect(replay.status).toBe(200);
    const replayBody = await replay.json();
    expect(replayBody.result.id).toBe(firstBody.result.id);
    expect(replayBody.result.proctor_agent_id).toBe(claimant.id);

    // The replay is strictly for the recorded proctor — anyone else keeps the denial, so the
    // idempotent path discloses nothing authorization would refuse.
    const stranger = makeAgent({ id: "stranger" });
    const denied = await proctorSubmit(
      post(`${BASE}/api/v1/evaluations/${PROCTORED}/proctor/submit`, { registration_id: registrationId, passed: false }, stranger.apiKey) as never,
      { params: Promise.resolve({ id: PROCTORED }) }
    );
    expect(denied.status).toBe(400);
    expect((await denied.json()).error_detail.code).toBe("invalid_registration_status");
  });

  it("tool re-submit returns the enumerated idempotency error and does not double-pay", async () => {
    const { candidate, claimant, registrationId } = await claimedSession();

    const first = await executors.submit_evaluation_result(
      { registration_id: registrationId, passed: true },
      { agent: agents.get(claimant.id)! }
    );
    expect(first.success).toBe(true);
    const pointsAfterFirst = agents.get(candidate.id)!.points;

    const second = await executors.submit_evaluation_result(
      { registration_id: registrationId, passed: true },
      { agent: agents.get(claimant.id)! }
    );
    expect(second.success).toBe(false);
    expect(String(second.error)).toContain("invalid_registration_status");

    expect(agents.get(candidate.id)!.points).toBe(pointsAfterFirst);
    expect(Array.from(evaluationResults.values()).filter((r) => r.registrationId === registrationId)).toHaveLength(1);
  });
});
