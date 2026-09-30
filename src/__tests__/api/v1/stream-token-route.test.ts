/**
 * @jest-environment node
 *
 * P5.2 — POST /api/v1/agents/me/stream-token. Mirrors the webhook route test pattern: mock
 * `requireAgent` for auth outcomes, exercise the real route + real `mintStreamToken` for the rest.
 */
jest.mock("@/lib/auth", () => {
  const actual = jest.requireActual("@/lib/auth");
  return { ...actual, requireAgent: jest.fn() };
});

import { NextRequest } from "next/server";
import { POST } from "@/app/api/v1/agents/me/stream-token/route";
import { requireAgent } from "@/lib/auth";
import type { StoredAgent } from "@/lib/store-types";

const mockedRequireAgent = jest.mocked(requireAgent);
const AGENT = { id: "agent_1", name: "agent_1" } as unknown as StoredAgent;

const TOUCHED = ["STREAM_ENABLED", "STREAM_TOKEN_SECRET", "NEXT_PUBLIC_STREAM_URL"] as const;
const SAVED_ENV: Record<string, string | undefined> = {};

beforeAll(() => {
  for (const key of TOUCHED) SAVED_ENV[key] = process.env[key];
});

afterEach(() => {
  jest.clearAllMocks();
  for (const key of TOUCHED) {
    if (SAVED_ENV[key] === undefined) delete process.env[key];
    else process.env[key] = SAVED_ENV[key];
  }
});

function authOk(): void {
  mockedRequireAgent.mockResolvedValue({ ok: true, agent: AGENT });
}

function authDenied(): void {
  mockedRequireAgent.mockResolvedValue({
    ok: false,
    reason: "unauthenticated",
    response: Response.json({ success: false, error: "Unauthorized" }, { status: 401 }),
  } as Awaited<ReturnType<typeof requireAgent>>);
}

function makeRequest(): NextRequest {
  return new NextRequest("http://localhost/api/v1/agents/me/stream-token", {
    method: "POST",
    headers: { authorization: "Bearer k" },
  });
}

describe("POST /api/v1/agents/me/stream-token", () => {
  it("401s when unauthenticated, and never mints a token", async () => {
    authDenied();
    delete process.env.STREAM_ENABLED;

    const response = await POST(makeRequest());
    expect(response.status).toBe(401);
  });

  it("503s with code stream_not_enabled when STREAM_ENABLED is unset", async () => {
    authOk();
    delete process.env.STREAM_ENABLED;

    const response = await POST(makeRequest());
    const body = await response.json();

    expect(response.status).toBe(503);
    expect(body.error_detail.code).toBe("stream_not_enabled");
  });

  it("503s with code stream_not_enabled when STREAM_ENABLED is 'false'", async () => {
    authOk();
    process.env.STREAM_ENABLED = "false";

    const response = await POST(makeRequest());
    const body = await response.json();

    expect(response.status).toBe(503);
    expect(body.error_detail.code).toBe("stream_not_enabled");
  });

  it("200s with a token and 600s TTL when enabled, no meta when NEXT_PUBLIC_STREAM_URL is unset", async () => {
    authOk();
    process.env.STREAM_ENABLED = "true";
    process.env.STREAM_TOKEN_SECRET = "s3cret";
    delete process.env.NEXT_PUBLIC_STREAM_URL;

    const response = await POST(makeRequest());
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.success).toBe(true);
    expect(typeof body.data.token).toBe("string");
    expect(body.data.expires_in_seconds).toBe(600);
    expect(body.meta).toBeUndefined();
  });

  it("includes meta.stream_url when NEXT_PUBLIC_STREAM_URL is set", async () => {
    authOk();
    process.env.STREAM_ENABLED = "true";
    process.env.STREAM_TOKEN_SECRET = "s3cret";
    process.env.NEXT_PUBLIC_STREAM_URL = "https://stream.example.com";

    const response = await POST(makeRequest());
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.meta).toEqual({ stream_url: "https://stream.example.com" });
  });
});
