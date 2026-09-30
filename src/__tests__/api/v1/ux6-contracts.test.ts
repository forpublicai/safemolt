/**
 * @jest-environment node
 */

import type { StoredAgent } from "@/lib/store-types";

function agent(overrides: Partial<StoredAgent> = {}): StoredAgent {
  return {
    id: "agent-1",
    name: "agent-one",
    apiKey: "ak_1",
    isClaimed: false,
    isVetted: true,
    isAdmitted: false,
    karma: 0,
    points: 0,
    followerCount: 0,
    followingCount: 0,
    createdAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  } as StoredAgent;
}

describe("UX6 memory contract", () => {
  beforeEach(() => {
    jest.resetModules();
  });

  it("defaults omitted agent_id to bearer agent and returns canonical context-list envelope", async () => {
    jest.doMock("@/auth", () => ({ auth: jest.fn(async () => null) }));
    jest.doMock("@/lib/auth", () => ({
      getAgentFromRequest: jest.fn(async () => agent()),
      optionalAgent: jest.fn(async () => ({ agent: agent(), denial: null })),
      platformAccessDenial: jest.fn(() => null),
      requireAgent: jest.fn(async () => {
        const resolved = await (async () => agent())();
        return resolved
          ? { ok: true, agent: resolved }
          : { ok: false, response: Response.json({ success: false, error: "Unauthorized" }, { status: 401 }) };
      }),
      jsonResponse: (body: unknown, status = 200) => Response.json(body, { status }),
      errorResponse: (error: string, hint?: string, status = 400, options: { code?: string } = {}) =>
        Response.json({ success: false, error, hint, error_detail: { code: options.code ?? "bad_request", message: error, hint }, request_id: "req-test" }, { status }),
    }));
    jest.doMock("@/lib/human-users", () => ({
      listAgentsForUser: jest.fn(async () => []),
      userOwnsAgent: jest.fn(async () => false),
    }));
    jest.doMock("@/lib/memory/context-store", () => ({
      listContextPaths: jest.fn(async (agentId: string) => {
        expect(agentId).toBe("agent-1");
        return ["IDENTITY.md"];
      }),
    }));

    const { GET } = await import("@/app/api/v1/memory/context/list/route");
    const res = await GET(new Request("https://safe.test/api/v1/memory/context/list"));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.success).toBe(true);
    expect(body.data).toEqual({ files: ["IDENTITY.md"] });
    expect(body.files).toEqual(["IDENTITY.md"]);
    expect(body.meta).toEqual({ count: 1, agent_id: "agent-1" });
  });

  it("denies explicit cross-agent memory access for bearer agents", async () => {
    jest.doMock("@/auth", () => ({ auth: jest.fn(async () => null) }));
    jest.doMock("@/lib/auth", () => ({
      getAgentFromRequest: jest.fn(async () => agent()),
      optionalAgent: jest.fn(async () => ({ agent: agent(), denial: null })),
      platformAccessDenial: jest.fn(() => null),
      requireAgent: jest.fn(async () => {
        const resolved = await (async () => agent())();
        return resolved
          ? { ok: true, agent: resolved }
          : { ok: false, response: Response.json({ success: false, error: "Unauthorized" }, { status: 401 }) };
      }),
      jsonResponse: (body: unknown, status = 200) => Response.json(body, { status }),
      errorResponse: (error: string, hint?: string, status = 400, options: { code?: string } = {}) =>
        Response.json({ success: false, error, hint, error_detail: { code: options.code ?? "bad_request", message: error, hint }, request_id: "req-test" }, { status }),
    }));
    jest.doMock("@/lib/human-users", () => ({
      listAgentsForUser: jest.fn(async () => []),
      userOwnsAgent: jest.fn(async () => false),
    }));
    const listContextPaths = jest.fn();
    jest.doMock("@/lib/memory/context-store", () => ({ listContextPaths }));

    const { GET } = await import("@/app/api/v1/memory/context/list/route");
    const res = await GET(new Request("https://safe.test/api/v1/memory/context/list?agent_id=agent-2"));
    const body = await res.json();

    expect(res.status).toBe(403);
    expect(body.success).toBe(false);
    expect(body.error).toBe("Forbidden");
    expect(listContextPaths).not.toHaveBeenCalled();
  });

  it("falls back and backfills IDENTITY.md from agent identity cache", async () => {
    // **The backfill goes through the WRITE ACTION since M11-2 P1.4** (u3f), not through the
    // context store directly: a state-changing GET with its own writer would be a second producer
    // of `agent_context_files` with no event. So the double is the domain service the action
    // delegates to, and the assertion below is on the `lazy: true` event it hands down.
    const putContextFile = jest.fn(async () => undefined);
    const putContextAndMaybeIndex = jest.fn(async () => ({ path: "IDENTITY.md" }));
    jest.doMock("@/auth", () => ({ auth: jest.fn(async () => null) }));
    jest.doMock("@/lib/auth", () => ({
      getAgentFromRequest: jest.fn(async () => agent({ identityMd: "# Agent\n" })),
      optionalAgent: jest.fn(async () => ({ agent: agent({ identityMd: "# Agent\n" }), denial: null })),
      platformAccessDenial: jest.fn(() => null),
      requireAgent: jest.fn(async () => {
        const resolved = await (async () => agent({ identityMd: "# Agent\n" }))();
        return resolved
          ? { ok: true, agent: resolved }
          : { ok: false, response: Response.json({ success: false, error: "Unauthorized" }, { status: 401 }) };
      }),
      jsonResponse: (body: unknown, status = 200) => Response.json(body, { status }),
      errorResponse: (error: string, hint?: string, status = 400, options: { code?: string } = {}) =>
        Response.json({ success: false, error, hint, error_detail: { code: options.code ?? "bad_request", message: error, hint }, request_id: "req-test" }, { status }),
    }));
    jest.doMock("@/lib/human-users", () => ({ listAgentsForUser: jest.fn(), userOwnsAgent: jest.fn() }));
    jest.doMock("@/lib/memory/context-store", () => ({
      getContextFile: jest.fn(async () => null),
      putContextFile,
      deleteContextFile: jest.fn(),
    }));
    jest.doMock("@/lib/memory/memory-service", () => ({
      putContextAndMaybeIndex,
      deleteContextAndIndex: jest.fn(),
    }));
    jest.doMock("@/lib/store", () => ({ getAgentById: jest.fn(async () => agent({ identityMd: "# Agent\n" })) }));

    const { GET } = await import("@/app/api/v1/memory/context/file/route");
    const res = await GET(new Request("https://safe.test/api/v1/memory/context/file?path=IDENTITY.md"));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.data).toMatchObject({ path: "IDENTITY.md", content: "# Agent\n", source: "agent_identity_cache" });
    expect(body.meta.agent_id).toBe("agent-1");
    expect(putContextAndMaybeIndex).toHaveBeenCalledWith(
      "agent-1",
      "IDENTITY.md",
      "# Agent\n",
      { sessionUserId: null },
      [
        expect.objectContaining({
          kind: "memory.context_written",
          payload: { file_path: "IDENTITY.md", lazy: true },
        }),
      ]
    );
    // And nothing writes the row behind the action's back.
    expect(putContextFile).not.toHaveBeenCalled();
  });
});

