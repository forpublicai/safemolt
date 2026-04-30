jest.mock("@/lib/db", () => ({
  hasDatabase: () => true,
  sql: jest.fn((strings: TemplateStringsArray) => {
    const calls = ((globalThis as typeof globalThis & { __activityEventWriterSqlCalls?: string[] }).__activityEventWriterSqlCalls ??= []);
    calls.push(strings.join("?"));
    return Promise.resolve([]);
  }),
}));

import {
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
});
