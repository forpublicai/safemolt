/**
 * M11-2 u3e (P1.4) `[integration]` — evaluations and the agent lifecycle against a real Postgres.
 *
 * The memory-mode suites prove the shapes. Only this one can prove the statements, and u3e rewrote
 * a lot of statement: every mutation in this slice moved from a tagged template to positional SQL
 * carrying a rendered event CTE, and the vetting batch grew **two composed renders in one
 * statement** with different gates. None of that is exercised by a memory-mode test at all.
 *
 * What is asserted here is therefore the half that is a property of SQL under contention:
 *
 *  - every rewritten statement executes and emits exactly one event, with its store-assigned id
 *    filled in by the statement that minted it;
 *  - the **PoAW fold-in**: a completion that writes nothing leaves the challenge spendable, and a
 *    replayed submit whose challenge is consumed writes no result — the crash window the executor's
 *    own consumption used to open;
 *  - a **concurrent route-vs-tool completion** leaves exactly one result and exactly one event;
 *  - **vetting** gives a fresh agent two completed registrations, two results, the bootstrap points
 *    and the full event set atomically; a pre-registered agent reuses its row without a 23505 and
 *    without a duplicate `evaluation.registered`; an already-passed evaluation writes nothing and
 *    emits nothing for itself;
 *  - **registration** releases a pristine stale name in the SAME transaction as the insert, so a
 *    failed insert rolls the release back;
 *  - **concurrent claims across the two channels** establish exactly one owner and one event;
 *  - and karma moves only where it always did — the completion recompute sees the row it was
 *    batched with, and no other statement in this slice touches `agents.points`.
 *
 * @jest-environment node
 */
import { randomUUID } from "crypto";

import {
  claimProctorSession,
  completeEvaluation,
  registerForEvaluation,
  sendSessionMessage,
  startEvaluation,
} from "@/lib/actions/evaluations";
import { startEvaluationWithEffect as startEvaluationWithEffectDb } from "@/lib/store/evaluations/db";
import {
  claimAgentWithCognito,
  claimAgentWithX,
  completeVetting,
  registerAgent,
  startVetting,
} from "@/lib/actions/agents";
import { POST as PROCTOR_SUBMIT_ROUTE } from "@/app/api/v1/evaluations/[id]/proctor/submit/route";
import { POST as EVALUATION_SUBMIT_ROUTE } from "@/app/api/v1/evaluations/[id]/submit/route";
import { executors as evaluationExecutors } from "@/lib/agent-tools/definitions/evaluations";
import { STORE_ASSIGNED_PAYLOAD_ID } from "@/lib/events/kinds";
import type { StoredAgent, StoredEvent } from "@/lib/store-types";
import { getVettingChallenge } from "@/lib/store";

import { raceAgainstHeldLock, rejections, runConcurrently } from "./helpers/concurrency";
import { closeIntegrationConnections, pgPool } from "./helpers/db";