describe("UX6 class evaluation contract", () => {
  beforeEach(() => jest.resetModules());

  it("does not expose an evaluation through the wrong parent class URL", async () => {
    jest.doMock("@/lib/auth-professor", () => ({ getProfessorFromRequest: jest.fn(async () => null) }));
    jest.doMock("@/lib/auth", () => ({
      jsonResponse: (body: unknown, status = 200) => Response.json(body, { status }),
      errorResponse: (error: string, hint?: string, status = 400, options: { code?: string } = {}) =>
        Response.json({ success: false, error, hint, error_detail: { code: options.code ?? "bad_request", message: error, hint }, request_id: "req-test" }, { status }),
    }));
    jest.doMock("@/lib/store", () => ({
      getClassById: jest.fn(async () => ({ id: "class-parent", slug: "class-slug", professorId: "prof-1", name: "Class", status: "active", enrollmentOpen: true, createdAt: "2026-01-01T00:00:00.000Z" })),
      getClassEvaluation: jest.fn(async () => ({ id: "eval-1", classId: "other-class", title: "Eval", prompt: "Secret", status: "active", kind: "automatic", createdAt: "2026-01-01T00:00:00.000Z" })),
      updateClassEvaluation: jest.fn(),
    }));

    const { GET } = await import("@/app/api/v1/classes/[id]/evaluations/[evalId]/route");
    const res = await GET(new Request("https://safe.test"), { params: Promise.resolve({ id: "class-slug", evalId: "eval-1" }) });
    const body = await res.json();

    expect(res.status).toBe(404);
    expect(body.success).toBe(false);
    expect(body.error).toBe("Evaluation not found");
  });

  it("lists class evaluations by slug with prompt/material and snake_case fields", async () => {
    jest.doMock("next/headers", () => ({ headers: jest.fn(async () => new Headers({ "x-school-id": "foundation" })) }));
    jest.doMock("@/lib/auth-professor", () => ({ getProfessorFromRequest: jest.fn(async () => null) }));
    jest.doMock("@/lib/auth", () => ({
      getAgentFromRequest: jest.fn(async () => agent()),
      optionalAgent: jest.fn(async () => ({ agent: agent(), denial: null })),
      platformAccessDenial: jest.fn(() => null),
      requireAgent: jest.fn(async () => {
        const resolved = await (async () => agent())();
        return resolved
          ? { ok: true, agent: resolved }
          : { ok: false, response: Response.json({ success: false, error: "Unauthorized" }, { status: 401 }) };
      }),
      jsonResponse: (body: unknown, status = 200) => Response.json(body, { status }),
      errorResponse: (error: string, hint?: string, status = 400, options: { code?: string } = {}) =>
        Response.json({ success: false, error, hint, error_detail: { code: options.code ?? "bad_request", message: error, hint }, request_id: "req-test" }, { status }),
    }));
    // M11-1 C20 round 2: class routes key their access check on the *class's* school, not
    // the request host, so the resource-scoped helper has to be mocked too.
    jest.doMock("@/lib/school-context", () => ({
      requireSchoolAccess: jest.fn(() => null),
      requireClassSchoolAccess: jest.fn(() => null),
      // u3f-core M9: the class actions now decide the school denial by reason, so the leaked
      // school-context mock must expose it too (null = access granted, matching these tests).
      schoolAccessDenialReason: jest.fn(() => null),
    }));
    jest.doMock("@/lib/store", () => ({
      getClassById: jest.fn(async () => ({ id: "class-uuid", slug: "class-slug", schoolId: "foundation", professorId: "prof-1", name: "Class", status: "active", enrollmentOpen: true, createdAt: "2026-01-01T00:00:00.000Z" })),
      createClassEvaluation: jest.fn(),
      listClassEvaluations: jest.fn(async (classId: string) => {
        expect(classId).toBe("class-uuid");
        return [{ id: "eval-1", classId, title: "Eval", prompt: "Answer this", description: "Desc", taughtTopic: "Topic", status: "active", kind: "self_serve", maxScore: 10, createdAt: "2026-01-01T00:00:00.000Z" }];
      }),
    }));

    const { GET } = await import("@/app/api/v1/classes/[id]/evaluations/route");
    const res = await GET(new Request("https://safe.test"), { params: Promise.resolve({ id: "class-slug" }) });
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.data[0]).toMatchObject({
      class_id: "class-uuid",
      taught_topic: "Topic",
      max_score: 10,
      created_at: "2026-01-01T00:00:00.000Z",
      kind: "self_serve",
      prompt: "Answer this",
    });
    expect(body.data[0].taughtTopic).toBeUndefined();
  });

  it("normalizes non-ISO class evaluation timestamps at the route boundary", async () => {
    jest.doMock("next/headers", () => ({ headers: jest.fn(async () => new Headers({ "x-school-id": "foundation" })) }));
    jest.doMock("@/lib/auth-professor", () => ({ getProfessorFromRequest: jest.fn(async () => null) }));
    jest.doMock("@/lib/auth", () => ({
      getAgentFromRequest: jest.fn(async () => agent()),
      optionalAgent: jest.fn(async () => ({ agent: agent(), denial: null })),
      platformAccessDenial: jest.fn(() => null),
      requireAgent: jest.fn(async () => {
        const resolved = await (async () => agent())();
        return resolved
          ? { ok: true, agent: resolved }
          : { ok: false, response: Response.json({ success: false, error: "Unauthorized" }, { status: 401 }) };
      }),
      jsonResponse: (body: unknown, status = 200) => Response.json(body, { status }),
      errorResponse: (error: string, hint?: string, status = 400, options: { code?: string } = {}) =>
        Response.json({ success: false, error, hint, error_detail: { code: options.code ?? "bad_request", message: error, hint }, request_id: "req-test" }, { status }),
    }));
    // M11-1 C20 round 2: class routes key their access check on the *class's* school, not
    // the request host, so the resource-scoped helper has to be mocked too.
    jest.doMock("@/lib/school-context", () => ({
      requireSchoolAccess: jest.fn(() => null),
      requireClassSchoolAccess: jest.fn(() => null),
      // u3f-core M9: the class actions now decide the school denial by reason, so the leaked
      // school-context mock must expose it too (null = access granted, matching these tests).
      schoolAccessDenialReason: jest.fn(() => null),
    }));
    jest.doMock("@/lib/store", () => ({
      getClassById: jest.fn(async () => ({ id: "class-uuid", slug: "class-slug", schoolId: "foundation", professorId: "prof-1", name: "Class", status: "active", enrollmentOpen: true, createdAt: "Tue Apr 14 2026 06:25:09 GMT+0000 (Coordinated Universal Time)" })),
      createClassEvaluation: jest.fn(),
      listClassEvaluations: jest.fn(async () => [{ id: "eval-1", classId: "class-uuid", title: "Eval", prompt: "Answer this", status: "active", kind: "automatic", createdAt: "Tue Apr 14 2026 06:25:09 GMT+0000 (Coordinated Universal Time)" }]),
    }));

    const { GET } = await import("@/app/api/v1/classes/[id]/evaluations/route");
    const res = await GET(new Request("https://safe.test"), { params: Promise.resolve({ id: "class-slug" }) });
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.data[0].created_at).toBe("2026-04-14T06:25:09.000Z");
  });

  it("classes list exposes snake_case aliases while preserving legacy camelCase", async () => {
    jest.doMock("next/headers", () => ({ headers: jest.fn(async () => new Headers({ "x-school-id": "foundation" })) }));
    jest.doMock("@/lib/auth-professor", () => ({ getProfessorFromRequest: jest.fn(async () => null) }));
    jest.doMock("@/lib/auth", () => ({
      getAgentFromRequest: jest.fn(async () => agent()),
      optionalAgent: jest.fn(async () => ({ agent: agent(), denial: null })),
      platformAccessDenial: jest.fn(() => null),
      requireAgent: jest.fn(async () => {
        const resolved = await (async () => agent())();
        return resolved
          ? { ok: true, agent: resolved }
          : { ok: false, response: Response.json({ success: false, error: "Unauthorized" }, { status: 401 }) };
      }),
      jsonResponse: (body: unknown, status = 200, headers: Record<string, string> = {}) => Response.json(body, { status, headers }),
      errorResponse: (error: string, hint?: string, status = 400) => Response.json({ success: false, error, hint }, { status }),
    }));
    // M11-1 C20 round 2: class routes key their access check on the *class's* school, not
    // the request host, so the resource-scoped helper has to be mocked too.
    jest.doMock("@/lib/school-context", () => ({
      requireSchoolAccess: jest.fn(() => null),
      requireClassSchoolAccess: jest.fn(() => null),
      // u3f-core M9: the class actions now decide the school denial by reason, so the leaked
      // school-context mock must expose it too (null = access granted, matching these tests).
      schoolAccessDenialReason: jest.fn(() => null),
    }));
    jest.doMock("@/lib/store", () => ({
      listClasses: jest.fn(async () => [{ id: "class-uuid", slug: "class-slug", name: "Class", description: "Desc", status: "active", enrollmentOpen: true, maxStudents: 10, syllabus: {}, createdAt: "Tue Apr 14 2026 06:25:09 GMT+0000 (Coordinated Universal Time)" }]),
      getClassEnrollmentCount: jest.fn(async () => 3),
      getClassAssistants: jest.fn(async () => []),
      createClass: jest.fn(),
    }));

    const { GET } = await import("@/app/api/v1/classes/route");
    const res = await GET(new Request("https://safe.test/api/v1/classes", { headers: { Authorization: "Bearer key" } }));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.data[0]).toMatchObject({
      enrollment_open: true,
      max_students: 10,
      created_at: "2026-04-14T06:25:09.000Z",
      enrollmentOpen: true,
      maxStudents: 10,
      createdAt: "2026-04-14T06:25:09.000Z",
    });
  });

  it("submits a class evaluation by class slug and returns synchronous result hints", async () => {
    jest.doMock("@/lib/auth", () => ({
      getAgentFromRequest: jest.fn(async () => agent()),
      optionalAgent: jest.fn(async () => ({ agent: agent(), denial: null })),
      platformAccessDenial: jest.fn(() => null),
      requireAgent: jest.fn(async () => {
        const resolved = await (async () => agent())();
        return resolved
          ? { ok: true, agent: resolved }
          : { ok: false, response: Response.json({ success: false, error: "Unauthorized" }, { status: 401 }) };
      }),
      jsonResponse: (body: unknown, status = 200) => Response.json(body, { status }),
      errorResponse: (error: string, hint?: string, status = 400, options: { code?: string } = {}) =>
        Response.json({ success: false, error, hint, error_detail: { code: options.code ?? "bad_request", message: error, hint }, request_id: "req-test" }, { status }),
    }));
    const saveClassEvaluationResult = jest.fn(async () => ({
      id: "result-1",
      evaluationId: "eval-1",
      agentId: "agent-1",
      response: "My answer",
      score: 10,
      maxScore: 10,
      feedback: "Accepted",
      resultData: { ok: true },
      completedAt: "2026-01-01T00:00:00.000Z",
    }));
    jest.doMock("@/lib/store", () => ({
      getClassById: jest.fn(async () => ({ id: "class-uuid", slug: "class-slug", schoolId: "foundation", professorId: "prof-1", name: "Class", status: "active", enrollmentOpen: true, createdAt: "2026-01-01T00:00:00.000Z" })),
      getClassEvaluation: jest.fn(async () => ({ id: "eval-1", classId: "class-uuid", title: "Eval", prompt: "Answer this", status: "active", kind: "self_serve", maxScore: 10, createdAt: "2026-01-01T00:00:00.000Z" })),
      getClassEnrollment: jest.fn(async () => ({ classId: "class-uuid", agentId: "agent-1", status: "active" })),
      saveClassEvaluationResult,
    }));

    const { POST } = await import("@/app/api/v1/classes/[id]/evaluations/[evalId]/submit/route");
    const res = await POST(new Request("https://safe.test", { method: "POST", body: JSON.stringify({ response: "My answer" }) }), { params: Promise.resolve({ id: "class-slug", evalId: "eval-1" }) });
    const body = await res.json();

    expect(res.status).toBe(201);
    // Re-anchored for u3f: the store call now carries the prepared class.evaluation_submitted
    // event, with the result id and subject store-assigned (the Decision-2 shape).
    expect(saveClassEvaluationResult).toHaveBeenCalledWith(
      "eval-1", "agent-1", "My answer", undefined, 10, undefined, undefined,
      [
        expect.objectContaining({
          kind: "class.evaluation_submitted",
          actorAgentId: "agent-1",
          subjectType: "class_evaluation_result",
          schoolId: "foundation",
          payload: expect.objectContaining({ class_id: "class-uuid", evaluation_id: "eval-1" }),
        }),
      ]
    );
    expect(body.data).toMatchObject({
      evaluation_id: "eval-1",
      agent_id: "agent-1",
      grading_mode: "sync",
      result_state: "completed",
      kind: "self_serve",
    });
    expect(body.meta).toMatchObject({ class_id: "class-uuid", evaluation_id: "eval-1", synchronous: true });
  });

  it("rejects invalid evaluation kind updates with a stable error code", async () => {
    jest.doMock("@/lib/auth-professor", () => ({ getProfessorFromRequest: jest.fn(async () => ({ id: "prof-1" })) }));
    jest.doMock("@/lib/auth", () => ({
      jsonResponse: (body: unknown, status = 200) => Response.json(body, { status }),
      errorResponse: (error: string, hint?: string, status = 400, options: { code?: string } = {}) =>
        Response.json({ success: false, error, hint, error_detail: { code: options.code ?? "bad_request", message: error, hint }, request_id: "req-test" }, { status }),
    }));
    const updateClassEvaluation = jest.fn();
    jest.doMock("@/lib/store", () => ({
      getClassById: jest.fn(async () => ({ id: "class-uuid", slug: "class-slug", schoolId: "foundation", professorId: "prof-1", name: "Class", status: "active", enrollmentOpen: true, createdAt: "2026-01-01T00:00:00.000Z" })),
      getClassEvaluation: jest.fn(async () => ({ id: "eval-1", classId: "class-uuid", title: "Eval", prompt: "Answer this", status: "active", kind: "automatic", maxScore: 10, createdAt: "2026-01-01T00:00:00.000Z" })),
      updateClassEvaluation,
    }));

    const { PATCH } = await import("@/app/api/v1/classes/[id]/evaluations/[evalId]/route");
    const res = await PATCH(new Request("https://safe.test", { method: "PATCH", body: JSON.stringify({ kind: "process" }) }), { params: Promise.resolve({ id: "class-slug", evalId: "eval-1" }) });
    const body = await res.json();

    expect(res.status).toBe(400);
    expect(body.error_detail.code).toBe("invalid_evaluation_kind");
    expect(updateClassEvaluation).not.toHaveBeenCalled();
  });
});

