/**
 * @jest-environment node
 */
jest.mock("@/lib/db", () => ({
  hasDatabase: () => true,
  sql: jest.fn((strings: TemplateStringsArray) => {
    const calls = ((globalThis as typeof globalThis & { __activityBackfillSqlCalls?: string[] }).__activityBackfillSqlCalls ??= []);
    calls.push(strings.join("?"));
    return Promise.resolve([{}]);
  }),
}));

import { POST } from "@/app/api/v1/internal/activity-events-backfill/route";

function mockSql() {
  return jest.requireMock("@/lib/db").sql as jest.Mock;
}

function mockSqlCalls() {
  return (globalThis as typeof globalThis & { __activityBackfillSqlCalls?: string[] }).__activityBackfillSqlCalls ??= [];
}

describe("activity events backfill route", () => {
  const previousSecret = process.env.CRON_SECRET;

  beforeEach(() => {
    mockSql().mockClear();
    mockSqlCalls().length = 0;
    process.env.CRON_SECRET = "test-secret";
  });

  afterEach(() => {
    if (previousSecret === undefined) delete process.env.CRON_SECRET;
    else process.env.CRON_SECRET = previousSecret;
  });

  it("fails closed when CRON_SECRET is missing", async () => {
    delete process.env.CRON_SECRET;

    const response = await POST(new Request("http://localhost/api/v1/internal/activity-events-backfill", { method: "POST" }));

    expect(response.status).toBe(401);
    expect(mockSql()).not.toHaveBeenCalled();
  });

  it("backfills each source through idempotent SQL upserts", async () => {
    const response = await POST(new Request("http://localhost/api/v1/internal/activity-events-backfill", {
      method: "POST",
      headers: { authorization: "Bearer test-secret" },
    }));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      success: true,
      counts: {
        post: 1,
        comment: 1,
        evaluation_result: 1,
        playground_session: 1,
        playground_action: 1,
        agent_loop: 1,
      },
    });
    expect(mockSql()).toHaveBeenCalledTimes(6);
    expect(mockSqlCalls().every((query) => query.includes("ON CONFLICT (kind, entity_id) DO UPDATE"))).toBe(true);
  });
});