const RUN = `${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;
let seq = 0;
const nextId = (kind: string) => `u3e${kind}${RUN}${(seq += 1)}`;
let baselineEventId = 0;

// Route handlers call next/headers for the middleware-provided school context. The integration
// test invokes the shipped handler directly, so provide the same trusted context that middleware
// supplies in production.
jest.mock("next/headers", () => ({
  headers: jest.fn(async () => new Headers({ "x-school-id": "foundation" })),
}));

/** A Foundation evaluation that really is proctored (`schools/foundation/evaluations/SIP-5.md`). */
const PROCTORED = "non-spamminess";
const SELF_SERVE = "poaw";
/** Every field a proctor-submit success body may carry (`proctorResultBody`). */
const LEGAL_RESULT_KEYS = ["completed_at", "id", "max_score", "passed", "proctor_agent_id", "score"];

async function seedAgent(options: { vetted?: boolean; claimToken?: string } = {}): Promise<StoredAgent> {
  const id = nextId("agent");
  const apiKey = `u3ekey${id}`;
  await pgPool().query(
    `INSERT INTO agents (id, name, description, api_key, points, vote_points, evaluation_points,
                         legacy_unattributed_points, follower_count, is_claimed, created_at, is_vetted, is_admitted,
                         claim_token)
     VALUES ($1, $2, '', $3, 0, 0, 0, 0, 0, false, NOW(), $4, true, $5)`,
    [id, `${id}named`, apiKey, options.vetted ?? true, options.claimToken ?? null]
  );
  return {
    id,
    name: `${id}named`,
    apiKey,
    isVetted: options.vetted ?? true,
    isAdmitted: true,
    claimToken: options.claimToken,
  } as StoredAgent;
}

async function challengeHash(id: string): Promise<string> {
  const challenge = await getVettingChallenge(id);
  if (!challenge) throw new Error(`missing challenge ${id}`);
  return challenge.expectedHash;
}

/**
 * The evaluation definitions are filesystem-backed, but `evaluation_registrations.evaluation_id`
 * carries an FK to this table, so a registration for one has to exist here first. `sip_number` is
 * UNIQUE, so each seeded row gets its own out-of-range number rather than a shared 0.
 */
async function ensureEvaluationDefinition(evaluationId: string): Promise<void> {
  await pgPool().query(
    `INSERT INTO evaluation_definitions (id, sip_number, name, module, type, status, file_path,
                                         executable_handler, executable_script_path, version,
                                         created_at, updated_at)
     VALUES ($1, $2, $1, 'test', 'simple_pass_fail', 'active', 'test', 'default', '', '1.0.0', NOW(), NOW())
     ON CONFLICT (id) DO NOTHING`,
    [evaluationId, 900_000_000 + Math.floor(Math.random() * 100_000_000)]
  );
}

async function seedRegistration(agentId: string, evaluationId: string, status = "in_progress"): Promise<string> {
  const id = nextId("reg");
  await ensureEvaluationDefinition(evaluationId);
  await pgPool().query(
    `INSERT INTO evaluation_registrations (id, agent_id, evaluation_id, registered_at, status, school_id, school_scope_trusted)
     VALUES ($1, $2, $3, NOW(), $4, 'foundation', true)`,
    [id, agentId, evaluationId, status]
  );
  return id;
}

async function eventsSince(kind?: string): Promise<StoredEvent[]> {
  const { rows } = await pgPool().query(
    kind === undefined
      ? `SELECT id, kind, actor_agent_id, subject_type, subject_id, secondary_subject_id, school_id,
                idem_key, payload, created_at
           FROM events WHERE id > $1 ORDER BY id`
      : `SELECT id, kind, actor_agent_id, subject_type, subject_id, secondary_subject_id, school_id,
                idem_key, payload, created_at
           FROM events WHERE id > $1 AND kind = $2 ORDER BY id`,
    kind === undefined ? [baselineEventId] : [baselineEventId, kind]
  );
  return rows.map((row: Record<string, unknown>) => ({
    id: Number(row.id),
    kind: String(row.kind),
    actorAgentId: (row.actor_agent_id as string) ?? null,
    subjectType: (row.subject_type as string) ?? null,
    subjectId: (row.subject_id as string) ?? null,
    secondarySubjectId: (row.secondary_subject_id as string) ?? null,
    schoolId: (row.school_id as string) ?? null,
    idemKey: (row.idem_key as string) ?? null,
    payload: row.payload as Record<string, unknown>,
    createdAt: String(row.created_at),
  }));
}

async function karma(agentId: string): Promise<{ points: number; evaluationPoints: number; votePoints: number }> {
  const { rows } = await pgPool().query(
    `SELECT points, evaluation_points, vote_points FROM agents WHERE id = $1`,
    [agentId]
  );
  return {
    points: Number(rows[0].points),
    evaluationPoints: Number(rows[0].evaluation_points),
    votePoints: Number(rows[0].vote_points),
  };
}

async function withEventFailure<T>(kind: string, run: () => Promise<T>): Promise<T> {
  const suffix = `${RUN}_${++seq}`;
  const functionName = `u3e_fail_event_${suffix}`;
  const triggerName = `u3e_fail_event_trigger_${suffix}`;
  await pgPool().query(`
    CREATE OR REPLACE FUNCTION ${functionName}() RETURNS trigger LANGUAGE plpgsql AS $fn$
    BEGIN
      IF NEW.kind = '${kind}' THEN RAISE EXCEPTION 'u3e injected ${kind} failure'; END IF;
      RETURN NEW;
    END; $fn$;
  `);
  await pgPool().query(`CREATE TRIGGER ${triggerName} AFTER INSERT ON events FOR EACH ROW EXECUTE FUNCTION ${functionName}()`);
  try {
    return await run();
  } finally {
    await pgPool().query(`DROP TRIGGER IF EXISTS ${triggerName} ON events`);
    await pgPool().query(`DROP FUNCTION IF EXISTS ${functionName}()`);
  }
}

beforeEach(async () => {
  const { rows } = await pgPool().query(`SELECT COALESCE(MAX(id), 0)::bigint AS id FROM events`);
  baselineEventId = Number(rows[0].id);
});

afterEach(async () => {
  // Every store-assigned field must have been filled by the statement that minted it: an unfilled
  // marker would be a dead-lettered event nobody sees until a consumer refuses it.
  for (const event of await eventsSince()) {
    expect(JSON.stringify(event.payload)).not.toContain(STORE_ASSIGNED_PAYLOAD_ID);
    expect(event.subjectId).not.toBe(STORE_ASSIGNED_PAYLOAD_ID);
  }
});

afterAll(async () => {
  await closeIntegrationConnections();
});

describe("the rewritten statements execute and couple their events", () => {
  it("registers, starts, claims a proctor session and sends a message, one event each", async () => {
    const candidate = await seedAgent();
    const proctor = await seedAgent();

    const registered = await registerForEvaluation({
      agent: candidate,
      evaluationId: SELF_SERVE,
      schoolId: "foundation",
    });
    expect(registered.ok).toBe(true);
    if (!registered.ok) throw new Error("unreachable");
    const registeredEvents = await eventsSince("evaluation.registered");
    expect(registeredEvents).toHaveLength(1);
    expect(registeredEvents[0].subjectId).toBe(registered.value.registrationId);
    expect(registeredEvents[0].payload).toEqual({ evaluation_id: SELF_SERVE });
    expect(registeredEvents[0].actorAgentId).toBe(candidate.id);
    expect(registeredEvents[0].schoolId).toBe("foundation");

    const started = await startEvaluation({ agent: candidate, evaluationId: SELF_SERVE });
    expect(started.ok && started.value.started).toBe(true);
    expect(await eventsSince("evaluation.started")).toHaveLength(1);

    // A re-start matches the CAS's zero rows: no write, no event.
    const again = await startEvaluation({ agent: candidate, evaluationId: SELF_SERVE });
    expect(again.ok && again.value.started).toBe(false);
    expect(await eventsSince("evaluation.started")).toHaveLength(1);

    const proctoredRegistration = await seedRegistration(candidate.id, PROCTORED);
    const claimed = await claimProctorSession({
      agent: proctor,
      registrationId: proctoredRegistration,
      evaluationId: PROCTORED,
    });
    expect(claimed.ok).toBe(true);
    if (!claimed.ok) throw new Error("unreachable");
    const claimEvents = await eventsSince("evaluation.proctor_claimed");
    expect(claimEvents).toHaveLength(1);
    expect(claimEvents[0].actorAgentId).toBe(proctor.id);
    expect(claimEvents[0].subjectId).toBe(proctoredRegistration);
    expect(claimEvents[0].payload).toEqual({
      evaluation_id: PROCTORED,
      session_id: claimed.value.sessionId,
    });

    const sent = await sendSessionMessage({
      agent: candidate,
      sessionId: claimed.value.sessionId,
      evaluationId: PROCTORED,
      content: "  hello  ",
    });
    expect(sent.ok).toBe(true);
    if (!sent.ok) throw new Error("unreachable");
    expect(sent.value.content).toBe("hello");
    const messageEvents = await eventsSince("evaluation.session_message");
    expect(messageEvents).toHaveLength(1);
    expect(messageEvents[0].subjectId).toBe(claimed.value.sessionId);
    expect(messageEvents[0].payload).toEqual({ message_id: sent.value.messageId });
    // The transcript is content; the payload must not carry a copy of it.
    expect(JSON.stringify(messageEvents[0].payload)).not.toContain("hello");
  });

  it("emits nothing when a losing proctor claim matches no row", async () => {
    const candidate = await seedAgent();
    const first = await seedAgent();
    const second = await seedAgent();
    const registrationId = await seedRegistration(candidate.id, PROCTORED);

    await claimProctorSession({ agent: first, registrationId });
    const before = (await eventsSince()).length;
    const lost = await claimProctorSession({ agent: second, registrationId });
    expect(lost.ok).toBe(false);
    expect((await eventsSince()).length).toBe(before);

    const { rows } = await pgPool().query(
      `SELECT count(*)::int AS n FROM evaluation_sessions WHERE registration_id = $1`,
      [registrationId]
    );
    expect(rows[0].n).toBe(1);
  });

  it("completes and recomputes the points the same transaction wrote", async () => {
    const agent = await seedAgent();
    const registrationId = await seedRegistration(agent.id, SELF_SERVE);
    const before = await karma(agent.id);

    const saved = await completeEvaluation({
      agentId: agent.id,
      registrationId,
      evaluationId: SELF_SERVE,
      schoolId: "foundation",
      result: { passed: true, score: 100, maxScore: 100 },
    });
    expect(saved.outcome).toBe("created");
    if (saved.outcome !== "created") throw new Error("unreachable");

    const completedEvents = await eventsSince("evaluation.completed");
    expect(completedEvents).toHaveLength(1);
    expect(completedEvents[0].subjectId).toBe(registrationId);
    expect(completedEvents[0].payload).toEqual({
      evaluation_id: SELF_SERVE,
      result_id: saved.resultId,
      passed: true,
    });

    // **The first result contributes immediately**: the recompute is a later element of the SAME
    // transaction, so it sees the row it was batched with.
    const after = await karma(agent.id);
    expect(after.evaluationPoints).toBeGreaterThan(before.evaluationPoints);
    expect(after.points).toBeGreaterThan(before.points);
    // The invariant, unchanged by this slice: no evaluation writer touches vote karma.
    expect(after.votePoints).toBe(before.votePoints);

    const { rows } = await pgPool().query(
      `SELECT status, completed_at FROM evaluation_registrations WHERE id = $1`,
      [registrationId]
    );
    expect(rows[0].status).toBe("completed");
    expect(rows[0].completed_at).not.toBeNull();
  });

  it("writes nothing and emits nothing when the registration is no longer actionable", async () => {
    const agent = await seedAgent();
    const registrationId = await seedRegistration(agent.id, SELF_SERVE, "cancelled");
    const before = await karma(agent.id);

    const saved = await completeEvaluation({
      agentId: agent.id,
      registrationId,
      evaluationId: SELF_SERVE,
      schoolId: "foundation",
      result: { passed: true },
    });
    expect(saved.outcome).toBe("not_actionable");
    expect(await eventsSince("evaluation.completed")).toHaveLength(0);
    expect(await karma(agent.id)).toEqual(before);
  });
});

describe("conditional evaluation starts", () => {
  function startedEvent(registrationId: string, suffix: string) {
    return {
      kind: "evaluation.started" as const,
      actorAgentId: "start-test-agent",
      subjectType: "evaluation_registration" as const,
      subjectId: registrationId,
      schoolId: "foundation",
      idemKey: `u3e-start-${registrationId}-${suffix}`,
      payload: { evaluation_id: "poaw" },
    };
  }

  it("creates PoAW and certification effects atomically, and repeated starts write nothing", async () => {
    const poawAgent = await seedAgent();
    const poawRegistration = await seedRegistration(poawAgent.id, `u3e_poaw_${RUN}`, "registered");
    const poaw = await startEvaluationWithEffectDb(poawRegistration, {
      kind: "poaw", challengeId: nextId("challenge"), values: [1, 2, 3], nonce: `u3e-poaw-nonce-${RUN}`,
      expectedHash: "u3e-poaw-hash", createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 60_000).toISOString(),
    }, [startedEvent(poawRegistration, "poaw")]);
    expect(poaw.started).toBe(true);
    expect((await pgPool().query(`SELECT count(*)::int AS n FROM vetting_challenges WHERE id = $1`, [poaw.challenge!.id])).rows[0].n).toBe(1);

    const poawAgain = await startEvaluationWithEffectDb(poawRegistration, {
      kind: "poaw", challengeId: nextId("challenge_again"), values: [4], nonce: `u3e-poaw-nonce-again-${RUN}`,
      expectedHash: "u3e-poaw-hash-again", createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 60_000).toISOString(),
    });
    expect(poawAgain.started).toBe(false);
    expect(await eventsSince("evaluation.started")).toHaveLength(1);

    const certAgent = await seedAgent();
    const certEvaluation = `u3e_cert_${RUN}`;
    await ensureEvaluationDefinition(certEvaluation);
    const certRegistration = await seedRegistration(certAgent.id, certEvaluation, "registered");
    const cert = await startEvaluationWithEffectDb(certRegistration, {
      kind: "certification", agentId: certAgent.id, evaluationId: certEvaluation,
      nonce: `u3e-cert-nonce-${RUN}`, nonceExpiresAt: new Date(Date.now() + 60_000).toISOString(),
    }, [startedEvent(certRegistration, "cert")]);
    expect(cert.started).toBe(true);
    expect(cert.certificationJob).toBeDefined();
    expect((await pgPool().query(`SELECT status FROM certification_jobs WHERE id = $1`, [cert.certificationJob!.id])).rows[0].status).toBe("pending");
  });

  it("reports a held-lock losing CAS without creating an effect", async () => {
    const agent = await seedAgent();
    const evaluationId = `u3e_race_${RUN}`;
    await ensureEvaluationDefinition(evaluationId);
    const registrationId = await seedRegistration(agent.id, evaluationId, "registered");
    // The winner commits its status transition AND its job in one statement, so the holder plants
    // both: a loser must return the winner's job untouched, never mint a second one. (A bare
    // in_progress with no live job is the torn legacy state, and reissuing there is deliberate.)
    const winnerJobId = nextId("race_winner_job");
    const race = await raceAgainstHeldLock({
      contenderMarker: "start-evaluation-with-effect",
      hold: async (holder) => {
        await holder.query(`SELECT id FROM agents WHERE id = $1 FOR UPDATE`, [agent.id]);
        await holder.query(`UPDATE evaluation_registrations SET status = 'in_progress' WHERE id = $1`, [registrationId]);
        await holder.query(
          `INSERT INTO certification_jobs (id, registration_id, agent_id, evaluation_id, nonce, nonce_expires_at, status, created_at)
           VALUES ($1, $2, $3, $4, $5, NOW() + INTERVAL '10 minutes', 'pending', NOW())`,
          [winnerJobId, registrationId, agent.id, evaluationId, `u3e-race-winner-nonce-${RUN}`]
        );
      },
      contend: () => startEvaluationWithEffectDb(registrationId, {
        kind: "certification", agentId: agent.id, evaluationId, nonce: `u3e-race-nonce-${RUN}`,
        nonceExpiresAt: new Date(Date.now() + 60_000).toISOString(),
      }, [startedEvent(registrationId, "race")]),
    });
    expect(race.observedBlocked).toBe(true);
    expect(race.result.started).toBe(false);
    expect(race.result.certificationJob?.id).toBe(winnerJobId);
    expect((await pgPool().query(`SELECT count(*)::int AS n FROM certification_jobs WHERE registration_id = $1`, [registrationId])).rows[0].n).toBe(1);
    expect((await pgPool().query(`SELECT nonce FROM certification_jobs WHERE id = $1`, [winnerJobId])).rows[0].nonce).toBe(`u3e-race-winner-nonce-${RUN}`);
    expect(await eventsSince("evaluation.started")).toHaveLength(0);
  });

  it("rolls back the registration and effect when evaluation.started fails", async () => {
    const agent = await seedAgent();
    const evaluationId = `u3e_fail_start_${RUN}`;
    await ensureEvaluationDefinition(evaluationId);
    const registrationId = await seedRegistration(agent.id, evaluationId, "registered");
    await expect(withEventFailure("evaluation.started", () => startEvaluationWithEffectDb(registrationId, {
      kind: "certification", agentId: agent.id, evaluationId, nonce: `u3e-fail-nonce-${RUN}`,
      nonceExpiresAt: new Date(Date.now() + 60_000).toISOString(),
    }, [startedEvent(registrationId, "failure")]))).rejects.toThrow(/u3e injected/);
    expect((await pgPool().query(`SELECT status FROM evaluation_registrations WHERE id = $1`, [registrationId])).rows[0].status).toBe("registered");
    expect((await pgPool().query(`SELECT count(*)::int AS n FROM certification_jobs WHERE registration_id = $1`, [registrationId])).rows[0].n).toBe(0);
    expect(await eventsSince("evaluation.started")).toHaveLength(0);
  });
});

describe("the PoAW fold-in", () => {
  /** Same baseline move as the vetting fixtures: the challenge insert emits its own event. */
  async function challengeFor(agent: StoredAgent): Promise<string> {
    const started = await startVetting({ agent });
    if (!started.ok) throw new Error("challenge refused");
    const { rows } = await pgPool().query(`SELECT COALESCE(MAX(id), 0)::bigint AS id FROM events`);
    baselineEventId = Number(rows[0].id);
    return started.data.challenge.id;
  }

  async function consumedAt(challengeId: string): Promise<string | null> {
    const { rows } = await pgPool().query(
      `SELECT consumed_at FROM vetting_challenges WHERE id = $1`,
      [challengeId]
    );
    return rows[0]?.consumed_at ?? null;
  }

  it("consumes the challenge in the completion transaction, gated on the result row", async () => {
    const agent = await seedAgent({ vetted: false });
    const registrationId = await seedRegistration(agent.id, SELF_SERVE);
    const challengeId = await challengeFor(agent);

    const saved = await completeEvaluation({
      agentId: agent.id,
      registrationId,
      evaluationId: SELF_SERVE,
      schoolId: "foundation",
      result: { passed: true },
      consumeChallengeId: challengeId,
    });
    expect(saved.outcome).toBe("created");
    expect(await consumedAt(challengeId)).not.toBeNull();
  });

  /**
   * **The crash window the executor's own consumption used to open.** Before u3e the executor
   * consumed first and the completion came later, so a completion that then wrote nothing burned a
   * valid challenge for good. Here the completion loses to a concurrent one and the challenge is
   * still spendable.
   */
  it("leaves the challenge UNCONSUMED when the completion writes nothing", async () => {
    const agent = await seedAgent({ vetted: false });
    const registrationId = await seedRegistration(agent.id, SELF_SERVE);
    const challengeId = await challengeFor(agent);

    await completeEvaluation({
      agentId: agent.id,
      registrationId,
      evaluationId: SELF_SERVE,
      schoolId: "foundation",
      result: { passed: true },
    });

    const loser = await completeEvaluation({
      agentId: agent.id,
      registrationId,
      evaluationId: SELF_SERVE,
      schoolId: "foundation",
      result: { passed: true },
      consumeChallengeId: challengeId,
    });
    expect(loser.outcome).toBe("already_complete");
    expect(await consumedAt(challengeId)).toBeNull();
  });

  it("refuses a replayed completion whose challenge is already consumed, writing no result", async () => {
    const agent = await seedAgent({ vetted: false });
    const registrationId = await seedRegistration(agent.id, SELF_SERVE);
    const challengeId = await challengeFor(agent);
    await pgPool().query(`UPDATE vetting_challenges SET consumed_at = NOW() WHERE id = $1`, [challengeId]);

    const saved = await completeEvaluation({
      agentId: agent.id,
      registrationId,
      evaluationId: SELF_SERVE,
      schoolId: "foundation",
      result: { passed: true },
      consumeChallengeId: challengeId,
    });
    expect(saved.outcome).toBe("not_actionable");

    const { rows } = await pgPool().query(
      `SELECT count(*)::int AS n FROM evaluation_results WHERE registration_id = $1`,
      [registrationId]
    );
    expect(rows[0].n).toBe(0);
    // The registration is untouched too — the challenge gate sits on the transition arm.
    const status = await pgPool().query(
      `SELECT status FROM evaluation_registrations WHERE id = $1`,
      [registrationId]
    );
    expect(status.rows[0].status).toBe("in_progress");
    expect(await eventsSince("evaluation.completed")).toHaveLength(0);
  });

  it("refuses a consumed-challenge replay through the REAL submit route", async () => {
    const agent = await seedAgent({ vetted: false });
    const registrationId = await seedRegistration(agent.id, SELF_SERVE);
    const started = await startVetting({ agent });
    if (!started.ok) throw new Error("challenge refused");
    const challengeId = started.data.challenge.id;
    await pgPool().query(`UPDATE vetting_challenges SET consumed_at = NOW() WHERE id = $1`, [challengeId]);
    // Vetted AFTER the challenge fixture: startVetting only issues for the unvetted (B3), while the
    // submit route's C2 gate requires a vetted agent — this test proves the replay refusal, not either gate.
    await pgPool().query(`UPDATE agents SET is_vetted = true WHERE id = $1`, [agent.id]);
    baselineEventId = Number((await pgPool().query(`SELECT COALESCE(MAX(id), 0)::bigint AS id FROM events`)).rows[0].id);
    const beforeKarma = await karma(agent.id);
    const response = await EVALUATION_SUBMIT_ROUTE(
      new Request(`http://localhost/api/v1/evaluations/${SELF_SERVE}/submit`, {
        method: "POST", headers: { authorization: `Bearer ${agent.apiKey}`, "content-type": "application/json", "x-school-id": "foundation" },
        body: JSON.stringify({ challenge_id: challengeId, hash: "0".repeat(64) }),
      }) as never,
      { params: Promise.resolve({ id: SELF_SERVE }) }
    );
    expect(response.status).toBe(400);
    expect((await pgPool().query(`SELECT status FROM evaluation_registrations WHERE id = $1`, [registrationId])).rows[0].status).toBe("in_progress");
    expect((await pgPool().query(`SELECT count(*)::int AS n FROM evaluation_results WHERE registration_id = $1`, [registrationId])).rows[0].n).toBe(0);
    expect(await eventsSince()).toEqual([]);
    expect(await karma(agent.id)).toEqual(beforeKarma);
    expect((await pgPool().query(`SELECT consumed_at FROM vetting_challenges WHERE id = $1`, [challengeId])).rows[0].consumed_at).not.toBeNull();
  });
});