describe("UX6 vetting identity sync", () => {
  beforeEach(() => jest.resetModules());

  function mockVettingComplete(
    syncImpl: jest.Mock,
    getFreshAgent: () => Promise<StoredAgent> = async () => agent(),
    completeImpl: (_agentId: string, _challengeId: string, _identityMd: string) => Promise<{ outcome: "completed"; bootstrap: never[] }> = async () => ({ outcome: "completed", bootstrap: [] })
  ) {
    jest.doMock("@/lib/auth", () => ({
      getAgentFromRequest: jest.fn(async () => agent()),
      optionalAgent: jest.fn(async () => ({ agent: agent(), denial: null })),
      platformAccessDenial: jest.fn(() => null),
      requireAgent: jest.fn(async () => {
        const resolved = await (async () => agent())();
        return resolved
          ? { ok: true, agent: resolved }
          : { ok: false, response: Response.json({ success: false, error: "Unauthorized" }, { status: 401 }) };
      }),
      checkRateLimitAndRespond: jest.fn(() => null),
      jsonResponse: (body: unknown, status = 200) => Response.json(body, { status }),
      errorResponse: (error: string, hint?: string, status = 400, options: { code?: string } = {}) =>
        Response.json({ success: false, error, hint, error_detail: { code: options.code ?? "bad_request", message: error, hint }, request_id: "req-test" }, { status }),
    }));
    jest.doMock("@/lib/vetting", () => ({
      isChallengeExpired: jest.fn(() => false),
      validateHash: jest.fn(() => true),
    }));
    jest.doMock("@/lib/memory/memory-service", () => ({ putContextAndMaybeIndex: syncImpl }));
    // M11-1 C14: the route's store surface is the atomic completeVetting plus reads. **M11-2 P1.4
    // moved the call one layer down** — the route now invokes `actions/agents.completeVetting`,
    // which builds the event set and forwards to this same store export, so the mock additionally
    // has to answer the constant that action reads to name the bootstrap evaluations.
    jest.doMock("@/lib/store", () => ({
      VETTING_BOOTSTRAP_EVALUATIONS: ["poaw", "identity-check"],
      getVettingChallenge: jest.fn(async () => ({ id: "challenge-1", agentId: "agent-1", expectedHash: "ok", expiresAt: "2999-01-01T00:00:00.000Z", consumed: false })),
      getAgentById: jest.fn(getFreshAgent),
      completeVetting: jest.fn(completeImpl),
      ensureGeneralGroup: jest.fn(async () => undefined),
    }));
  }

  it("writes vetted identity through IDENTITY.md context sync", async () => {
    const sync = jest.fn(async () => ({ path: "IDENTITY.md" }));
    mockVettingComplete(sync);

    const { POST } = await import("@/app/api/v1/agents/vetting/complete/route");
    const res = await POST(new Request("https://safe.test", { method: "POST", body: JSON.stringify({ challenge_id: "challenge-1", hash: "ok", identity_md: "# Identity\n" }) }) as never);
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.success).toBe(true);
    expect(sync).toHaveBeenCalledWith("agent-1", "IDENTITY.md", "# Identity\n", { sessionUserId: null });
  });

  it("keeps vetting successful when IDENTITY.md context sync fails", async () => {
    const sync = jest.fn(async () => ({ error: "context unavailable" }));
    mockVettingComplete(sync);

    const { POST } = await import("@/app/api/v1/agents/vetting/complete/route");
    const res = await POST(new Request("https://safe.test", { method: "POST", body: JSON.stringify({ challenge_id: "challenge-1", hash: "ok", identity_md: "# Identity\n" }) }) as never);
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.success).toBe(true);
    expect(sync).toHaveBeenCalled();
  });

  it("syncs and reports the identity that won between two valid completions", async () => {
    let storedIdentity = "";
    let completions = 0;
    const sync = jest.fn(async () => ({ path: "IDENTITY.md" }));
    mockVettingComplete(
      sync,
      async () => agent({ identityMd: storedIdentity }),
      async (_agentId: string, _challengeId: string, identityMd: string) => {
        if (completions++ === 0) storedIdentity = identityMd;
        return { outcome: "completed", bootstrap: [] };
      }
    );

    const { POST } = await import("@/app/api/v1/agents/vetting/complete/route");
    const request = (identity_md: string) => new Request("https://safe.test", {
      method: "POST", body: JSON.stringify({ challenge_id: "challenge-1", hash: "ok", identity_md }),
    });
    await POST(request("winner") as never);
    const second = await POST(request("loser") as never);
    const body = await second.json();

    expect(body.identity_received).toBe(true);
    expect(sync).toHaveBeenLastCalledWith("agent-1", "IDENTITY.md", "winner", { sessionUserId: null });
  });
});

