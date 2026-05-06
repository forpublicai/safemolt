/**
 * @jest-environment node
 */

jest.mock("@/lib/playground/lifecycle", () => ({
  runDeadlinesAndCap: jest.fn(),
}));

import { GET } from "@/app/api/v1/internal/playground-deadlines/route";
import { runDeadlinesAndCap } from "@/lib/playground/lifecycle";

const mockedRunDeadlinesAndCap = jest.mocked(runDeadlinesAndCap);
const originalCronSecret = process.env.CRON_SECRET;

describe("GET /api/v1/internal/playground-deadlines", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    delete process.env.CRON_SECRET;
    mockedRunDeadlinesAndCap.mockResolvedValue({
      advanced: 2,
      capped: 1,
      advanceDurationMs: 12.5,
      capDurationMs: 3.25,
    });
  });

  afterAll(() => {
    if (originalCronSecret === undefined) {
      delete process.env.CRON_SECRET;
    } else {
      process.env.CRON_SECRET = originalCronSecret;
    }
  });

  it("runs without auth when CRON_SECRET is unset", async () => {
    const response = await GET(new Request("http://localhost/api/v1/internal/playground-deadlines"));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toMatchObject({ success: true, advanced: 2, capped: 1 });
    expect(response.headers.get("Server-Timing")).toContain("deadlines_advance;dur=12.5");
    expect(response.headers.get("Server-Timing")).toContain("deadlines_cap;dur=3.3");
    expect(mockedRunDeadlinesAndCap).toHaveBeenCalledWith("cron:playground-deadlines");
  });

  it("rejects non-cron requests when CRON_SECRET is set", async () => {
    process.env.CRON_SECRET = "secret";

    const response = await GET(new Request("http://localhost/api/v1/internal/playground-deadlines"));
    const body = await response.json();

    expect(response.status).toBe(401);
    expect(body.success).toBe(false);
    expect(mockedRunDeadlinesAndCap).not.toHaveBeenCalled();
  });

  it("accepts a matching bearer token when CRON_SECRET is set", async () => {
    process.env.CRON_SECRET = "secret";

    const response = await GET(
      new Request("http://localhost/api/v1/internal/playground-deadlines", {
        headers: { authorization: "Bearer secret" },
      })
    );

    expect(response.status).toBe(200);
    expect(mockedRunDeadlinesAndCap).toHaveBeenCalledTimes(1);
  });

  it("accepts Vercel cron requests when CRON_SECRET is set", async () => {
    process.env.CRON_SECRET = "secret";

    const response = await GET(
      new Request("http://localhost/api/v1/internal/playground-deadlines", {
        headers: { "x-vercel-cron": "1" },
      })
    );

    expect(response.status).toBe(200);
    expect(mockedRunDeadlinesAndCap).toHaveBeenCalledTimes(1);
  });

  it("rejects malformed cron headers when CRON_SECRET is set", async () => {
    process.env.CRON_SECRET = "secret";

    const response = await GET(
      new Request("http://localhost/api/v1/internal/playground-deadlines", {
        headers: { "x-vercel-cron": "true" },
      })
    );

    expect(response.status).toBe(401);
    expect(mockedRunDeadlinesAndCap).not.toHaveBeenCalled();
  });
});
