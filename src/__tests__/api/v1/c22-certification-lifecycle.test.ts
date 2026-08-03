/**
 * M11-1 C22 — certification jobs: idempotent start, transcript CAS, judging lease (memory mode).
 *
 * The defect was unbounded paid work from one authenticated agent: every `start` minted a fresh
 * live job, submission updated blindly, and the judge was check-then-act around the billed model
 * call. These tests drive the memory store, the routes, and the judge with a mocked model; the
 * db-mode index races and the migration fixtures are `[integration]` gates in
 * `src/__tests__/integration/c22-certification-lifecycle.test.ts`.
 *
 * @jest-environment node
 */

let currentSchool = "foundation";
jest.mock("next/headers", () => ({
  headers: jest.fn(async () => new Headers({ "x-school-id": currentSchool })),
}));

// `waitUntil` needs a request context in tests; judging dispatch is exercised directly instead.
jest.mock("@vercel/functions", () => ({ waitUntil: jest.fn() }));

import * as mem from "@/lib/store/evaluations/memory";
import {
  agents,
  apiKeyToAgentId,
  certificationJobs,
  evaluationRegistrations,
  evaluationResults,
} from "@/lib/store/_memory-state";
import type { StoredAgent } from "@/lib/store-types";

const BASE = "https://safemolt.com";
/** Real Foundation agent_certification evaluation (`schools/foundation/evaluations/SIP-6.md`). */
const CERT = "jailbreak-safety";

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

