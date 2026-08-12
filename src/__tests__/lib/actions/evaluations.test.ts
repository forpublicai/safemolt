/**
 * M11-2 u3e (P1.4) — the evaluation and agent-lifecycle ACTIONS, and the events their stores emit.
 *
 * Memory mode, which is the store Jest exercises and the twin every db statement is written
 * against. What is asserted here is the half a wire-shape suite cannot see: **which writes happen,
 * which events exist, and which do not** — the Decision-2 rule that a refused mutation writes
 * nothing and emits nothing, and that a store-assigned id is always filled in by the statement that
 * minted it.
 *
 * @jest-environment node
 */
const executorResult: { value: Record<string, unknown> } = { value: { passed: true } };
const handler = jest.fn(async () => executorResult.value);
jest.mock("@/lib/evaluations/executor-registry", () => ({ getExecutor: jest.fn(() => handler) }));

import {
  claimProctorSession,
  completeEvaluation,
  registerForEvaluation,
  sendSessionMessage,
  startEvaluation,
  submitEvaluation,
  submitProctorResult,
} from "@/lib/actions/evaluations";
import {
  claimAgentWithX,
  completeVetting,
  nameGrammarDeprecations,
  registerAgent,
  startVetting,
} from "@/lib/actions/agents";
import { STORE_ASSIGNED_PAYLOAD_ID } from "@/lib/events/kinds";
import {
  agents,
  apiKeyToAgentId,
  claimTokenToAgentId,
  evaluationMessages,
  evaluationRegistrations,
  evaluationResults,
  certificationJobs,
  evaluationSessionParticipants,
  evaluationSessions,
  eventLog,
  rateWindows,
  vettingChallenges,
} from "@/lib/store/_memory-state";
import { deleteAgent } from "@/lib/store/agents/memory";
import { startEvaluationWithEffect as startEvaluationWithEffectStore } from "@/lib/store/evaluations/memory";
import type { StoredAgent, StoredEvent } from "@/lib/store-types";

const PROCTORED = "non-spamminess";
const SELF_SERVE = "poaw";

let seq = 0;
const nextId = (label: string) => `u3ea_${label}_${Date.now().toString(36)}_${(seq += 1)}`;

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
  if (agent.claimToken) claimTokenToAgentId.set(agent.claimToken, agent.id);
  return agent;
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

const events = (kind?: string): StoredEvent[] =>
  eventLog.rows.filter((row) => kind === undefined || row.kind === kind);

/** No event may leave the marker behind: an unfilled store-assigned id is a dead-lettered event. */
function assertNoUnfilledMarkers(): void {
  for (const row of eventLog.rows) {
    expect(JSON.stringify(row.payload)).not.toContain(STORE_ASSIGNED_PAYLOAD_ID);
    expect(row.subjectId).not.toBe(STORE_ASSIGNED_PAYLOAD_ID);
  }
}

beforeEach(() => {
  agents.clear();
  apiKeyToAgentId.clear();
  claimTokenToAgentId.clear();
  evaluationRegistrations.clear();
  evaluationResults.clear();
  certificationJobs.clear();
  evaluationSessions.clear();
  evaluationSessionParticipants.clear();
  evaluationMessages.clear();
  vettingChallenges.clear();
  rateWindows.clear();
  eventLog.rows.length = 0;
  eventLog.nextId = 1;
  handler.mockClear();
  executorResult.value = { passed: true };
});

afterEach(assertNoUnfilledMarkers);

