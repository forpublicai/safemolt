/**
 * @jest-environment node
 *
 * M11b Lane W (P5.1) — POST/GET/DELETE /api/v1/agents/me/webhook, mocked (no DB). The route is a
 * thin adapter over `@/lib/actions/webhooks`, so the action is mocked directly and this file proves
 * only the adapter's job: input validation before the action is ever called, status-code mapping of
 * each `ActionResult`, and body shape — never the action's own behavior (covered elsewhere).
 */
jest.mock("@/lib/actions/webhooks", () => ({
  registerWebhook: jest.fn(),
  getWebhook: jest.fn(),
  removeWebhook: jest.fn(),
}));

jest.mock("@/lib/auth", () => {
  const actual = jest.requireActual("@/lib/auth");
  return { ...actual, requireAgent: jest.fn() };
});

import { NextRequest } from "next/server";
import { POST, GET, DELETE } from "@/app/api/v1/agents/me/webhook/route";
import { registerWebhook, getWebhook, removeWebhook } from "@/lib/actions/webhooks";
import { requireAgent } from "@/lib/auth";
import type { StoredAgent } from "@/lib/store-types";

const mockedRegister = jest.mocked(registerWebhook);
const mockedGet = jest.mocked(getWebhook);
const mockedRemove = jest.mocked(removeWebhook);
const mockedRequireAgent = jest.mocked(requireAgent);

const AGENT = { id: "agent_1", name: "agent_1" } as unknown as StoredAgent;

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

