/**
 * @jest-environment node
 *
 * M11b Lane W round 3 F5(c) — POST/GET `/api/v1/agents/me/webhook` through the REAL action
 * (`@/lib/actions/webhooks`, unmocked) and the in-memory store. `agents-me-webhook.test.ts` mocks
 * the action itself, so it cannot see a real secret leak; this file proves the secret rides the POST
 * body exactly once and never appears in a following GET, end to end through the real code path.
 */
jest.mock("node:dns", () => ({
  promises: { lookup: jest.fn(async () => [{ address: "93.184.216.34", family: 4 }]) },
}));

jest.mock("@/lib/auth", () => {
  const actual = jest.requireActual("@/lib/auth");
  return { ...actual, requireAgent: jest.fn() };
});

import { NextRequest } from "next/server";
import { POST, GET } from "@/app/api/v1/agents/me/webhook/route";
import { requireAgent } from "@/lib/auth";
import { createAgent } from "@/lib/store";
import { resetWebhookState } from "@/lib/store/_memory-state";

const mockedRequireAgent = jest.mocked(requireAgent);
const ORIGINAL_FLAG = process.env.WEBHOOKS_ENABLED;

function makeRequest(method: string, body?: unknown): NextRequest {
  return new NextRequest("http://localhost/api/v1/agents/me/webhook", {
    method,
    headers: { authorization: "Bearer k", "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

beforeEach(() => {
  resetWebhookState();
  process.env.WEBHOOKS_ENABLED = "true";
});

afterAll(() => {
  if (ORIGINAL_FLAG === undefined) delete process.env.WEBHOOKS_ENABLED;
  else process.env.WEBHOOKS_ENABLED = ORIGINAL_FLAG;
});

describe("agents/me/webhook — real action + memory store: secret exposure", () => {
  it("the POST body carries the secret exactly once; a following GET never carries it", async () => {
    const agent = await createAgent(`b1w_real_${Date.now().toString(36)}`, "fixture");
    mockedRequireAgent.mockResolvedValue({ ok: true, agent });

    const postResponse = await POST(makeRequest("POST", { url: "https://example.com/hook", mode: "primary" }));
    const postBody = await postResponse.json();

    expect(postResponse.status).toBe(200);
    expect(typeof postBody.data.secret).toBe("string");
    expect(postBody.data.secret.length).toBeGreaterThan(0);

    const getResponse = await GET(makeRequest("GET"));
    const getBody = await getResponse.json();

    expect(getResponse.status).toBe(200);
    expect(getBody.data).not.toHaveProperty("secret");
    expect(JSON.stringify(getBody)).not.toContain(postBody.data.secret);
  });
});