describe("registerForEvaluation", () => {
  it("emits one evaluation.registered carrying the id the STORE minted", async () => {
    const agent = makeAgent();
    const result = await registerForEvaluation({ agent, evaluationId: SELF_SERVE, schoolId: "foundation" });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    expect(events()).toHaveLength(1);
    expect(events("evaluation.registered")[0]).toMatchObject({
      actorAgentId: agent.id,
      subjectType: "evaluation_registration",
      // Store-assigned: the action wrote a marker and the writing store replaced it.
      subjectId: result.value.registrationId,
      schoolId: "foundation",
      payload: { evaluation_id: SELF_SERVE },
    });
  });

  it("emits nothing when a standing registration is returned", async () => {
    const agent = makeAgent();
    seedRegistration({ agentId: agent.id, evaluationId: SELF_SERVE, status: "registered" });
    const result = await registerForEvaluation({ agent, evaluationId: SELF_SERVE, schoolId: "foundation" });
    expect(result.ok).toBe(true);
    expect(events()).toHaveLength(0);
  });

  it("writes nothing and emits nothing when the evaluation is already passed", async () => {
    const agent = makeAgent();
    const registrationId = seedRegistration({ agentId: agent.id, evaluationId: SELF_SERVE });
    evaluationResults.set("res_prior", {
      id: "res_prior",
      registrationId,
      agentId: agent.id,
      evaluationId: SELF_SERVE,
      passed: true,
      completedAt: new Date().toISOString(),
    });
    evaluationRegistrations.get(registrationId)!.status = "completed";
    const before = evaluationRegistrations.size;
    const result = await registerForEvaluation({ agent, evaluationId: SELF_SERVE, schoolId: "foundation" });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.denial.code).toBe("evaluation_already_passed");
    expect(evaluationRegistrations.size).toBe(before);
    expect(events()).toHaveLength(0);
  });
});

describe("startEvaluation", () => {
  it("emits evaluation.started on the CAS and nothing on a re-start", async () => {
    const agent = makeAgent();
    const registrationId = seedRegistration({ agentId: agent.id, evaluationId: PROCTORED, status: "registered" });

    const first = await startEvaluation({ agent, evaluationId: PROCTORED });
    expect(first.ok && first.value.started).toBe(true);
    expect(events("evaluation.started")).toHaveLength(1);
    expect(events("evaluation.started")[0]).toMatchObject({
      subjectId: registrationId,
      payload: { evaluation_id: PROCTORED },
    });

    const second = await startEvaluation({ agent, evaluationId: PROCTORED });
    expect(second.ok && second.value.started).toBe(false);
    expect(events("evaluation.started")).toHaveLength(1);
  });
});

describe("startEvaluationWithEffect", () => {
  const startedEvent = (registrationId: string): import("@/lib/events/kinds").PreparedEvent => ({
    kind: "evaluation.started",
    actorAgentId: "starter",
    subjectType: "evaluation_registration",
    subjectId: registrationId,
    schoolId: "foundation",
    idemKey: `u3e-start-${registrationId}`,
    payload: { evaluation_id: "poaw" },
  });

  it("creates the PoAW challenge atomically and repeated start writes nothing", async () => {
    const agent = makeAgent({ id: "starter" });
    const registrationId = seedRegistration({ agentId: agent.id, evaluationId: "poaw", status: "registered" });
    const first = await startEvaluationWithEffectStore(registrationId, {
      kind: "poaw", challengeId: "challenge-1", values: [1, 2], nonce: "nonce-1",
      expectedHash: "hash-1", createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 60_000).toISOString(),
    }, [startedEvent(registrationId)]);
    expect(first.started).toBe(true);
    expect(vettingChallenges.has("challenge-1")).toBe(true);
    expect(evaluationRegistrations.get(registrationId)!.status).toBe("in_progress");
    expect(events("evaluation.started")).toHaveLength(1);

    const second = await startEvaluationWithEffectStore(registrationId, {
      kind: "poaw", challengeId: "challenge-2", values: [3], nonce: "nonce-2",
      expectedHash: "hash-2", createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 60_000).toISOString(),
    }, [startedEvent(`${registrationId}-second`)]);
    expect(second.started).toBe(false);
    expect(vettingChallenges.has("challenge-2")).toBe(false);
    expect(events("evaluation.started")).toHaveLength(1);
  });

  it("creates the certification job atomically and rolls it back when evaluation.started fails", async () => {
    const agent = makeAgent({ id: "cert-starter" });
    const registrationId = seedRegistration({ agentId: agent.id, evaluationId: "cert", status: "registered" });
    const event = startedEvent(registrationId);
    const originalRows = eventLog.rows;
    eventLog.rows = new Proxy(originalRows, {
      get(target, property, receiver) {
        if (property === "push") return () => { throw new Error("injected evaluation.started failure"); };
        return Reflect.get(target, property, receiver);
      },
    });
    try {
      await expect(startEvaluationWithEffectStore(registrationId, {
        kind: "certification", agentId: agent.id, evaluationId: "cert", nonce: "cert-nonce",
        nonceExpiresAt: new Date(Date.now() + 60_000).toISOString(),
      }, [event])).rejects.toThrow("injected evaluation.started failure");
    } finally {
      eventLog.rows = originalRows;
    }

    expect(evaluationRegistrations.get(registrationId)!.status).toBe("registered");
    expect(Array.from(certificationJobs.values()).filter((job) => job.registrationId === registrationId)).toHaveLength(0);
    expect(events("evaluation.started")).toHaveLength(0);

    const started = await startEvaluationWithEffectStore(registrationId, {
      kind: "certification", agentId: agent.id, evaluationId: "cert", nonce: "cert-nonce-2",
      nonceExpiresAt: new Date(Date.now() + 60_000).toISOString(),
    }, [{ ...event, idemKey: `${event.idemKey}-retry` }]);
    expect(started.started).toBe(true);
    expect(started.certificationJob).toBeDefined();
    expect(certificationJobs.get(started.certificationJob!.id)!.status).toBe("pending");
  });
});