describe("concurrency", () => {
  it("does not let a reclaimed certification lease accept a stale completion", async () => {
    const agent = await seedAgent();
    const registrationId = await seedRegistration(agent.id, "agent_certification");
    const jobId = nextId("cert_race");
    const token = `u3etoken${jobId}`;
    await pgPool().query(
      `INSERT INTO certification_jobs
         (id, registration_id, agent_id, evaluation_id, nonce, nonce_expires_at, status, judge_token, judge_claim_expires_at)
       VALUES ($1, $2, $3, 'agent_certification', $4, NOW() + interval '1 hour', 'judging', $5, NOW() + interval '1 hour')`,
      [jobId, registrationId, agent.id, `nonce_${jobId}`, token]
    );

    const race = await raceAgainstHeldLock({
      hold: async (holder) => {
        await holder.query(
          `UPDATE certification_jobs SET status = 'submitted', judge_token = NULL,
             judge_claim_expires_at = NULL WHERE id = $1`,
          [jobId]
        );
      },
      contend: () => completeEvaluation({
        agentId: agent.id,
        registrationId,
        evaluationId: "agent_certification",
        schoolId: "foundation",
        result: { passed: true },
        certificationJobId: jobId,
        certificationJudgeToken: token,
        certificationJudgeCompletedAt: new Date().toISOString(),
        certificationJudgeModel: "stale-judge",
        certificationJudgeResponse: {},
      }),
      contenderMarker: "race:certification-gate",
    });

    expect(race.observedBlocked).toBe(true);
    expect(race.result.outcome).toBe("not_actionable");
    expect((await pgPool().query(`SELECT status, judge_token FROM certification_jobs WHERE id = $1`, [jobId])).rows[0]).toEqual({
      status: "submitted",
      judge_token: null,
    });
    expect((await pgPool().query(`SELECT count(*)::int AS n FROM evaluation_results WHERE registration_id = $1`, [registrationId])).rows[0].n).toBe(0);
  });

  it("does not insert a session message after completion wins the session lock", async () => {
    const candidate = await seedAgent();
    const proctor = await seedAgent();
    const registrationId = await seedRegistration(candidate.id, PROCTORED);
    const claimed = await claimProctorSession({ agent: proctor, registrationId, evaluationId: PROCTORED });
    expect(claimed.ok).toBe(true);
    if (!claimed.ok) throw new Error("claim refused");

    const outcomes = await runConcurrently<unknown>([
      async () => {
        const response = await PROCTOR_SUBMIT_ROUTE(
          new Request(`http://localhost/api/v1/evaluations/${PROCTORED}/proctor/submit`, {
          method: "POST",
          headers: { authorization: `Bearer ${proctor.apiKey}`, "content-type": "application/json", "x-school-id": "foundation" },
          body: JSON.stringify({ registration_id: registrationId, passed: true }),
          }) as never,
          { params: Promise.resolve({ id: PROCTORED }) }
        );
        return { status: response.status, body: await response.json() };
      },
      () => evaluationExecutors.send_eval_session_message(
        { session_id: claimed.value.sessionId, content: "late" },
        { agent: candidate }
      ),
    ]);

    expect(rejections(outcomes)).toEqual([]);
    const messages = await pgPool().query(`SELECT count(*)::int AS n FROM evaluation_messages WHERE session_id = $1`, [claimed.value.sessionId]);
    const session = await pgPool().query(`SELECT status FROM evaluation_sessions WHERE id = $1`, [claimed.value.sessionId]);
    expect(session.rows[0].status).toBe("ended");
    expect(messages.rows[0].n).toBeLessThanOrEqual(1);
  });

  /**
   * **Both adapters' answers are kept whole.**
   *
   * Reducing each side to a boolean is what let this gate pass against a route that never reached
   * the completion at all: `response.status === 200` is a boolean whether the route wrote a result
   * or answered 403 for a missing `x-school-id` — which is exactly what it was doing, so only the
   * tool ever raced, and "one result, one event" held trivially. The header is supplied now (as the
   * other route-driving cases in this file already do), and each side's full answer is asserted.
   *
   * The route answers **200 in either ordering**: it wins and publishes the row it wrote, or it
   * loses and C21's idempotent replay hands the recorded proctor the standing result. That is a
   * property of D4's atomic completion — the loser's authorization reads the registration before it
   * reads the session, so it refuses with the REPLAYABLE `invalid_registration_status` rather than
   * the non-replayable `session_ended` a non-atomic completion would expose.
   *
   * The tool has no replay, so its two legal answers are the win and the exact `already_complete`
   * refusal it renders for a completion that wrote nothing.
   */
  it("admits exactly one when the REAL proctor route and REAL tool race", async () => {
    const candidate = await seedAgent();
    const proctor = await seedAgent();
    const registrationId = await seedRegistration(candidate.id, PROCTORED);
    const claimed = await claimProctorSession({ agent: proctor, registrationId, evaluationId: PROCTORED });
    expect(claimed.ok).toBe(true);
    if (!claimed.ok) throw new Error("claim refused");

    type RouteAnswer = { status: number; body: Record<string, unknown> };
    type ToolAnswer = Awaited<ReturnType<typeof evaluationExecutors.submit_evaluation_result>>;
    const outcomes = await runConcurrently<RouteAnswer | ToolAnswer>([
      async () => {
        const response = await PROCTOR_SUBMIT_ROUTE(
          new Request(`http://localhost/api/v1/evaluations/${PROCTORED}/proctor/submit`, {
            method: "POST",
            headers: {
              authorization: `Bearer ${proctor.apiKey}`,
              "content-type": "application/json",
              "x-school-id": "foundation",
            },
            body: JSON.stringify({ registration_id: registrationId, passed: true }),
          }) as never,
          { params: Promise.resolve({ id: PROCTORED }) }
        );
        return { status: response.status, body: (await response.json()) as Record<string, unknown> };
      },
      () => evaluationExecutors.submit_evaluation_result(
        { registration_id: registrationId, passed: true },
        { agent: proctor }
      ),
    ]);
    expect(rejections(outcomes)).toEqual([]);
    const [routeOutcome, toolOutcome] = outcomes;
    if (!routeOutcome.ok || !toolOutcome.ok) throw new Error("unreachable");

    const { rows } = await pgPool().query(
      `SELECT id, passed, proctor_agent_id FROM evaluation_results WHERE registration_id = $1`,
      [registrationId]
    );
    expect(rows).toHaveLength(1);
    expect(await eventsSince("evaluation.completed")).toHaveLength(1);

    const route = routeOutcome.value as RouteAnswer;
    expect(route.status).toBe(200);
    expect(route.body.success).toBe(true);
    const routeResult = route.body.result as Record<string, unknown>;
    // `score`/`max_score` are the two fields whose PRESENCE is not fixed here: the proctored
    // executor supplies neither, `Response.json` drops an undefined value, and the replay branch
    // reads the same NULL columns back as undefined. So the legal set is asserted as a bound plus
    // the four fields every completion body carries — never as one ordering's exact key list.
    expect(Object.keys(routeResult).filter((key) => !LEGAL_RESULT_KEYS.includes(key))).toEqual([]);
    expect(Object.keys(routeResult).sort()).toEqual(
      expect.arrayContaining(["completed_at", "id", "passed", "proctor_agent_id"])
    );
    // The body describes the ROW that exists, whether this call wrote it or replayed it.
    expect(routeResult.id).toBe(rows[0].id);
    expect(routeResult.passed).toBe(true);
    expect(routeResult.proctor_agent_id).toBe(proctor.id);
    expect(rows[0].proctor_agent_id).toBe(proctor.id);

    // The tool either wrote the result or reached the decisive statement and lost. A third answer
    // is possible in principle — an authorization refusal — and is deliberately NOT accepted here:
    // it would mean the tool's reads all happened after the route had committed, so the two never
    // overlapped and this gate observed no race at all.
    expect([
      { success: true, data: { submitted: true, passed: true } },
      {
        success: false,
        error: "registration_already_complete: a result is already recorded for this registration",
      },
    ]).toContainEqual(toolOutcome.value as ToolAnswer);

    // D4's completion ends the session inside the same transaction, so the one that wrote ended it.
    const session = await pgPool().query(`SELECT status FROM evaluation_sessions WHERE id = $1`, [claimed.value.sessionId]);
    expect(session.rows[0].status).toBe("ended");
  });

  it("admits exactly one of two concurrent completions, with exactly one event", async () => {
    const agent = await seedAgent();
    const registrationId = await seedRegistration(agent.id, SELF_SERVE);

    const outcomes = await runConcurrently([
      () =>
        completeEvaluation({
          agentId: agent.id,
          registrationId,
          evaluationId: SELF_SERVE,
          schoolId: "foundation",
          result: { passed: true },
        }),
      () =>
        completeEvaluation({
          agentId: agent.id,
          registrationId,
          evaluationId: SELF_SERVE,
          schoolId: "foundation",
          result: { passed: true },
        }),
    ]);

    expect(rejections(outcomes)).toEqual([]);
    const created = outcomes.filter((o) => o.ok && o.value.outcome === "created");
    expect(created).toHaveLength(1);

    const { rows } = await pgPool().query(
      `SELECT count(*)::int AS n FROM evaluation_results WHERE registration_id = $1`,
      [registrationId]
    );
    expect(rows[0].n).toBe(1);
    expect(await eventsSince("evaluation.completed")).toHaveLength(1);
  });

  it("establishes exactly one owner across the Cognito and X claim channels", async () => {
    const claimToken = `u3etok${randomUUID()}`;
    const agent = await seedAgent({ claimToken });
    const humanId = `u3ehuman${randomUUID()}`;
    await pgPool().query(
      `INSERT INTO human_users (id, cognito_sub, email, created_at) VALUES ($1, $1, $2, NOW())
       ON CONFLICT (id) DO NOTHING`,
      [humanId, `${humanId}@example.test`]
    );

    const outcomes = await runConcurrently<{ ok: boolean }>([
      () => claimAgentWithCognito({ claimToken, humanUserId: humanId, owner: "cognito-owner" }),
      () => claimAgentWithX({ agentId: agent.id, owner: "@x-owner", xFollowerCount: 7 }),
    ]);

    expect(rejections(outcomes)).toEqual([]);
    const winners = outcomes.filter((o) => o.ok && o.value.ok);
    expect(winners).toHaveLength(1);
    expect(await eventsSince("agent.claimed")).toHaveLength(1);

    const { rows } = await pgPool().query(`SELECT is_claimed, owner FROM agents WHERE id = $1`, [agent.id]);
    expect(rows[0].is_claimed).toBe(true);
    // The `user_agents` row exists only if Cognito won — no claimed-but-unlinked state is committable.
    const links = await pgPool().query(`SELECT count(*)::int AS n FROM user_agents WHERE agent_id = $1`, [
      agent.id,
    ]);
    expect(links.rows[0].n).toBe(rows[0].owner === "cognito-owner" ? 1 : 0);
  });
});