describe("UX6 vector cleanup", () => {
  beforeEach(() => jest.resetModules());

  it("deletes only vectors matched by post_id metadata for the post audience", async () => {
    jest.doMock("@vercel/functions", () => ({ waitUntil: jest.fn() }));
    jest.doMock("@/lib/test-content", () => ({ isTestContent: jest.fn(() => false) }));
    jest.doMock("@/lib/memory/chunk-text", () => ({ chunkTextForMemory: jest.fn((text: string) => [text]) }));
    jest.doMock("@/lib/store", () => ({
      getGroup: jest.fn(async () => ({ id: "group-1", memberIds: ["agent-2", "agent-3"] })),
      listFollowerIdsForFollowee: jest.fn(async () => ["agent-4"]),
    }));
    const listVectorIdsForAgentByMetadata = jest.fn(async (agentId: string, metadata: Record<string, unknown>) => {
      expect(metadata).toEqual({ post_id: "post-1" });
      return agentId === "agent-3" ? [] : [`${agentId}-match-1`, `${agentId}-match-2`];
    });
    const deleteVectorsForAgent = jest.fn(async () => undefined);
    jest.doMock("@/lib/memory/memory-service", () => ({
      pruneIngestedVectorsForAgent: jest.fn(),
      upsertVectorChunkBatchForAgent: jest.fn(),
      deleteVectorsForAgent,
      listVectorIdsForAgentByMetadata,
    }));

    // The audience derivation and the cleanup are separate calls since M11-2 u3: a deletion spends
    // the recipients its own statement pinned, so nothing in the cleanup path recomputes them.
    const { cleanupPostVectorsForRecipients, collectAgentIdsForPostAudience } = await import(
      "@/lib/memory/platform-ingest"
    );
    const post = {
      id: "post-1",
      title: "Post",
      authorId: "agent-1",
      groupId: "group-1",
      upvotes: 0,
      downvotes: 0,
      commentCount: 0,
      createdAt: "2026-01-01T00:00:00.000Z",
    } as never;
    await cleanupPostVectorsForRecipients("post-1", await collectAgentIdsForPostAudience(post));

    expect(listVectorIdsForAgentByMetadata).toHaveBeenCalledTimes(4);
    expect(deleteVectorsForAgent).toHaveBeenCalledWith("agent-1", ["agent-1-match-1", "agent-1-match-2"]);
    expect(deleteVectorsForAgent).toHaveBeenCalledWith("agent-2", ["agent-2-match-1", "agent-2-match-2"]);
    expect(deleteVectorsForAgent).toHaveBeenCalledWith("agent-4", ["agent-4-match-1", "agent-4-match-2"]);
    expect(deleteVectorsForAgent).not.toHaveBeenCalledWith("agent-3", expect.anything());
  });
});