describe("sendSessionMessage", () => {
  async function claimedSession() {
    const candidate = makeAgent();
    const proctor = makeAgent();
    const registrationId = seedRegistration({ agentId: candidate.id, evaluationId: PROCTORED });
    const claim = await claimProctorSession({ agent: proctor, registrationId });
    if (!claim.ok) throw new Error("claim refused");
    return { candidate, proctor, sessionId: claim.value.sessionId, registrationId };
  }

  it("emits evaluation.session_message with the id the store minted, and no content", async () => {
    const { candidate, sessionId } = await claimedSession();
    eventLog.rows.length = 0;
    const sent = await sendSessionMessage({ agent: candidate, sessionId, content: " hi " });
    expect(sent.ok).toBe(true);
    if (!sent.ok) throw new Error("unreachable");
    const [event] = events("evaluation.session_message");
    expect(event).toMatchObject({
      actorAgentId: candidate.id,
      subjectType: "evaluation_session",
      subjectId: sessionId,
      payload: { message_id: sent.value.messageId },
    });
    // A transcript is content; a payload copy of it would outlive every deletion path.
    expect(JSON.stringify(event.payload)).not.toContain("hi");
  });

  it("writes nothing and emits nothing for empty content", async () => {
    const { candidate, sessionId } = await claimedSession();
    eventLog.rows.length = 0;
    const sent = await sendSessionMessage({ agent: candidate, sessionId, content: "   " });
    expect(sent.ok).toBe(false);
    expect(evaluationMessages.size).toBe(0);
    expect(events()).toHaveLength(0);
  });
});

describe("claimProctorSession", () => {
  it("emits evaluation.proctor_claimed with the session id the store minted", async () => {
    const candidate = makeAgent();
    const proctor = makeAgent();
    const registrationId = seedRegistration({ agentId: candidate.id, evaluationId: PROCTORED });
    const claim = await claimProctorSession({ agent: proctor, registrationId });
    expect(claim.ok).toBe(true);
    if (!claim.ok) throw new Error("unreachable");
    expect(events("evaluation.proctor_claimed")[0]).toMatchObject({
      // The PROCTOR acts; the subject is the candidate's registration.
      actorAgentId: proctor.id,
      subjectType: "evaluation_registration",
      subjectId: registrationId,
      payload: { evaluation_id: PROCTORED, session_id: claim.value.sessionId },
    });
  });

  it("writes nothing and emits nothing for a losing second claim", async () => {
    const candidate = makeAgent();
    const first = makeAgent();
    const second = makeAgent();
    const registrationId = seedRegistration({ agentId: candidate.id, evaluationId: PROCTORED });
    await claimProctorSession({ agent: first, registrationId });
    eventLog.rows.length = 0;
    const lost = await claimProctorSession({ agent: second, registrationId });
    expect(lost.ok).toBe(false);
    if (lost.ok) throw new Error("unreachable");
    expect(lost.denial.code).toBe("already_claimed");
    expect(evaluationSessions.size).toBe(1);
    expect(events()).toHaveLength(0);
  });
});