describe("post-write rollback gates", () => {
  it("rolls back stale cleanup and registration when the registered event fails", async () => {
    const name = `u3efailreg${RUN}${++seq}`;
    const staleId = nextId("stale_fail");
    await pgPool().query(
      `INSERT INTO agents (id, name, description, api_key, points, vote_points, evaluation_points,
                           legacy_unattributed_points, follower_count, is_claimed, created_at, is_vetted)
       VALUES ($1, $2, '', $3, 0, 0, 0, 0, 0, false, NOW() - INTERVAL '48 hours', false)`,
      [staleId, name, `u3ekey${staleId}`]
    );
    const before = await eventsSince();
    await expect(withEventFailure("agent.registered", () => registerAgent({ name, description: "" }))).rejects.toThrow(/u3e injected/);
    expect((await pgPool().query(`SELECT count(*)::int AS n FROM agents WHERE id = $1`, [staleId])).rows[0].n).toBe(1);
    expect((await eventsSince()).length).toBe(before.length);
  });

  it("rolls back a proctor claim after its event is inserted", async () => {
    const candidate = await seedAgent();
    const proctor = await seedAgent();
    const registrationId = await seedRegistration(candidate.id, PROCTORED);
    await expect(withEventFailure("evaluation.proctor_claimed", () => claimProctorSession({ agent: proctor, registrationId }))).rejects.toThrow(/u3e injected/);
    expect((await pgPool().query(`SELECT count(*)::int AS n FROM evaluation_sessions WHERE registration_id = $1`, [registrationId])).rows[0].n).toBe(0);
    expect(await eventsSince()).toEqual([]);
  });

  it("rolls back proctor completion, including the session transition", async () => {
    const candidate = await seedAgent();
    const proctor = await seedAgent();
    const registrationId = await seedRegistration(candidate.id, PROCTORED);
    const claimed = await claimProctorSession({ agent: proctor, registrationId });
    expect(claimed.ok).toBe(true);
    const { rows: claimMarker } = await pgPool().query(`SELECT COALESCE(MAX(id), 0)::bigint AS id FROM events`);
    baselineEventId = Number(claimMarker[0].id);
    await expect(withEventFailure("evaluation.completed", () => completeEvaluation({
      agentId: candidate.id, registrationId, evaluationId: PROCTORED, schoolId: "foundation",
      result: { passed: true }, proctorAgentId: proctor.id, endProctorSessionId: claimed.ok ? claimed.value.sessionId : undefined,
    }))).rejects.toThrow(/u3e injected/);
    expect((await pgPool().query(`SELECT status FROM evaluation_registrations WHERE id = $1`, [registrationId])).rows[0].status).toBe("in_progress");
    expect((await pgPool().query(`SELECT status FROM evaluation_sessions WHERE registration_id = $1`, [registrationId])).rows[0].status).toBe("active");
    expect(await eventsSince()).toEqual([]);
  });

  it("rolls back PoAW completion through the real submit route", async () => {
    const agent = await seedAgent({ vetted: false });
    const registrationId = await seedRegistration(agent.id, SELF_SERVE);
    const started = await startVetting({ agent });
    if (!started.ok) throw new Error("challenge refused");
    const challenge = started.data.challenge.id;
    // Vetted AFTER the challenge fixture: startVetting only issues for the unvetted (B3), while the
    // submit route's C2 gate requires a vetted agent — this test proves the rollback, not either gate.
    await pgPool().query(`UPDATE agents SET is_vetted = true WHERE id = $1`, [agent.id]);
    const { rows: vettingMarker } = await pgPool().query(`SELECT COALESCE(MAX(id), 0)::bigint AS id FROM events`);
    baselineEventId = Number(vettingMarker[0].id);
    const row = (await pgPool().query(`SELECT "values", nonce, expected_hash FROM vetting_challenges WHERE id = $1`, [challenge])).rows[0];
    await expect(withEventFailure("evaluation.completed", async () => {
      const response = await EVALUATION_SUBMIT_ROUTE(
        new Request(`http://localhost/api/v1/evaluations/${SELF_SERVE}/submit`, {
          method: "POST", headers: { authorization: `Bearer ${agent.apiKey}`, "content-type": "application/json", "x-school-id": "foundation" },
          body: JSON.stringify({ challenge_id: challenge, hash: row.expected_hash }),
        }) as never,
        { params: Promise.resolve({ id: SELF_SERVE }) }
      );
      expect(response.status).toBe(500);
    })).resolves.toBeUndefined();
    expect((await pgPool().query(`SELECT status FROM evaluation_registrations WHERE id = $1`, [registrationId])).rows[0].status).toBe("in_progress");
    expect((await pgPool().query(`SELECT count(*)::int AS n FROM evaluation_results WHERE registration_id = $1`, [registrationId])).rows[0].n).toBe(0);
    expect((await pgPool().query(`SELECT consumed_at FROM vetting_challenges WHERE id = $1`, [challenge])).rows[0].consumed_at).toBeNull();
    expect(await eventsSince("evaluation.completed")).toHaveLength(0);
  });

  it("rolls back certification job transition, result and event together", async () => {
    const agent = await seedAgent();
    const registrationId = await seedRegistration(agent.id, "agent_certification");
    const jobId = nextId("cert_job");
    const token = `u3etoken${jobId}`;
    await pgPool().query(
      `INSERT INTO certification_jobs (id, registration_id, agent_id, evaluation_id, nonce, nonce_expires_at, status, judge_token, judge_claim_expires_at)
       VALUES ($1, $2, $3, 'agent_certification', $4, NOW() + interval '1 hour', 'judging', $5, NOW() + interval '1 hour')`,
      [jobId, registrationId, agent.id, `nonce_${jobId}`, token]
    );
    await expect(withEventFailure("evaluation.completed", () => completeEvaluation({
      agentId: agent.id, registrationId, evaluationId: "agent_certification", schoolId: "foundation",
      result: { passed: true }, certificationJobId: jobId, certificationJudgeToken: token,
      certificationJudgeCompletedAt: new Date().toISOString(), certificationJudgeModel: "test", certificationJudgeResponse: {},
    }))).rejects.toThrow(/u3e injected/);
    expect((await pgPool().query(`SELECT status FROM certification_jobs WHERE id = $1`, [jobId])).rows[0].status).toBe("judging");
    expect((await pgPool().query(`SELECT count(*)::int AS n FROM evaluation_results WHERE registration_id = $1`, [registrationId])).rows[0].n).toBe(0);
  });

  it("rolls back a Cognito claim when agent.claimed fails", async () => {
    const claimToken = `u3eclaimfail${RUN}${++seq}`;
    const agent = await seedAgent({ claimToken });
    const humanId = `u3ehumanfail${RUN}${++seq}`;
    await pgPool().query(
      `INSERT INTO human_users (id, cognito_sub, email, created_at) VALUES ($1, $1, $2, NOW())`,
      [humanId, `${humanId}@example.test`]
    );

    await expect(withEventFailure("agent.claimed", () => claimAgentWithCognito({
      claimToken, humanUserId: humanId, owner: "cognito-owner",
    }))).rejects.toThrow(/u3e injected/);
    expect((await pgPool().query(`SELECT is_claimed FROM agents WHERE id = $1`, [agent.id])).rows[0].is_claimed).toBe(false);
    expect((await pgPool().query(`SELECT count(*)::int AS n FROM user_agents WHERE agent_id = $1`, [agent.id])).rows[0].n).toBe(0);
  });

  it("rolls back an X claim when agent.claimed fails", async () => {
    const agent = await seedAgent();
    await expect(withEventFailure("agent.claimed", () => claimAgentWithX({
      agentId: agent.id, owner: "@x-owner", xFollowerCount: 7,
    }))).rejects.toThrow(/u3e injected/);
    expect((await pgPool().query(`SELECT is_claimed, owner FROM agents WHERE id = $1`, [agent.id])).rows[0]).toMatchObject({ is_claimed: false, owner: null });
    expect((await pgPool().query(`SELECT count(*)::int AS n FROM user_agents WHERE agent_id = $1`, [agent.id])).rows[0].n).toBe(0);
  });

  it("does not complete a certification job when its terminal registration cannot transition", async () => {
    const agent = await seedAgent();
    const registrationId = await seedRegistration(agent.id, "agent_certification", "completed");
    const jobId = nextId("cert_zero_row");
    const token = `u3etoken${jobId}`;
    await pgPool().query(
      `INSERT INTO certification_jobs (id, registration_id, agent_id, evaluation_id, nonce, nonce_expires_at, status, judge_token, judge_claim_expires_at)
       VALUES ($1, $2, $3, 'agent_certification', $4, NOW() + interval '1 hour', 'judging', $5, NOW() + interval '1 hour')`,
      [jobId, registrationId, agent.id, `nonce_${jobId}`, token]
    );
    const result = await completeEvaluation({
      agentId: agent.id, registrationId, evaluationId: "agent_certification", schoolId: "foundation",
      result: { passed: true }, certificationJobId: jobId, certificationJudgeToken: token,
      certificationJudgeCompletedAt: new Date().toISOString(), certificationJudgeModel: "test", certificationJudgeResponse: {},
    });
    expect(result.outcome).toBe("not_actionable");
    expect((await pgPool().query(`SELECT status FROM certification_jobs WHERE id = $1`, [jobId])).rows[0].status).toBe("judging");
    expect((await pgPool().query(`SELECT count(*)::int AS n FROM evaluation_results WHERE registration_id = $1`, [registrationId])).rows[0].n).toBe(0);
    expect(await eventsSince("evaluation.completed")).toHaveLength(0);
  });

  it("rolls back vetting, bootstrap rows, challenge consumption and events", async () => {
    const { agent, challengeId } = await (async () => {
      const a = await seedAgent({ vetted: false });
      const started = await startVetting({ agent: a });
      if (!started.ok) throw new Error("challenge refused");
      return { agent: a, challengeId: started.data.challenge.id };
    })();
    await expect(withEventFailure("agent.vetted", async () => completeVetting({ agent, challengeId, hash: await challengeHash(challengeId), identityMd: "" }))).rejects.toThrow(/u3e injected/);
    expect((await pgPool().query(`SELECT is_vetted FROM agents WHERE id = $1`, [agent.id])).rows[0].is_vetted).toBe(false);
    expect((await pgPool().query(`SELECT consumed_at FROM vetting_challenges WHERE id = $1`, [challengeId])).rows[0].consumed_at).toBeNull();
    expect(await eventsSince("agent.vetted")).toHaveLength(0);
    expect(await eventsSince("evaluation.completed")).toHaveLength(0);
  });
});

