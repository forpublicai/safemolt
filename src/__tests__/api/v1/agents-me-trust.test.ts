/**
 * @jest-environment node
 *
 * UX3: GET /api/v1/agents/me must expose the canonical trust/provenance object
 * alongside the existing legacy fields, and must not leak PII (api key, claim
 * tokens, dashboard user IDs).
 */
import { assertSuccessEnvelope } from "@/__tests__/helpers/api-contract";

jest.mock("@/lib/store", () => ({
  getAgentByApiKey: jest.fn(),
  // M11-1 C4: auth resolves through the combined lookup-and-touch helper.
  authenticateAndTouchByApiKey: jest.fn(),
  touchAgentLastActiveAtIfStale: jest.fn().mockResolvedValue(undefined),
  updateAgent: jest.fn(),
  getFollowingCount: jest.fn().mockResolvedValue(0),
  getAnnouncement: jest.fn().mockResolvedValue(null),
}));

jest.mock("@/lib/human-users", () => ({
  listUserIdsLinkedToAgent: jest.fn().mockResolvedValue([]),
}));

jest.mock("@/lib/agent-loop/state", () => ({
  readLoopStateSafely: jest.fn().mockResolvedValue(null),
}));

const store = require("@/lib/store");
const humanUsers = require("@/lib/human-users");
const loopStateMod = require("@/lib/agent-loop/state");

import { GET as getMe } from "@/app/api/v1/agents/me/route";

function makeReq() {
  return new (require("next/server").NextRequest)("http://localhost/api/v1/agents/me", {
    headers: { Authorization: "Bearer key_1" },
  });
}

const baseAgent = {
  id: "agent_1",
  name: "Fresh",
  description: "",
  apiKey: "supersecret_api_key",
  points: 0,
  followerCount: 0,
  isClaimed: false,
  isAdmitted: false,
  isVetted: true,
  createdAt: "2026-05-01T00:00:00.000Z",
  claimToken: "supersecret_claim_token",
  verificationCode: "supersecret_verify",
};

describe("GET /api/v1/agents/me — trust/provenance", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    store.authenticateAndTouchByApiKey.mockResolvedValue(baseAgent);
    store.getFollowingCount.mockResolvedValue(0);
    store.getAnnouncement.mockResolvedValue(null);
    humanUsers.listUserIdsLinkedToAgent.mockResolvedValue([]);
    loopStateMod.readLoopStateSafely.mockResolvedValue(null);
  });

  it("Public AI fixture: canonical trust block + legacy fields preserved", async () => {
    store.authenticateAndTouchByApiKey.mockResolvedValue({
      ...baseAgent,
      metadata: { provisioned_public_ai: true },
    });
    humanUsers.listUserIdsLinkedToAgent.mockResolvedValue(["hu_secret_user_id"]);
    loopStateMod.readLoopStateSafely.mockResolvedValue({
      enabled: true,
      lastActionAt: "2026-05-13T10:00:00.000Z",
      nextEligibleAt: "2026-05-13T11:00:00.000Z",
      lastError: null,
      actionsTaken: 4,
    });

    const res = await getMe(makeReq());
    expect(res.status).toBe(200);
    const body = await res.json();
    assertSuccessEnvelope(body);
    const data = (body as { data: Record<string, unknown> }).data;

    // Canonical trust block
    expect(data.trust).toBeTruthy();
    const trust = data.trust as Record<string, unknown>;
    expect(trust.agent_kind).toBe("public_ai_autonomous");
    expect(trust.is_platform_hosted).toBe(true);
    expect(trust.human_link_kind).toBe("cognito_dashboard");
    expect(trust.is_human_claimed).toBe(false);
    expect(trust.is_poaw_vetted).toBe(true);
    expect(typeof trust.is_admitted).toBe("boolean");

    // Loop block when available
    const loop = data.loop as Record<string, unknown>;
    expect(loop.enabled).toBe(true);
    expect(loop.last_action_at).toBe("2026-05-13T10:00:00.000Z");

    // Legacy fields preserved (existing UX2 contract)
    expect(data.is_claimed).toBe(false);
    expect(data.is_vetted).toBe(true);
    expect(data.is_admitted).toBe(false);

    // PII denylist
    const serialized = JSON.stringify(body);
    expect(serialized).not.toContain("supersecret_api_key");
    expect(serialized).not.toContain("supersecret_claim_token");
    expect(serialized).not.toContain("supersecret_verify");
    expect(serialized).not.toContain("hu_secret_user_id");
  });

  it("Off-platform fixture: trust.agent_kind=off_platform, is_human_claimed=true", async () => {
    store.authenticateAndTouchByApiKey.mockResolvedValue({
      ...baseAgent,
      isClaimed: true,
      owner: "@example",
    });

    const res = await getMe(makeReq());
    const body = await res.json();
    const data = (body as { data: Record<string, unknown> }).data;
    const trust = data.trust as Record<string, unknown>;
    expect(trust.agent_kind).toBe("off_platform");
    expect(trust.is_platform_hosted).toBe(false);
    expect(trust.is_human_claimed).toBe(true);
    expect(data.is_claimed).toBe(true);
  });
});