describe("u3e memory sequential parity", () => {
  it("allows only one of two valid vetting challenges to perform the vetted transition", async () => {
    const agent = makeAgent({ isVetted: false });
    const first = await startVetting({ agent });
    const second = await startVetting({ agent });
    if (!first.ok || !second.ok) throw new Error("challenge refused");
    eventLog.rows.length = 0;
    const outcomes = await Promise.all([
      completeVetting({ agent, challengeId: first.data.challenge.id, identityMd: "a" }),
      completeVetting({ agent, challengeId: second.data.challenge.id, identityMd: "b" }),
    ]);
    expect(outcomes.filter((outcome) => outcome.ok && outcome.data.outcome === "completed" && outcome.data.bootstrap.length > 0)).toHaveLength(1);
    expect(events("agent.vetted")).toHaveLength(1);
    expect(events("evaluation.completed")).toHaveLength(2);
  });

  it("refuses an evaluation write after the acting agent withdraws", async () => {
    const agent = makeAgent();
    // Keep the live-agent map non-empty: the memory store preserves isolated legacy fixtures when
    // no agents exist, but production mode always has a populated agent table.
    makeAgent();
    const registrationId = seedRegistration({ agentId: agent.id, evaluationId: SELF_SERVE });
    await expect(deleteAgent(agent.id)).resolves.toEqual({ ok: true });
    const before = eventLog.rows.length;
    await expect(completeEvaluation({
      agentId: agent.id,
      registrationId,
      evaluationId: SELF_SERVE,
      schoolId: "foundation",
      result: { passed: true },
    })).resolves.toMatchObject({ outcome: "not_actionable" });
    expect(eventLog.rows.length).toBe(before);
    expect(Array.from(evaluationResults.values()).some((result) => result.registrationId === registrationId)).toBe(false);
  });
});

describe("completeEvaluation", () => {
  it("emits evaluation.completed with the result id the store minted", async () => {
    const agent = makeAgent();
    const registrationId = seedRegistration({ agentId: agent.id, evaluationId: SELF_SERVE });
    const saved = await completeEvaluation({
      agentId: agent.id,
      registrationId,
      evaluationId: SELF_SERVE,
      schoolId: "foundation",
      result: { passed: true },
    });
    expect(saved.outcome).toBe("created");
    if (saved.outcome !== "created") throw new Error("unreachable");
    expect(events("evaluation.completed")[0]).toMatchObject({
      actorAgentId: agent.id,
      subjectType: "evaluation_registration",
      subjectId: registrationId,
      payload: { evaluation_id: SELF_SERVE, result_id: saved.resultId, passed: true },
    });
  });

  it("writes nothing and emits nothing when the registration already completed", async () => {
    const agent = makeAgent();
    const registrationId = seedRegistration({ agentId: agent.id, evaluationId: SELF_SERVE });
    await completeEvaluation({
      agentId: agent.id,
      registrationId,
      evaluationId: SELF_SERVE,
      schoolId: "foundation",
      result: { passed: true },
    });
    eventLog.rows.length = 0;
    const second = await completeEvaluation({
      agentId: agent.id,
      registrationId,
      evaluationId: SELF_SERVE,
      schoolId: "foundation",
      result: { passed: true },
    });
    expect(second.outcome).toBe("already_complete");
    expect(evaluationResults.size).toBe(1);
    expect(events()).toHaveLength(0);
  });

  /**
   * **The proctor session ends inside the completion, and a losing completion ends nothing.**
   * M11-1b D4 made the session end an element of the transaction; u3e makes both surfaces use it.
   */
  it("ends the proctor session only when the completion actually wrote", async () => {
    const candidate = makeAgent();
    const proctor = makeAgent();
    const registrationId = seedRegistration({ agentId: candidate.id, evaluationId: PROCTORED });
    const claim = await claimProctorSession({ agent: proctor, registrationId });
    if (!claim.ok) throw new Error("claim refused");

    evaluationRegistrations.get(registrationId)!.status = "cancelled";
    const refused = await submitProctorResult({ agent: proctor, registrationId, passed: true });
    // The registration left an actionable status, so authorization refuses before the write.
    expect(refused.ok).toBe(false);
    expect(evaluationSessions.get(claim.value.sessionId)!.status).toBe("active");
  });
});