describe("registration", () => {
  it("releases a pristine stale name in the SAME transaction as the insert", async () => {
    const name = `u3estale${RUN}${(seq += 1)}`;
    const staleId = nextId("stale");
    await pgPool().query(
      `INSERT INTO agents (id, name, description, api_key, points, vote_points, evaluation_points,
                           legacy_unattributed_points, follower_count, is_claimed, created_at, is_vetted,
                           last_active_at)
       VALUES ($1, $2, '', $3, 0, 0, 0, 0, 0, false, NOW() - INTERVAL '48 hours', false, NULL)`,
      [staleId, name, `u3ekey${staleId}`]
    );

    const result = await registerAgent({ name, description: "" });
    expect(result.ok).toBe(true);

    const gone = await pgPool().query(`SELECT count(*)::int AS n FROM agents WHERE id = $1`, [staleId]);
    expect(gone.rows[0].n).toBe(0);

    const expired = await eventsSince("agent.registration_expired");
    expect(expired).toHaveLength(1);
    expect(expired[0].subjectId).toBe(staleId);
    expect(expired[0].actorAgentId).toBeNull();

    const registered = await eventsSince("agent.registered");
    expect(registered).toHaveLength(1);
    expect(registered[0].actorAgentId).toBeNull();
    const fresh = await pgPool().query(`SELECT id FROM agents WHERE LOWER(name) = LOWER($1)`, [name]);
    expect(registered[0].subjectId).toBe(fresh.rows[0].id);
  });

  it("leaves an ever-authenticated unclaimed agent alone and emits no expiry", async () => {
    const name = `u3elive${RUN}${(seq += 1)}`;
    const liveId = nextId("live");
    await pgPool().query(
      `INSERT INTO agents (id, name, description, api_key, points, vote_points, evaluation_points,
                           legacy_unattributed_points, follower_count, is_claimed, created_at, is_vetted,
                           last_active_at)
       VALUES ($1, $2, '', $3, 0, 0, 0, 0, 0, false, NOW() - INTERVAL '48 hours', false,
               NOW() - INTERVAL '47 hours')`,
      [liveId, name, `u3ekey${liveId}`]
    );

    const result = await registerAgent({ name, description: "" });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.code).toBe("already_exists");

    const survived = await pgPool().query(`SELECT count(*)::int AS n FROM agents WHERE id = $1`, [liveId]);
    expect(survived.rows[0].n).toBe(1);
    expect(await eventsSince("agent.registration_expired")).toHaveLength(0);
    expect(await eventsSince("agent.registered")).toHaveLength(0);
  });
});

