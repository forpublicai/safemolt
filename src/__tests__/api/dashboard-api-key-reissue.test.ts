/**
 * @jest-environment node
 *
 * M11-1 C17 (opt-in re-issue), memory mode: the dashboard POST re-issues an owned agent's api
 * key; the old key stops authenticating immediately and the key index never carries both.
 */

const sessionState: { userId: string | null } = { userId: "human-1" };
const ownershipState: { owns: boolean } = { owns: true };

jest.mock("@/auth", () => ({
  auth: jest.fn(async () => (sessionState.userId ? { user: { id: sessionState.userId } } : null)),
}));

// The ROUTE's friendly gate is mocked; the store's own ownership predicate is not — that is the
// point of review round 2's B2 fix, and the revocation test below relies on the difference.
jest.mock("@/lib/human-users", () => ({
  userOwnsAgent: jest.fn(async () => ownershipState.owns),
}));

import { GET, POST } from "@/app/api/dashboard/agents/[agentId]/api-key/route";
import { getAgentFromRequest } from "@/lib/auth";
import { createAgent } from "@/lib/store";
import { apiKeyToAgentId } from "@/lib/store/_memory-state";
import { linkUserToAgent, unlinkUserFromAgent } from "@/lib/human-users-memory";

let seq = 0;

function routeParams(agentId: string): { params: Promise<{ agentId: string }> } {
  return { params: Promise.resolve({ agentId }) };
}

function bearer(key: string): Request {
  return new Request("http://localhost/api/v1/agents/me", {
    headers: { authorization: `Bearer ${key}`, "x-school-id": "foundation" },
  });
}

beforeEach(() => {
  sessionState.userId = "human-1";
  ownershipState.owns = true;
});

describe("POST /api/dashboard/agents/:agentId/api-key (C17 re-issue)", () => {
  it("returns the new key once in the GET shape; the old key stops authenticating immediately", async () => {
    const agent = await createAgent(`C17Reissue_${seq++}`, "re-issue fixture");
    await linkUserToAgent("human-1", agent.id);

    const res = await POST(new Request("http://localhost", { method: "POST" }), routeParams(agent.id));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.agent_id).toBe(agent.id);
    expect(body.data.api_key).not.toBe(agent.apiKey);
    expect(body.data.api_key).toMatch(/^safemolt_/);

    // The old key is dead, the new one lives, and the index carries exactly the new entry.
    expect(await getAgentFromRequest(bearer(agent.apiKey))).toBeNull();
    expect((await getAgentFromRequest(bearer(body.data.api_key)))?.id).toBe(agent.id);
    expect(apiKeyToAgentId.has(agent.apiKey)).toBe(false);
    expect(apiKeyToAgentId.get(body.data.api_key)).toBe(agent.id);

    // GET now serves the rotated key — the "returned once" property is about the rotation
    // response, not about hiding the stored credential from its owner.
    const read = await GET(new Request("http://localhost"), routeParams(agent.id));
    expect((await read.json()).data.api_key).toBe(body.data.api_key);
  });

  it("refuses without a session and refuses a non-owner, changing nothing", async () => {
    const agent = await createAgent(`C17Guard_${seq++}`, "guard fixture");
    await linkUserToAgent("human-1", agent.id);

    sessionState.userId = null;
    expect((await POST(new Request("http://localhost", { method: "POST" }), routeParams(agent.id))).status).toBe(401);

    sessionState.userId = "human-1";
    ownershipState.owns = false;
    expect((await POST(new Request("http://localhost", { method: "POST" }), routeParams(agent.id))).status).toBe(403);

    // The credential is untouched by refused attempts.
    expect((await getAgentFromRequest(bearer(agent.apiKey)))?.id).toBe(agent.id);
  });

  it("ownership revoked between the route gate and the rotation refuses (review round 2, B2)", async () => {
    const agent = await createAgent(`C17Revoked_${seq++}`, "revocation fixture");
    await linkUserToAgent("human-1", agent.id);
    // The route's friendly gate still says yes (it is mocked true) — but the ownership link is
    // gone, so the store's own predicate refuses. That gap IS the check-then-act window.
    await unlinkUserFromAgent("human-1", agent.id);

    const res = await POST(new Request("http://localhost", { method: "POST" }), routeParams(agent.id));
    expect(res.status).toBe(403);
    // The former owner got nothing and the credential still belongs to whoever holds it.
    expect((await getAgentFromRequest(bearer(agent.apiKey)))?.id).toBe(agent.id);
  });
});