describe("the PoAW fold-in", () => {
  /**
   * The executor used to consume the challenge itself, before the caller reached the store, so a
   * crash or a refused completion in between burned it. It now only NAMES the challenge, and the
   * completion consumes it — which is observable three ways.
   */
  it("consumes the challenge in the completion, not in the executor", async () => {
    const agent = makeAgent({ isVetted: false });
    seedRegistration({ agentId: agent.id, evaluationId: SELF_SERVE });
    const challenge = (await startVetting({ agent })) as { ok: true; data: { challenge: { id: string } } };
    agents.set(agent.id, { ...agent, isVetted: true });
    agent.isVetted = true;
    executorResult.value = {
      passed: true,
      consumesVettingChallengeId: challenge.data.challenge.id,
      resultData: { challenge_id: challenge.data.challenge.id },
    };
    eventLog.rows.length = 0;

    const submitted = await submitEvaluation({ agent, evaluationId: SELF_SERVE, input: {} });
    expect(submitted.ok).toBe(true);
    if (!submitted.ok) throw new Error("unreachable");
    expect(submitted.value.saved.outcome).toBe("created");
    expect(vettingChallenges.get(challenge.data.challenge.id)!.consumed).toBe(true);
    expect(events("evaluation.completed")).toHaveLength(1);
  });

  it("leaves the challenge UNCONSUMED when the completion writes nothing", async () => {
    const agent = makeAgent({ isVetted: false });
    const registrationId = seedRegistration({ agentId: agent.id, evaluationId: SELF_SERVE });
    const started = (await startVetting({ agent })) as { ok: true; data: { challenge: { id: string } } };
    const challengeId = started.data.challenge.id;

    // A concurrent completion wins the registration between the executor and the store.
    await completeEvaluation({
      agentId: agent.id,
      registrationId,
      evaluationId: SELF_SERVE,
      schoolId: "foundation",
      result: { passed: true },
    });
    eventLog.rows.length = 0;

    const saved = await completeEvaluation({
      agentId: agent.id,
      registrationId,
      evaluationId: SELF_SERVE,
      schoolId: "foundation",
      result: { passed: true },
      consumeChallengeId: challengeId,
    });
    expect(saved.outcome).toBe("already_complete");
    // The whole point: a completion that wrote nothing spends nothing.
    expect(vettingChallenges.get(challengeId)!.consumed).toBe(false);
    expect(events()).toHaveLength(0);
  });

  it("refuses a completion whose challenge is already consumed, writing nothing", async () => {
    const agent = makeAgent({ isVetted: false });
    const registrationId = seedRegistration({ agentId: agent.id, evaluationId: SELF_SERVE });
    const started = (await startVetting({ agent })) as { ok: true; data: { challenge: { id: string } } };
    const challengeId = started.data.challenge.id;
    vettingChallenges.set(challengeId, { ...vettingChallenges.get(challengeId)!, consumed: true });
    eventLog.rows.length = 0;

    const saved = await completeEvaluation({
      agentId: agent.id,
      registrationId,
      evaluationId: SELF_SERVE,
      schoolId: "foundation",
      result: { passed: true },
      consumeChallengeId: challengeId,
    });
    expect(saved.outcome).toBe("not_actionable");
    expect(evaluationResults.size).toBe(0);
    expect(evaluationRegistrations.get(registrationId)!.status).toBe("in_progress");
    expect(events()).toHaveLength(0);
  });

  it("keeps the self-serve 200 result shape when the executor returns an error", async () => {
    const agent = makeAgent();
    // A NON-PoAW self-serve evaluation: the legacy saved-error contract belongs to every other
    // executor, while poaw_handler errors are the 400 replay denial the test below pins.
    seedRegistration({ agentId: agent.id, evaluationId: "identity-check" });
    executorResult.value = { passed: false, error: "invalid input" };

    const submitted = await submitEvaluation({ agent, evaluationId: "identity-check", input: {} });
    expect(submitted.ok).toBe(true);
    if (!submitted.ok) throw new Error("unreachable");
    expect(submitted.value.result).toEqual({ passed: false, error: "invalid input" });
    expect(submitted.value.saved.outcome).toBe("created");
  });

  it("denies a PoAW executor error with 400 and writes nothing", async () => {
    const agent = makeAgent();
    const registrationId = seedRegistration({ agentId: agent.id, evaluationId: SELF_SERVE });
    executorResult.value = { passed: false, error: "Challenge already used" };
    eventLog.rows.length = 0;

    const submitted = await submitEvaluation({ agent, evaluationId: SELF_SERVE, input: {} });
    expect(submitted.ok).toBe(false);
    if (submitted.ok) throw new Error("unreachable");
    expect(submitted.denial.status).toBe(400);
    // A retryable validation refusal: the registration survives, nothing terminal is written.
    expect(evaluationResults.size).toBe(0);
    expect(evaluationRegistrations.get(registrationId)!.status).not.toBe("completed");
    expect(events()).toHaveLength(0);
  });
});

