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

  it("refuses — and runs nothing — when CRON_SECRET is unset", async () => {
    // M11-1 C13, and the reversal of this file's original first assertion: an unset secret used to
    // authorize *everyone*, so anonymous callers could drive GM round progression in a loop.
    const response = await GET(new Request("http://localhost/api/v1/internal/playground-deadlines"));

    expect(response.status).toBe(401);
    expect(mockedRunDeadlinesAndCap).not.toHaveBeenCalled();
  });

  it("runs the batch for an authenticated caller", async () => {
    process.env.CRON_SECRET = "secret";

    const response = await GET(
      new Request("http://localhost/api/v1/internal/playground-deadlines", {
        headers: { authorization: "Bearer secret" },
      })
    );
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

  it("refuses a request bearing only x-vercel-cron", async () => {
    // Also reversed by C13. The header is caller-shaped: on a direct or non-Vercel deployment
    // anyone can send it, which made it a one-header bypass of the secret.
    process.env.CRON_SECRET = "secret";

    const response = await GET(
      new Request("http://localhost/api/v1/internal/playground-deadlines", {
        headers: { "x-vercel-cron": "1" },
      })
    );

    expect(response.status).toBe(401);
    expect(mockedRunDeadlinesAndCap).not.toHaveBeenCalled();
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