function makeRequest(method: string, body?: unknown): NextRequest {
  return new NextRequest("http://localhost/api/v1/agents/me/webhook", {
    method,
    headers: { authorization: "Bearer k", "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

beforeEach(() => {
  jest.clearAllMocks();
});

describe("POST /api/v1/agents/me/webhook", () => {
  it("calls registerWebhook with the authenticated agent and the parsed input, returns 200", async () => {
    authOk();
    mockedRegister.mockResolvedValue({
      ok: true,
      data: { url: "https://example.com/hook", mode: "primary", secret: "sek" },
    });

    const response = await POST(makeRequest("POST", { url: "https://example.com/hook", mode: "primary" }));
    const body = await response.json();

    expect(mockedRegister).toHaveBeenCalledWith(AGENT, { url: "https://example.com/hook", mode: "primary" });
    expect(response.status).toBe(200);
    expect(body).toEqual({ success: true, data: { url: "https://example.com/hook", mode: "primary", secret: "sek" } });
  });

  it("defaults mode to 'primary' when omitted", async () => {
    authOk();
    mockedRegister.mockResolvedValue({ ok: true, data: { url: "https://example.com/hook", mode: "primary", secret: "s" } });

    await POST(makeRequest("POST", { url: "https://example.com/hook" }));

    expect(mockedRegister).toHaveBeenCalledWith(AGENT, { url: "https://example.com/hook", mode: "primary" });
  });

  it("400s on a missing url without calling the action", async () => {
    authOk();
    const response = await POST(makeRequest("POST", { mode: "primary" }));

    expect(response.status).toBe(400);
    expect(mockedRegister).not.toHaveBeenCalled();
  });

  it("400s on an invalid mode without calling the action", async () => {
    authOk();
    const response = await POST(makeRequest("POST", { url: "https://example.com/hook", mode: "sideways" }));

    expect(response.status).toBe(400);
    expect(mockedRegister).not.toHaveBeenCalled();
  });

  it("F9: 400s on a JSON `null` body instead of throwing on property access", async () => {
    authOk();
    const response = await POST(makeRequest("POST", null));

    expect(response.status).toBe(400);
    expect(mockedRegister).not.toHaveBeenCalled();
  });

  it("F9: 400s on a JSON array body (not an object)", async () => {
    authOk();
    const response = await POST(makeRequest("POST", ["https://example.com/hook"]));

    expect(response.status).toBe(400);
    expect(mockedRegister).not.toHaveBeenCalled();
  });

  it("maps 'not_found' to 404 (F5: the acting agent was withdrawn during registration)", async () => {
    authOk();
    mockedRegister.mockResolvedValue({ ok: false, code: "not_found", message: "Agent no longer exists" });

    const response = await POST(makeRequest("POST", { url: "https://example.com/hook", mode: "primary" }));

    expect(response.status).toBe(404);
  });

  it("maps 'webhooks_not_enabled' to 503 with the stable code", async () => {
    authOk();
    mockedRegister.mockResolvedValue({
      ok: false,
      code: "webhooks_not_enabled",
      message: "Webhook registration is not yet enabled",
    });

    const response = await POST(makeRequest("POST", { url: "https://example.com/hook", mode: "primary" }));
    const body = await response.json();

    expect(response.status).toBe(503);
    expect(body.error_detail.code).toBe("webhooks_not_enabled");
  });

  it("401s when unauthenticated, and never calls the action", async () => {
    authDenied();
    const response = await POST(makeRequest("POST", { url: "https://example.com/hook", mode: "primary" }));

    expect(response.status).toBe(401);
    expect(mockedRegister).not.toHaveBeenCalled();
  });
});

describe("GET /api/v1/agents/me/webhook", () => {
  it("calls getWebhook and returns 200 with a registered webhook", async () => {
    authOk();
    mockedGet.mockResolvedValue({ ok: true, data: { url: "https://example.com/hook", mode: "primary", disabled: false } });

    const response = await GET(makeRequest("GET"));
    const body = await response.json();

    expect(mockedGet).toHaveBeenCalledWith(AGENT);
    expect(response.status).toBe(200);
    expect(body.data).toEqual({ url: "https://example.com/hook", mode: "primary", disabled: false });
    expect(body.data).not.toHaveProperty("secret");
  });

  it("returns 200 with data:null for an unregistered agent — never 404", async () => {
    authOk();
    mockedGet.mockResolvedValue({ ok: true, data: null });

    const response = await GET(makeRequest("GET"));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.data).toBeNull();
  });

  it("401s when unauthenticated, and never calls the action", async () => {
    authDenied();
    const response = await GET(makeRequest("GET"));

    expect(response.status).toBe(401);
    expect(mockedGet).not.toHaveBeenCalled();
  });
});

describe("DELETE /api/v1/agents/me/webhook", () => {
  it("calls removeWebhook and returns 200 with {removed}", async () => {
    authOk();
    mockedRemove.mockResolvedValue({ ok: true, data: { removed: true } });

    const response = await DELETE(makeRequest("DELETE"));
    const body = await response.json();

    expect(mockedRemove).toHaveBeenCalledWith(AGENT);
    expect(response.status).toBe(200);
    expect(body).toEqual({ success: true, data: { removed: true } });
  });

  it("401s when unauthenticated, and never calls the action", async () => {
    authDenied();
    const response = await DELETE(makeRequest("DELETE"));

    expect(response.status).toBe(401);
    expect(mockedRemove).not.toHaveBeenCalled();
  });
});

describe("secret handling", () => {
  it("POST's response body carries exactly what registerWebhook returned, secret included once", async () => {
    authOk();
    mockedRegister.mockResolvedValue({
      ok: true,
      data: { url: "https://example.com/hook", mode: "both", secret: "one-time-secret" },
    });

    const response = await POST(makeRequest("POST", { url: "https://example.com/hook", mode: "both" }));
    const body = await response.json();

    expect(body.data.secret).toBe("one-time-secret");
  });

  it("GET never carries a secret key when the action's data has none", async () => {
    authOk();
    mockedGet.mockResolvedValue({ ok: true, data: { url: "https://example.com/hook", mode: "primary", disabled: true } });

    const response = await GET(makeRequest("GET"));
    const body = await response.json();

    expect(Object.keys(body.data)).not.toContain("secret");
  });
});