describe("agent lifecycle", () => {
  it("registration emits agent.registered against the id the store minted", async () => {
    const result = await registerAgent({ name: nextId("reg"), description: "" });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    expect(events("agent.registered")[0]).toMatchObject({
      // Unauthenticated: nobody acted, and the subject is the new agent.
      actorAgentId: null,
      subjectType: "agent",
      subjectId: result.data.id,
      schoolId: null,
      payload: {},
    });
  });

  it("releases a pristine stale name and emits one agent.registration_expired for it", async () => {
    const name = nextId("stale");
    const stale = makeAgent({
      name,
      isVetted: false,
      isClaimed: false,
      createdAt: new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString(),
    });
    delete (agents.get(stale.id) as { lastActiveAt?: string }).lastActiveAt;
    eventLog.rows.length = 0;

    const result = await registerAgent({ name, description: "" });
    expect(result.ok).toBe(true);
    expect(agents.has(stale.id)).toBe(false);
    const expired = events("agent.registration_expired");
    expect(expired).toHaveLength(1);
    expect(expired[0].subjectId).toBe(stale.id);
    expect(events("agent.registered")).toHaveLength(1);
  });

  it("leaves an ever-authenticated unclaimed agent alone, and emits no expiry", async () => {
    const name = nextId("active");
    const survivor = makeAgent({
      name,
      isVetted: false,
      isClaimed: false,
      createdAt: new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString(),
      lastActiveAt: new Date(Date.now() - 47 * 60 * 60 * 1000).toISOString(),
    });
    eventLog.rows.length = 0;

    const result = await registerAgent({ name, description: "" });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.code).toBe("already_exists");
    expect(agents.has(survivor.id)).toBe(true);
    expect(events()).toHaveLength(0);
  });

  it("emits agent.claimed once, with its channel, and nothing on a second claim", async () => {
    const agent = makeAgent({ isClaimed: false });
    const first = await claimAgentWithX({ agentId: agent.id, owner: "@someone", xFollowerCount: 3 });
    expect(first.ok).toBe(true);
    expect(events("agent.claimed")[0]).toMatchObject({
      actorAgentId: null,
      subjectType: "agent",
      subjectId: agent.id,
      payload: { channel: "x" },
    });

    const second = await claimAgentWithX({ agentId: agent.id, owner: "@other" });
    expect(second.ok).toBe(false);
    expect(events("agent.claimed")).toHaveLength(1);
  });

  it("emits agent.vetting_started on the challenge insert", async () => {
    const agent = makeAgent({ isVetted: false });
    await startVetting({ agent });
    expect(events("agent.vetting_started")[0]).toMatchObject({
      actorAgentId: agent.id,
      subjectType: "agent",
      subjectId: agent.id,
      payload: {},
    });
  });

  it("classifies an already-vetted start from the conditional store outcome", async () => {
    const agent = makeAgent({ isVetted: true });
    const result = await startVetting({ agent });
    expect(result).toEqual({ ok: true, data: { alreadyVetted: true, challenge: undefined } });
    expect(vettingChallenges.size).toBe(0);
    expect(events()).toHaveLength(0);
  });

  it("classifies a missing X claim target from the decisive store outcome", async () => {
    const result = await claimAgentWithX({ agentId: "missing-agent", owner: "@owner" });
    expect(result).toEqual({ ok: false, code: "not_found", message: "Agent not found" });
  });

  it("names a nonconforming registration in meta.deprecations and a conforming one not at all", () => {
    expect(nameGrammarDeprecations("good-name_1")).toEqual([]);
    expect(nameGrammarDeprecations("a")).toHaveLength(1);
    expect(nameGrammarDeprecations("has spaces")).toHaveLength(1);
    expect(nameGrammarDeprecations("emoji🙂")).toHaveLength(1);
  });
});

