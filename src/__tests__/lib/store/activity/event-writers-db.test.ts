jest.mock("@/lib/db", () => ({
  hasDatabase: () => true,
  sql: jest.fn((query: TemplateStringsArray | string) => {
    const calls = ((globalThis as typeof globalThis & { __activityEventWriterSqlCalls?: string[] }).__activityEventWriterSqlCalls ??= []);
    calls.push(typeof query === "string" ? query : query.join("?"));
    return Promise.resolve([]);
  }),
}));

import {
  listActivityEvents,
  recordAgentLoopActivityEvent,
  recordCommentActivityEvent,
  recordEvaluationResultActivityEvent,
  recordPlaygroundActionActivityEvent,
  recordPlaygroundSessionActivityEvent,
  recordPostActivityEvent,
} from "@/lib/store/activity/events";

function mockSql() {
  return jest.requireMock("@/lib/db").sql as jest.Mock;
}

function mockSqlCalls() {
  return (globalThis as typeof globalThis & { __activityEventWriterSqlCalls?: string[] }).__activityEventWriterSqlCalls ??= [];
}

describe("activity event DB writers", () => {
  beforeEach(() => {
    mockSql().mockClear();
    mockSqlCalls().length = 0;
  });

  it("enriches fresh post rows through the same joins as backfill", async () => {
    await recordPostActivityEvent({
      id: "p1",
      authorId: "a1",
      groupId: "g1",
      title: "Hello",
      createdAt: "2026-01-01T00:00:00.000Z",
    });

    expect(mockSqlCalls()[0]).toContain("LEFT JOIN agents");
    expect(mockSqlCalls()[0]).toContain("LEFT JOIN groups");
    expect(mockSqlCalls()[0]).toContain("ON CONFLICT (kind, entity_id) DO UPDATE");
  });

  it("uses idempotent enriched SQL for every fresh activity kind", async () => {
    await recordCommentActivityEvent({
      id: "c1",
      postId: "p1",
      authorId: "a1",
      content: "Nice",
      createdAt: "2026-01-01T00:00:00.000Z",
    });
    await recordEvaluationResultActivityEvent({
      resultId: "r1",
      agentId: "a1",
      evaluationId: "eval",
      completedAt: "2026-01-01T00:00:00.000Z",
      passed: true,
    });
    await recordPlaygroundSessionActivityEvent("s1");
    await recordPlaygroundActionActivityEvent("pa1");
    await recordAgentLoopActivityEvent("log1");

    expect(mockSql()).toHaveBeenCalledTimes(5);
    expect(mockSqlCalls().every((query) => query.includes("ON CONFLICT (kind, entity_id) DO UPDATE"))).toBe(true);
    expect(mockSqlCalls().join("\n")).toContain("LEFT JOIN agents");
    expect(mockSqlCalls().join("\n")).toContain("JOIN posts");
    expect(mockSqlCalls().join("\n")).toContain("FROM playground_sessions");
    expect(mockSqlCalls().join("\n")).toContain("FROM playground_actions");
    expect(mockSqlCalls().join("\n")).toContain("FROM agent_loop_action_log");
  });

  it("logs and swallows projection write failures", async () => {
    const errorSpy = jest.spyOn(console, "error").mockImplementation(() => undefined);
    mockSql().mockRejectedValueOnce(new Error("boom"));

    await expect(recordPostActivityEvent({
      id: "p1",
      authorId: "a1",
      groupId: "g1",
      title: "Hello",
      createdAt: "2026-01-01T00:00:00.000Z",
    })).resolves.toBeUndefined();

    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("post activity event"), expect.any(Error));
    errorSpy.mockRestore();
  });

  it("reads the event projection with indexed kind and tsvector predicates", async () => {
    await listActivityEvents({
      types: ["post"],
      query: "uniqueWord",
      before: "2026-01-01T00:00:00.000Z",
      beforeId: "00000000-0000-4000-8000-000000000001",
      limit: 10,
    });

    expect(mockSql()).toHaveBeenCalledTimes(1);
    expect(mockSqlCalls()[0]).toContain("FROM activity_events");
    expect(mockSqlCalls()[0]).toContain("WITH matched AS MATERIALIZED");
    expect(mockSqlCalls()[0]).toContain("kind = ANY");
    expect(mockSqlCalls()[0]).toContain("to_tsvector('simple', search_text) @@ plainto_tsquery('simple'");
    expect(mockSqlCalls()[0]).toContain("ORDER BY occurred_at DESC, id DESC");
    expect(mockSqlCalls()[0]).not.toContain("LOWER(search_text) LIKE");
  });

  it("does not scan events when filters only request non-event activity kinds", async () => {
    await expect(listActivityEvents({ types: ["class"], limit: 10 })).resolves.toEqual([]);

    expect(mockSql()).not.toHaveBeenCalled();
  });
});
