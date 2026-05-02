/**
 * @jest-environment node
 */
jest.mock("@/lib/db", () => ({
  hasDatabase: () => true,
  sql: jest.fn((strings: TemplateStringsArray, ...params: unknown[]) => {
    const calls = ((globalThis as typeof globalThis & { __activityBackfillSqlCalls?: string[] }).__activityBackfillSqlCalls ??= []);
    const paramCalls = ((globalThis as typeof globalThis & { __activityBackfillSqlParams?: unknown[][] }).__activityBackfillSqlParams ??= []);
    calls.push(strings.join("?"));
    paramCalls.push(params);
    return Promise.resolve([{}]);
  }),
}));

import { GET, POST } from "@/app/api/v1/internal/activity-events-backfill/route";

function mockSql() {
  return jest.requireMock("@/lib/db").sql as jest.Mock;
}

function mockSqlCalls() {
  return (globalThis as typeof globalThis & { __activityBackfillSqlCalls?: string[] }).__activityBackfillSqlCalls ??= [];
}

function mockSqlParams() {
  return (globalThis as typeof globalThis & { __activityBackfillSqlParams?: unknown[][] }).__activityBackfillSqlParams ??= [];
}

describe("activity events backfill route", () => {
  const previousSecret = process.env.CRON_SECRET;
  let infoSpy: jest.SpyInstance;

  beforeEach(() => {
    mockSql().mockClear();
    mockSqlCalls().length = 0;
    mockSqlParams().length = 0;
    process.env.CRON_SECRET = "test-secret";
    infoSpy = jest.spyOn(console, "info").mockImplementation(() => undefined);
  });

  afterEach(() => {
    infoSpy.mockRestore();
    if (previousSecret === undefined) delete process.env.CRON_SECRET;
    else process.env.CRON_SECRET = previousSecret;
  });

  it("fails closed when CRON_SECRET is missing", async () => {
    delete process.env.CRON_SECRET;

    const response = await POST(new Request("http://localhost/api/v1/internal/activity-events-backfill", { method: "POST" }));

    expect(response.status).toBe(401);
    expect(mockSql()).not.toHaveBeenCalled();
  });

  it("fails closed for scheduled GET when the auth header is missing", async () => {
    const response = await GET(new Request("http://localhost/api/v1/internal/activity-events-backfill", { method: "GET" }));

    expect(response.status).toBe(401);
    expect(mockSql()).not.toHaveBeenCalled();
  });

  it("runs additive backfill from the Vercel cron GET contract", async () => {
    const response = await GET(new Request("http://localhost/api/v1/internal/activity-events-backfill", {
      method: "GET",
      headers: { authorization: "Bearer test-secret" },
    }));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ success: true, done: true, force: false, rows: 6 });
    expect(mockSql()).toHaveBeenCalledTimes(6);
  });

  it("backfills each source without rewriting existing audit rows by default", async () => {
    const response = await POST(new Request("http://localhost/api/v1/internal/activity-events-backfill", {
      method: "POST",
      headers: { authorization: "Bearer test-secret" },
    }));

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toMatchObject({
      success: true,
      done: true,
      force: false,
      rows: 6,
      counts: {
        post: 1,
        comment: 1,
        evaluation_result: 1,
        playground_session: 1,
        playground_action: 1,
        agent_loop: 1,
      },
    });
    expect(body.timings).toEqual({
      post: expect.any(Number),
      comment: expect.any(Number),
      evaluation_result: expect.any(Number),
      playground_session: expect.any(Number),
      playground_action: expect.any(Number),
      agent_loop: expect.any(Number),
    });
    expect(mockSql()).toHaveBeenCalledTimes(6);
    expect(response.headers.get("Server-Timing")).toContain("backfill_post;dur=");
    expect(mockSqlCalls().every((query) => query.includes("ON CONFLICT (kind, entity_id) DO UPDATE"))).toBe(true);
    expect(mockSqlCalls().every((query) => query.includes("WHERE ?"))).toBe(true);
    expect(mockSqlCalls()[0]).toContain("'group_id', p.group_id");
    expect(mockSqlParams().every((params) => params.includes(false))).toBe(true);
  });

  it("allows explicit forced re-derivation", async () => {
    const response = await POST(new Request("http://localhost/api/v1/internal/activity-events-backfill?force=true", {
      method: "POST",
      headers: { authorization: "Bearer test-secret" },
    }));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ success: true, done: true, force: true, rows: 6 });
    expect(mockSql()).toHaveBeenCalledTimes(6);
    expect(mockSqlParams().every((params) => params.includes(true))).toBe(true);
  });
});