describe("completeVetting", () => {
  async function vettableAgent(): Promise<{ agent: StoredAgent; challengeId: string }> {
    const agent = makeAgent({ isVetted: false });
    const started = (await startVetting({ agent })) as { ok: true; data: { challenge: { id: string } } };
    eventLog.rows.length = 0;
    return { agent, challengeId: started.data.challenge.id };
  }

  it("gives a fresh agent two completed registrations, two results and the full event set", async () => {
    const { agent, challengeId } = await vettableAgent();
    const result = await completeVetting({ agent, challengeId, identityMd: "# me\n" });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    expect(result.data.outcome).toBe("completed");

    expect(agents.get(agent.id)!.isVetted).toBe(true);
    expect(Array.from(evaluationRegistrations.values()).map((r) => r.status)).toEqual([
      "completed",
      "completed",
    ]);
    expect(evaluationResults.size).toBe(2);

    expect(events("agent.vetted")).toHaveLength(1);
    expect(events("evaluation.registered")).toHaveLength(2);
    expect(events("evaluation.completed")).toHaveLength(2);
    // Each completion names the registration it terminated and the result it wrote.
    for (const event of events("evaluation.completed")) {
      const payload = event.payload as { evaluation_id: string; result_id: string; passed: boolean };
      expect(evaluationResults.get(payload.result_id)!.registrationId).toBe(event.subjectId);
      expect(payload.passed).toBe(true);
    }
    // The bootstrap's 10 + 0.5 are visible immediately.
    expect(Number(agents.get(agent.id)!.evaluationPoints)).toBeGreaterThan(10);
  });

  it("reuses a pre-registered agent's active registration and emits no registration event for it", async () => {
    const { agent, challengeId } = await vettableAgent();
    const preexisting = seedRegistration({ agentId: agent.id, evaluationId: "poaw", status: "registered" });

    const result = await completeVetting({ agent, challengeId, identityMd: "" });
    expect(result.ok).toBe(true);
    expect(evaluationRegistrations.get(preexisting)!.status).toBe("completed");
    // One fresh registration (identity-check) rather than two.
    expect(events("evaluation.registered")).toHaveLength(1);
    expect((events("evaluation.registered")[0].payload as { evaluation_id: string }).evaluation_id).toBe(
      "identity-check"
    );
    expect(events("evaluation.completed")).toHaveLength(2);
    expect(evaluationResults.size).toBe(2);
  });

  it("writes nothing and emits nothing for a bootstrap evaluation already passed", async () => {
    const { agent, challengeId } = await vettableAgent();
    const registrationId = seedRegistration({ agentId: agent.id, evaluationId: "poaw", status: "completed" });
    evaluationResults.set("res_poaw", {
      id: "res_poaw",
      registrationId,
      agentId: agent.id,
      evaluationId: "poaw",
      passed: true,
      completedAt: new Date().toISOString(),
    });

    const result = await completeVetting({ agent, challengeId, identityMd: "" });
    expect(result.ok).toBe(true);
    // Only identity-check is written.
    expect(evaluationResults.size).toBe(2);
    const completed = events("evaluation.completed");
    expect(completed).toHaveLength(1);
    expect((completed[0].payload as { evaluation_id: string }).evaluation_id).toBe("identity-check");
    expect(events("evaluation.registered")).toHaveLength(1);
  });

  it("emits nothing at all when the challenge is unavailable", async () => {
    const { agent, challengeId } = await vettableAgent();
    vettingChallenges.set(challengeId, { ...vettingChallenges.get(challengeId)!, consumed: true });
    const result = await completeVetting({ agent, challengeId, identityMd: "" });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    expect(result.data.outcome).toBe("unavailable");
    expect(agents.get(agent.id)!.isVetted).toBeFalsy();
    expect(events()).toHaveLength(0);
  });
});
