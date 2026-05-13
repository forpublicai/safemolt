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
    const putContextFile = jest.fn(async () => undefined);
    jest.doMock("@/auth", () => ({ auth: jest.fn(async () => null) }));
    jest.doMock("@/lib/auth", () => ({
      getAgentFromRequest: jest.fn(async () => agent({ identityMd: "# Agent\n" })),
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
      putContextAndMaybeIndex: jest.fn(),
      deleteContextAndIndex: jest.fn(),
    }));
    jest.doMock("@/lib/store", () => ({ getAgentById: jest.fn(async () => agent({ identityMd: "# Agent\n" })) }));

    const { GET } = await import("@/app/api/v1/memory/context/file/route");
    const res = await GET(new Request("https://safe.test/api/v1/memory/context/file?path=IDENTITY.md"));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.data).toMatchObject({ path: "IDENTITY.md", content: "# Agent\n", source: "agent_identity_cache" });
    expect(body.meta.agent_id).toBe("agent-1");
    expect(putContextFile).toHaveBeenCalledWith("agent-1", "IDENTITY.md", "# Agent\n");
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
      jsonResponse: (body: unknown, status = 200) => Response.json(body, { status }),
      errorResponse: (error: string, hint?: string, status = 400, options: { code?: string } = {}) =>
        Response.json({ success: false, error, hint, error_detail: { code: options.code ?? "bad_request", message: error, hint }, request_id: "req-test" }, { status }),
    }));
    jest.doMock("@/lib/school-context", () => ({ requireSchoolAccess: jest.fn(() => null) }));
    jest.doMock("@/lib/store", () => ({
      getClassById: jest.fn(async () => ({ id: "class-uuid", slug: "class-slug", professorId: "prof-1", name: "Class", status: "active", enrollmentOpen: true, createdAt: "2026-01-01T00:00:00.000Z" })),
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

  it("submits a class evaluation by class slug and returns synchronous result hints", async () => {
    jest.doMock("@/lib/auth", () => ({
      getAgentFromRequest: jest.fn(async () => agent()),
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
      getClassById: jest.fn(async () => ({ id: "class-uuid", slug: "class-slug", professorId: "prof-1", name: "Class", status: "active", enrollmentOpen: true, createdAt: "2026-01-01T00:00:00.000Z" })),
      getClassEvaluation: jest.fn(async () => ({ id: "eval-1", classId: "class-uuid", title: "Eval", prompt: "Answer this", status: "active", kind: "self_serve", maxScore: 10, createdAt: "2026-01-01T00:00:00.000Z" })),
      getClassEnrollment: jest.fn(async () => ({ classId: "class-uuid", agentId: "agent-1", status: "active" })),
      saveClassEvaluationResult,
    }));

    const { POST } = await import("@/app/api/v1/classes/[id]/evaluations/[evalId]/submit/route");
    const res = await POST(new Request("https://safe.test", { method: "POST", body: JSON.stringify({ response: "My answer" }) }), { params: Promise.resolve({ id: "class-slug", evalId: "eval-1" }) });
    const body = await res.json();

    expect(res.status).toBe(201);
    expect(saveClassEvaluationResult).toHaveBeenCalledWith("eval-1", "agent-1", "My answer", undefined, 10);
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
      getClassById: jest.fn(async () => ({ id: "class-uuid", slug: "class-slug", professorId: "prof-1", name: "Class", status: "active", enrollmentOpen: true, createdAt: "2026-01-01T00:00:00.000Z" })),
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

  function mockVettingComplete(syncImpl: jest.Mock) {
    jest.doMock("@/lib/auth", () => ({
      getAgentFromRequest: jest.fn(async () => agent()),
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
    jest.doMock("@/lib/store", () => ({
      getVettingChallenge: jest.fn(async () => ({ id: "challenge-1", agentId: "agent-1", expectedHash: "ok", expiresAt: "2999-01-01T00:00:00.000Z", consumed: false })),
      consumeVettingChallenge: jest.fn(async () => undefined),
      setAgentVetted: jest.fn(async () => undefined),
      getEvaluationRegistration: jest.fn(async () => null),
      registerForEvaluation: jest.fn(async (_agentId: string, evaluationId: string) => ({ id: `reg-${evaluationId}`, status: "registered", registeredAt: "2026-01-01T00:00:00.000Z" })),
      saveEvaluationResult: jest.fn(async () => undefined),
      hasPassedEvaluation: jest.fn(async () => true),
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

    const { cleanupPostVectorsForAudience } = await import("@/lib/memory/platform-ingest");
    await cleanupPostVectorsForAudience({
      id: "post-1",
      title: "Post",
      authorId: "agent-1",
      groupId: "group-1",
      upvotes: 0,
      downvotes: 0,
      commentCount: 0,
      createdAt: "2026-01-01T00:00:00.000Z",
    } as never);

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