describe("UX6 vector route envelopes", () => {
  beforeEach(() => jest.resetModules());

  it("returns canonical query data/meta and denies cross-agent bearer access", async () => {
    jest.doMock("@/auth", () => ({ auth: jest.fn(async () => null) }));
    jest.doMock("@/lib/auth", () => ({
      getAgentFromRequest: jest.fn(async () => agent()),
      optionalAgent: jest.fn(async () => ({ agent: agent(), denial: null })),
      platformAccessDenial: jest.fn(() => null),
      requireAgent: jest.fn(async () => {
        const resolved = await (async () => agent())();
        return resolved
          ? { ok: true, agent: resolved }
          : { ok: false, response: Response.json({ success: false, error: "Unauthorized" }, { status: 401 }) };
      }),
      jsonResponse: (body: unknown, status = 200) => Response.json(body, { status }),
      errorResponse: (error: string, hint?: string, status = 400, options: { code?: string } = {}) =>
        Response.json({ success: false, error, hint, error_detail: { code: options.code ?? "bad_request", message: error, hint }, request_id: "req-test" }, { status }),
    }));
    jest.doMock("@/lib/human-users", () => ({ listAgentsForUser: jest.fn(async () => []), userOwnsAgent: jest.fn(async () => false) }));
    const queryVectorsForAgent = jest.fn(async () => [{ id: "vec-1", text: "Memory", score: 0.9, metadata: { kind: "note" } }]);
    jest.doMock("@/lib/memory/memory-service", () => ({ queryVectorsForAgent }));

    const { POST } = await import("@/app/api/v1/memory/vector/query/route");
    const ok = await POST(new Request("https://safe.test", { method: "POST", body: JSON.stringify({ query: "memory" }) }));
    const okBody = await ok.json();
    expect(ok.status).toBe(200);
    expect(okBody.data.results).toEqual([{ id: "vec-1", text: "Memory", score: 0.9, metadata: { kind: "note" } }]);
    expect(okBody.meta).toMatchObject({ agent_id: "agent-1", mode: "query" });
    expect(okBody.meta.score_semantics).toContain("semantically similar");

    const denied = await POST(new Request("https://safe.test", { method: "POST", body: JSON.stringify({ agent_id: "agent-2", query: "memory" }) }));
    expect(denied.status).toBe(403);
  });

  it("returns stable agent_id_required when no bearer or single dashboard agent is available", async () => {
    jest.doMock("@/auth", () => ({ auth: jest.fn(async () => ({ user: { id: "user-1" } })) }));
    jest.doMock("@/lib/auth", () => ({
      getAgentFromRequest: jest.fn(async () => null),
      optionalAgent: jest.fn(async () => ({ agent: null, denial: null })),
      platformAccessDenial: jest.fn(() => null),
      requireAgent: jest.fn(async () => {
        const resolved = await (async () => null)();
        return resolved
          ? { ok: true, agent: resolved }
          : { ok: false, response: Response.json({ success: false, error: "Unauthorized" }, { status: 401 }) };
      }),
      jsonResponse: (body: unknown, status = 200) => Response.json(body, { status }),
      errorResponse: (error: string, hint?: string, status = 400, options: { code?: string } = {}) =>
        Response.json({ success: false, error, hint, error_detail: { code: options.code ?? "bad_request", message: error, hint }, request_id: "req-test" }, { status }),
    }));
    jest.doMock("@/lib/human-users", () => ({ listAgentsForUser: jest.fn(async () => []), userOwnsAgent: jest.fn(async () => false) }));
    jest.doMock("@/lib/memory/context-store", () => ({ listContextPaths: jest.fn() }));

    const { GET } = await import("@/app/api/v1/memory/context/list/route");
    const res = await GET(new Request("https://safe.test/api/v1/memory/context/list"));
    const body = await res.json();

    expect(res.status).toBe(400);
    expect(body.error_detail.code).toBe("agent_id_required");
  });
});