describe("vetting completion", () => {
  /**
   * The baseline moves PAST the fixture, because minting the challenge is itself a mutation that
   * emits `agent.vetting_started` — leaving it inside the window would make every "emits nothing"
   * assertion below describe the setup rather than the completion.
   */
  async function vettable(): Promise<{ agent: StoredAgent; challengeId: string }> {
    const agent = await seedAgent({ vetted: false });
    const started = await startVetting({ agent });
    if (!started.ok) throw new Error("challenge refused");
    const { rows } = await pgPool().query(`SELECT COALESCE(MAX(id), 0)::bigint AS id FROM events`);
    baselineEventId = Number(rows[0].id);
    return { agent, challengeId: started.data.challenge.id };
  }

  it("gives a fresh agent two completed registrations, two results, its points and the event set", async () => {
    const { agent, challengeId } = await vettable();
    const before = await karma(agent.id);

    const result = await completeVetting({ agent, challengeId, hash: await challengeHash(challengeId), identityMd: "# me\n" });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    expect(result.data.outcome).toBe("completed");

    const registrations = await pgPool().query(
      `SELECT evaluation_id, status, completed_at FROM evaluation_registrations
        WHERE agent_id = $1 ORDER BY evaluation_id`,
      [agent.id]
    );
    expect(registrations.rows.map((r: Record<string, unknown>) => r.status)).toEqual([
      "completed",
      "completed",
    ]);
    for (const row of registrations.rows) expect(row.completed_at).not.toBeNull();

    const results = await pgPool().query(
      `SELECT count(*)::int AS n FROM evaluation_results WHERE agent_id = $1`,
      [agent.id]
    );
    expect(results.rows[0].n).toBe(2);

    const vetted = await pgPool().query(`SELECT is_vetted FROM agents WHERE id = $1`, [agent.id]);
    expect(vetted.rows[0].is_vetted).toBe(true);

    expect(await eventsSince("agent.vetted")).toHaveLength(1);
    expect(await eventsSince("evaluation.registered")).toHaveLength(2);
    const completed = await eventsSince("evaluation.completed");
    expect(completed).toHaveLength(2);
    // Every completion names the EFFECTIVE registration it terminated — the id the statement's own
    // `effective` CTE produced, not either candidate the action could have guessed.
    for (const event of completed) {
      const payload = event.payload as { result_id: string; evaluation_id: string; passed: boolean };
      const { rows } = await pgPool().query(
        `SELECT registration_id FROM evaluation_results WHERE id = $1`,
        [payload.result_id]
      );
      expect(rows[0].registration_id).toBe(event.subjectId);
      expect(payload.passed).toBe(true);
    }

    // The bootstrap's 10 + 0.5 land with the batch, not after it.
    const after = await karma(agent.id);
    expect(after.evaluationPoints - before.evaluationPoints).toBeCloseTo(10.5, 2);
    expect(after.points - before.points).toBeCloseTo(10.5, 2);

    const consumed = await pgPool().query(`SELECT consumed_at FROM vetting_challenges WHERE id = $1`, [
      challengeId,
    ]);
    expect(consumed.rows[0].consumed_at).not.toBeNull();
  });

  it("reuses a pre-registered active registration without a 23505 and without a second event", async () => {
    const { agent, challengeId } = await vettable();
    const preexisting = await seedRegistration(agent.id, "poaw", "registered");

    const result = await completeVetting({ agent, challengeId, hash: await challengeHash(challengeId), identityMd: "" });
    expect(result.ok).toBe(true);

    const reused = await pgPool().query(`SELECT status FROM evaluation_registrations WHERE id = $1`, [
      preexisting,
    ]);
    expect(reused.rows[0].status).toBe("completed");

    const registered = await eventsSince("evaluation.registered");
    expect(registered).toHaveLength(1);
    expect((registered[0].payload as { evaluation_id: string }).evaluation_id).toBe("identity-check");
    expect(await eventsSince("evaluation.completed")).toHaveLength(2);

    const total = await pgPool().query(
      `SELECT count(*)::int AS n FROM evaluation_registrations WHERE agent_id = $1`,
      [agent.id]
    );
    expect(total.rows[0].n).toBe(2);
  });

  it("writes nothing and emits nothing for a bootstrap evaluation already passed", async () => {
    const { agent, challengeId } = await vettable();
    const passedRegistration = await seedRegistration(agent.id, "poaw", "completed");
    await pgPool().query(
      `INSERT INTO evaluation_results (id, registration_id, agent_id, evaluation_id, passed, completed_at,
                                       points_earned, evaluation_version, school_id)
       VALUES ($1, $2, $3, 'poaw', true, NOW(), 10, '1.0.0', 'foundation')`,
      [nextId("res"), passedRegistration, agent.id]
    );

    const result = await completeVetting({ agent, challengeId, hash: await challengeHash(challengeId), identityMd: "" });
    expect(result.ok).toBe(true);

    const completed = await eventsSince("evaluation.completed");
    expect(completed).toHaveLength(1);
    expect((completed[0].payload as { evaluation_id: string }).evaluation_id).toBe("identity-check");
    const registered = await eventsSince("evaluation.registered");
    expect(registered).toHaveLength(1);

    const results = await pgPool().query(
      `SELECT count(*)::int AS n FROM evaluation_results WHERE agent_id = $1 AND evaluation_id = 'poaw'`,
      [agent.id]
    );
    expect(results.rows[0].n).toBe(1);
  });

  it("emits nothing and vets nobody when the challenge is already consumed", async () => {
    const { agent, challengeId } = await vettable();
    await pgPool().query(`UPDATE vetting_challenges SET consumed_at = NOW() WHERE id = $1`, [challengeId]);

    const result = await completeVetting({ agent, challengeId, hash: await challengeHash(challengeId), identityMd: "" });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.reason).toBe("consumed_challenge");

    const vetted = await pgPool().query(`SELECT is_vetted FROM agents WHERE id = $1`, [agent.id]);
    expect(vetted.rows[0].is_vetted).toBe(false);
    expect(await eventsSince()).toHaveLength(0);
  });

  it("admits exactly one of two concurrent completions for the same challenge", async () => {
    const { agent, challengeId } = await vettable();

    const outcomes = await runConcurrently([
      async () => completeVetting({ agent, challengeId, hash: await challengeHash(challengeId), identityMd: "a" }),
      async () => completeVetting({ agent, challengeId, hash: await challengeHash(challengeId), identityMd: "b" }),
    ]);
    expect(rejections(outcomes)).toEqual([]);
    const completedRuns = outcomes.filter(
      (o) => o.ok && o.value.ok && o.value.data.outcome === "completed"
    );
    expect(completedRuns).toHaveLength(2);

    const results = await pgPool().query(
      `SELECT count(*)::int AS n FROM evaluation_results WHERE agent_id = $1`,
      [agent.id]
    );
    expect(results.rows[0].n).toBe(2);
    expect(await eventsSince("agent.vetted")).toHaveLength(1);
    expect(await eventsSince("evaluation.completed")).toHaveLength(2);
  });

  it("admits exactly one vetted transition for two different concurrent challenges", async () => {
    const agent = await seedAgent({ vetted: false });
    const first = await startVetting({ agent });
    const second = await startVetting({ agent });
    if (!first.ok || !second.ok) throw new Error("challenge refused");
    baselineEventId = Number((await pgPool().query(`SELECT COALESCE(MAX(id), 0)::bigint AS id FROM events`)).rows[0].id);
    const outcomes = await runConcurrently([
      async () => completeVetting({ agent, challengeId: first.data.challenge.id, hash: await challengeHash(first.data.challenge.id), identityMd: "a" }),
      async () => completeVetting({ agent, challengeId: second.data.challenge.id, hash: await challengeHash(second.data.challenge.id), identityMd: "b" }),
    ]);
    expect(rejections(outcomes)).toEqual([]);
    expect(outcomes.filter((outcome) => outcome.ok && outcome.value.ok && outcome.value.data.outcome === "completed")).toHaveLength(2);
    const challengeRows = await pgPool().query(
      `SELECT id, consumed_at FROM vetting_challenges WHERE id IN ($1, $2) ORDER BY id`,
      [first.data.challenge.id, second.data.challenge.id]
    );
    expect(challengeRows.rows).toHaveLength(2);
    expect(challengeRows.rows.filter((row) => row.consumed_at != null)).toHaveLength(2);
    expect(challengeRows.rows.filter((row) => row.consumed_at == null)).toHaveLength(0);
    expect(await eventsSince("agent.vetted")).toHaveLength(1);
  });
});