function seedRegistration(agentId: string, status: "registered" | "in_progress" = "in_progress"): string {
  const id = `reg_${++seq}`;
  evaluationRegistrations.set(id, {
    id,
    agentId,
    evaluationId: CERT,
    registeredAt: new Date().toISOString(),
    status,
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

async function startRoute() {
  return (await import("@/app/api/v1/evaluations/[id]/start/route")).POST;
}

async function submitRoute() {
  return (await import("@/app/api/v1/evaluations/[id]/submit/route")).POST;
}

function liveJobs(registrationId: string) {
  return Array.from(certificationJobs.values()).filter(
    (j) => j.registrationId === registrationId && ["pending", "submitted", "judging"].includes(j.status)
  );
}

const JUDGE_JSON = JSON.stringify({
  scores: [{ promptId: "p1", score: 90, maxScore: 100, feedback: "solid" }],
  totalScore: 90,
  maxScore: 100,
  passed: true,
  summary: "Passed.",
});

/** A model endpoint that answers like the judge expects, counting invocations. */
function mockJudgeFetch() {
  const fetchMock = jest.fn(async () => ({
    ok: true,
    json: async () => ({ choices: [{ message: { content: JUDGE_JSON } }], model: "mock-judge" }),
  }));
  (global as { fetch: unknown }).fetch = fetchMock;
  return fetchMock;
}

const REAL_FETCH = global.fetch;

beforeEach(() => {
  currentSchool = "foundation";
  seq = 0;
  agents.clear();
  apiKeyToAgentId.clear();
  evaluationRegistrations.clear();
  evaluationResults.clear();
  certificationJobs.clear();
  process.env.PUBLICAI_API_KEY = "test-judge-key";
});

afterAll(() => {
  global.fetch = REAL_FETCH;
  delete process.env.PUBLICAI_API_KEY;
});

describe("start is idempotent, not creative", () => {
  it("returns the same job and nonce on repeated start", async () => {
    const agent = makeAgent({ id: "starter" });
    const registrationId = seedRegistration(agent.id, "registered");
    const start = await startRoute();

    const first = await start(post(`${BASE}/api/v1/evaluations/${CERT}/start`, {}, agent.apiKey) as never, {
      params: Promise.resolve({ id: CERT }),
    });
    expect(first.status).toBe(200);
    const firstBody = await first.json();

    const second = await start(post(`${BASE}/api/v1/evaluations/${CERT}/start`, {}, agent.apiKey) as never, {
      params: Promise.resolve({ id: CERT }),
    });
    expect(second.status).toBe(200);
    const secondBody = await second.json();

    expect(secondBody.job_id).toBe(firstBody.job_id);
    expect(secondBody.nonce).toBe(firstBody.nonce);
    expect(liveJobs(registrationId)).toHaveLength(1);
  });

  it("occupies one job under concurrent starts", async () => {
    const agent = makeAgent({ id: "racer" });
    const registrationId = seedRegistration(agent.id, "registered");
    const start = await startRoute();

    const responses = await Promise.all([
      start(post(`${BASE}/api/v1/evaluations/${CERT}/start`, {}, agent.apiKey) as never, {
        params: Promise.resolve({ id: CERT }),
      }),
      start(post(`${BASE}/api/v1/evaluations/${CERT}/start`, {}, agent.apiKey) as never, {
        params: Promise.resolve({ id: CERT }),
      }),
    ]);

    const bodies = await Promise.all(responses.map((r) => r.json()));
    expect(new Set(bodies.map((b) => b.job_id)).size).toBe(1);
    expect(liveJobs(registrationId)).toHaveLength(1);
  });

  it("expires a pending job whose nonce lapsed and issues a fresh one", async () => {
    const agent = makeAgent({ id: "stale" });
    const registrationId = seedRegistration(agent.id);
    const staleJob = await mem.createCertificationJob(registrationId, agent.id, CERT, "stale-nonce", new Date(Date.now() - 60_000));
    const start = await startRoute();

    const res = await start(post(`${BASE}/api/v1/evaluations/${CERT}/start`, {}, agent.apiKey) as never, {
      params: Promise.resolve({ id: CERT }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();

    expect(body.job_id).not.toBe(staleJob.id);
    expect(certificationJobs.get(staleJob.id)!.status).toBe("expired");
    expect(liveJobs(registrationId)).toHaveLength(1);
    // The dead nonce did not strand the registration: the fresh job is startable and live.
    expect(certificationJobs.get(body.job_id)!.status).toBe("pending");
  });
});

describe("the completed-job gap does not mint a second paid attempt", () => {
  it("start returns the decided job while its result save is in flight, instead of a fresh one", async () => {
    // The judge fences the job `completed` and then saves the result; in that gap the
    // registration is still in_progress and no *live* job exists. A fresh job here would be a
    // second paid judging for a verdict that already exists.
    const agent = makeAgent({ id: "gap" });
    const registrationId = seedRegistration(agent.id);
    const decided = await mem.createCertificationJob(registrationId, agent.id, CERT, `nonce_${++seq}`, new Date(Date.now() + 60_000));
    await mem.submitCertificationTranscript(decided.id, [{ promptId: "p1", prompt: "q", response: "a" }], new Date().toISOString());
    await mem.claimCertificationJobForJudging(decided.id, "t-gap", 60_000);
    await mem.completeCertificationJudging(decided.id, "t-gap", { judgeCompletedAt: new Date().toISOString(), judgeModel: "m", judgeResponse: {} });
    // The result save has NOT landed: the registration is still in_progress.

    const start = await startRoute();
    const res = await start(post(`${BASE}/api/v1/evaluations/${CERT}/start`, {}, agent.apiKey) as never, {
      params: Promise.resolve({ id: CERT }),
    });
    expect(res.status).toBe(200);
    expect((await res.json()).job_id).toBe(decided.id);
    expect(Array.from(certificationJobs.values()).filter((j) => j.registrationId === registrationId)).toHaveLength(1);

    // A *failed* judging is not a verdict — a fresh attempt is the legitimate path back in.
    const retrier = makeAgent({ id: "gap-retrier" });
    const retryReg = seedRegistration(retrier.id);
    const failed = await mem.createCertificationJob(retryReg, retrier.id, CERT, `nonce_${++seq}`, new Date(Date.now() + 60_000));
    await mem.submitCertificationTranscript(failed.id, [{ promptId: "p1", prompt: "q", response: "a" }], new Date().toISOString());
    await mem.claimCertificationJobForJudging(failed.id, "t-f", 60_000);
    await mem.failCertificationJudging(failed.id, "t-f", "judge broke");
    const retry = await start(post(`${BASE}/api/v1/evaluations/${CERT}/start`, {}, retrier.apiKey) as never, {
      params: Promise.resolve({ id: CERT }),
    });
    expect(retry.status).toBe(200);
    expect((await retry.json()).job_id).not.toBe(failed.id);
  });
});

describe("transcript intake is a CAS", () => {
  it("refuses a transcript once the nonce window closed, even when the status check passed", async () => {
    // The route's wall-clock check is a courtesy; the CAS predicate is the decision. A request
    // that read an unexpired nonce and stalled past the deadline may not land its transcript.
    const agent = makeAgent({ id: "deadline" });
    const registrationId = seedRegistration(agent.id);
    const job = await mem.createCertificationJob(registrationId, agent.id, CERT, `nonce_${++seq}`, new Date(Date.now() - 1));

    const accepted = await mem.submitCertificationTranscript(job.id, [{ promptId: "p1", prompt: "q", response: "a" }], new Date().toISOString());

    expect(accepted).toBe(false);
    expect(certificationJobs.get(job.id)!.status).toBe("pending");
    expect(certificationJobs.get(job.id)!.transcript).toBeUndefined();
  });

  it("accepts one transcript and refuses the second at the store", async () => {
    const agent = makeAgent({ id: "submitter" });
    const registrationId = seedRegistration(agent.id);
    const job = await mem.createCertificationJob(registrationId, agent.id, CERT, "nonce-1", new Date(Date.now() + 60_000));

    const first = await mem.submitCertificationTranscript(job.id, [{ promptId: "p1", prompt: "q", response: "a" }], new Date().toISOString());
    const second = await mem.submitCertificationTranscript(job.id, [{ promptId: "p1", prompt: "q", response: "OVERWRITE" }], new Date().toISOString());

    expect(first).toBe(true);
    expect(second).toBe(false);
    expect(certificationJobs.get(job.id)!.transcript![0].response).toBe("a");
  });

  it("route: an expired nonce expires the job conditionally — a raced-in submission is not clobbered", async () => {
    const agent = makeAgent({ id: "expirer" });
    const registrationId = seedRegistration(agent.id);
    const staleJob = await mem.createCertificationJob(registrationId, agent.id, CERT, "n-stale", new Date(Date.now() - 60_000));
    const submit = await submitRoute();
    const { generateNonce } = await import("@/lib/evaluations/nonce");

    // The plain case: a pending job whose nonce lapsed is expired by the refusal.
    // (The nonce must be validly signed — expiry is judged from the job row.)
    const expiredNonce = generateNonce(CERT, agent.id);
    certificationJobs.get(staleJob.id)!.nonce = expiredNonce;
    const refused = await submit(
      post(`${BASE}/api/v1/evaluations/${CERT}/submit`, { nonce: expiredNonce, transcript: [{ promptId: "p1", prompt: "q", response: "a" }] }, agent.apiKey) as never,
      { params: Promise.resolve({ id: CERT }) }
    );
    expect(refused.status).toBe(400);
    expect(certificationJobs.get(staleJob.id)!.status).toBe("expired");

    // The race shape: a submission won *inside* the nonce window, then the window closed while a
    // second request's expiry path ran. The expiry write is a CAS on `pending`, so the accepted
    // transcript survives instead of being clobbered to `expired` behind its own 200.
    const racer = makeAgent({ id: "race-winner" });
    const racedReg = seedRegistration(racer.id);
    const racedJob = await mem.createCertificationJob(racedReg, racer.id, CERT, "n-raced", new Date(Date.now() + 60_000));
    await mem.submitCertificationTranscript(racedJob.id, [{ promptId: "p1", prompt: "q", response: "a" }], new Date().toISOString());
    certificationJobs.get(racedJob.id)!.nonceExpiresAt = new Date(Date.now() - 1).toISOString();
    expect(await mem.expireStalePendingCertificationJob(racedJob.id)).toBe(false);
    expect(certificationJobs.get(racedJob.id)!.status).toBe("submitted");
  });

  it("route: a second submission of the same nonce is refused, not judged twice", async () => {
    // The accepted submission schedules real judging; point it at the mock model, never the wire.
    mockJudgeFetch();
    const agent = makeAgent({ id: "resubmitter" });
    seedRegistration(agent.id, "registered");
    const start = await startRoute();
    const startRes = await start(post(`${BASE}/api/v1/evaluations/${CERT}/start`, {}, agent.apiKey) as never, {
      params: Promise.resolve({ id: CERT }),
    });
    const { nonce } = await startRes.json();
    const submit = await submitRoute();
    const transcript = [{ promptId: "p1", prompt: "q", response: "a" }];

    const first = await submit(post(`${BASE}/api/v1/evaluations/${CERT}/submit`, { nonce, transcript }, agent.apiKey) as never, {
      params: Promise.resolve({ id: CERT }),
    });
    expect(first.status).toBe(200);

    const second = await submit(post(`${BASE}/api/v1/evaluations/${CERT}/submit`, { nonce, transcript }, agent.apiKey) as never, {
      params: Promise.resolve({ id: CERT }),
    });
    expect(second.status).toBe(400);
    expect((await second.json()).error).toBe("Already submitted");
  });
});

describe("the judging lease", () => {
  async function submittedJob(agentId: string) {
    const registrationId = seedRegistration(agentId);
    const job = await mem.createCertificationJob(registrationId, agentId, CERT, `nonce_${++seq}`, new Date(Date.now() + 60_000));
    await mem.submitCertificationTranscript(job.id, [{ promptId: "p1", prompt: "q", response: "a" }], new Date().toISOString());
    return { registrationId, jobId: job.id };
  }

  it("claims exactly one dispatcher, and fences a stranger's terminal writes", async () => {
    const agent = makeAgent({ id: "claimant" });
    const { jobId } = await submittedJob(agent.id);

    const winner = await mem.claimCertificationJobForJudging(jobId, "token-a", 60_000);
    const loser = await mem.claimCertificationJobForJudging(jobId, "token-b", 60_000);
    expect(winner).not.toBeNull();
    expect(loser).toBeNull();

    expect(await mem.completeCertificationJudging(jobId, "token-b", { judgeCompletedAt: new Date().toISOString(), judgeModel: "m", judgeResponse: {} })).toBe(false);
    expect(await mem.failCertificationJudging(jobId, "token-b", "nope")).toBe(false);
    expect(certificationJobs.get(jobId)!.status).toBe("judging");

    expect(await mem.completeCertificationJudging(jobId, "token-a", { judgeCompletedAt: new Date().toISOString(), judgeModel: "m", judgeResponse: {} })).toBe(true);
    expect(certificationJobs.get(jobId)!.status).toBe("completed");
  });

  it("invokes the model once under double dispatch, and records one verdict and one payout", async () => {
    const fetchMock = mockJudgeFetch();
    const agent = makeAgent({ id: "judged" });
    const { registrationId, jobId } = await submittedJob(agent.id);
    const { judgeCertificationJob } = await import("@/lib/evaluations/judge");

    const [a, b] = await Promise.all([judgeCertificationJob(jobId), judgeCertificationJob(jobId)]);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect([a, b].filter((v) => v !== null)).toHaveLength(1);
    expect(certificationJobs.get(jobId)!.status).toBe("completed");
    expect(evaluationRegistrations.get(registrationId)!.status).toBe("completed");
    expect(Array.from(evaluationResults.values()).filter((r) => r.registrationId === registrationId)).toHaveLength(1);
    expect(agents.get(agent.id)!.points).toBe(90);
  });

  it("reclaims a lapsed claim, and the stalled claimant can no longer touch the job", async () => {
    const agent = makeAgent({ id: "stalled" });
    const { jobId } = await submittedJob(agent.id);
    await mem.claimCertificationJobForJudging(jobId, "token-stalled", 60_000);
    certificationJobs.get(jobId)!.judgeClaimExpiresAt = new Date(Date.now() - 1000).toISOString();

    const reclaimed = await mem.reclaimExpiredCertificationJobs();
    expect(reclaimed.map((j) => j.id)).toEqual([jobId]);
    expect(certificationJobs.get(jobId)!.status).toBe("submitted");
    expect(certificationJobs.get(jobId)!.judgeToken).toBeUndefined();

    // The stalled claimant's late writes bounce off the cleared fence.
    expect(await mem.completeCertificationJudging(jobId, "token-stalled", { judgeCompletedAt: new Date().toISOString(), judgeModel: "m", judgeResponse: {} })).toBe(false);
    expect(await mem.failCertificationJudging(jobId, "token-stalled", "late")).toBe(false);
    expect(certificationJobs.get(jobId)!.status).toBe("submitted");

    // A fresh claim completes the job normally.
    expect(await mem.claimCertificationJobForJudging(jobId, "token-fresh", 60_000)).not.toBeNull();
    expect(await mem.completeCertificationJudging(jobId, "token-fresh", { judgeCompletedAt: new Date().toISOString(), judgeModel: "m", judgeResponse: {} })).toBe(true);
  });

  it("reclaims a leaseless legacy judging job after the grace, and not before", async () => {
    // The pre-C22 judge set status='judging' with no lease before its inline model call; such a
    // row would otherwise hold the live-job index forever while being invisible to every reclaim
    // predicate — the stranded-registration shape the reclaim exists to prevent.
    const agent = makeAgent({ id: "legacy" });
    const { jobId } = await submittedJob(agent.id);
    const job = certificationJobs.get(jobId)!;
    job.status = "judging";
    job.judgeToken = undefined;
    job.judgeClaimExpiresAt = undefined;
    job.judgeStartedAt = new Date(Date.now() - 60_000).toISOString(); // recent: may be mid-flight
    expect(await mem.reclaimExpiredCertificationJobs()).toHaveLength(0);

    job.judgeStartedAt = new Date(Date.now() - 31 * 60_000).toISOString(); // past the grace
    const reclaimed = await mem.reclaimExpiredCertificationJobs();
    expect(reclaimed.map((j) => j.id)).toEqual([jobId]);
    expect(certificationJobs.get(jobId)!.status).toBe("submitted");
  });

  it("reclaims oldest effective expiry first when lapsed jobs exceed the batch", async () => {
    const a = makeAgent({ id: "order-a" });
    const b = makeAgent({ id: "order-b" });
    const c = makeAgent({ id: "order-c" });
    // Inserted newest-lapsed first, so insertion order would pick the wrong pair.
    const jobs: string[] = [];
    for (const [agent, lapsedMsAgo] of [[a, 1_000], [b, 30_000], [c, 60_000]] as const) {
      const { jobId } = await submittedJob(agent.id);
      await mem.claimCertificationJobForJudging(jobId, `t-${agent.id}`, 60_000);
      certificationJobs.get(jobId)!.judgeClaimExpiresAt = new Date(Date.now() - lapsedMsAgo).toISOString();
      jobs.push(jobId);
    }

    const reclaimed = await mem.reclaimExpiredCertificationJobs(2);
    expect(reclaimed.map((j) => j.id)).toEqual([jobs[2], jobs[1]]);
  });

  it("retires an unjudgeable submitted job instead of leaving it stuck forever", async () => {
    // A submitted job whose evaluation definition is gone used to throw before the claim: never
    // failed, never reclaimable, holding the live-job index and crowding the stale-submitted
    // batch. It now retires as failed (CAS on `submitted`) and dispatch reports null.
    const agent = makeAgent({ id: "unjudgeable" });
    const registrationId = seedRegistration(agent.id);
    const job = await mem.createCertificationJob(registrationId, agent.id, "no-such-evaluation", `nonce_${++seq}`, new Date(Date.now() + 60_000));
    await mem.submitCertificationTranscript(job.id, [{ promptId: "p1", prompt: "q", response: "a" }], new Date().toISOString());
    const { judgeCertificationJob } = await import("@/lib/evaluations/judge");

    const verdict = await judgeCertificationJob(job.id);

    expect(verdict).toBeNull();
    expect(certificationJobs.get(job.id)!.status).toBe("failed");
    expect(certificationJobs.get(job.id)!.errorMessage).toContain("no-such-evaluation");
    // The registration is no longer blocked: a fresh attempt is creatable.
    expect((await mem.createCertificationJob(registrationId, agent.id, CERT, `nonce_${++seq}`, new Date(Date.now() + 60_000))).id).not.toBe(job.id);
  });

  it("a completed job does not block a fresh attempt", async () => {
    const agent = makeAgent({ id: "retrier" });
    const registrationId = seedRegistration(agent.id);
    const done = await mem.createCertificationJob(registrationId, agent.id, CERT, `nonce_${++seq}`, new Date(Date.now() + 60_000));
    await mem.submitCertificationTranscript(done.id, [{ promptId: "p1", prompt: "q", response: "a" }], new Date().toISOString());
    await mem.claimCertificationJobForJudging(done.id, "t", 60_000);
    await mem.completeCertificationJudging(done.id, "t", { judgeCompletedAt: new Date().toISOString(), judgeModel: "m", judgeResponse: {} });

    const fresh = await mem.createCertificationJob(registrationId, agent.id, CERT, `nonce_${++seq}`, new Date(Date.now() + 60_000));
    expect(fresh.id).not.toBe(done.id);
    expect(liveJobs(registrationId)).toHaveLength(1);
  });
});

describe("the reclaim-and-dispatch cron", () => {
  const SAVED = { CRON_SECRET: process.env.CRON_SECRET, ALLOW_INSECURE_CRON: process.env.ALLOW_INSECURE_CRON };

  afterEach(() => {
    if (SAVED.CRON_SECRET === undefined) delete process.env.CRON_SECRET;
    else process.env.CRON_SECRET = SAVED.CRON_SECRET;
    if (SAVED.ALLOW_INSECURE_CRON === undefined) delete process.env.ALLOW_INSECURE_CRON;
    else process.env.ALLOW_INSECURE_CRON = SAVED.ALLOW_INSECURE_CRON;
  });

  it("refuses without the bearer and re-judges a reclaimed job with it", async () => {
    process.env.CRON_SECRET = "cron-secret";
    delete process.env.ALLOW_INSECURE_CRON;
    const fetchMock = mockJudgeFetch();
    const agent = makeAgent({ id: "cron-agent" });
    const registrationId = seedRegistration(agent.id);
    const job = await mem.createCertificationJob(registrationId, agent.id, CERT, `nonce_${++seq}`, new Date(Date.now() + 60_000));
    await mem.submitCertificationTranscript(job.id, [{ promptId: "p1", prompt: "q", response: "a" }], new Date().toISOString());
    await mem.claimCertificationJobForJudging(job.id, "token-crashed", 60_000);
    certificationJobs.get(job.id)!.judgeClaimExpiresAt = new Date(Date.now() - 1000).toISOString();

    const { GET } = await import("@/app/api/v1/internal/certification-judging/route");

    const denied = await GET(new Request(`${BASE}/api/v1/internal/certification-judging`));
    expect(denied.status).toBe(401);
    expect(certificationJobs.get(job.id)!.status).toBe("judging");

    const admitted = await GET(
      new Request(`${BASE}/api/v1/internal/certification-judging`, {
        headers: { authorization: "Bearer cron-secret" },
      })
    );
    expect(admitted.status).toBe(200);
    const body = await admitted.json();
    expect(body.reclaimed).toBe(1);
    expect(body.judged).toBe(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(certificationJobs.get(job.id)!.status).toBe("completed");
    expect(evaluationRegistrations.get(registrationId)!.status).toBe("completed");
  });
});
