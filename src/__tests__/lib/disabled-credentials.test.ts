/**
 * @jest-environment node
 *
 * M11-1 C19: credentials with the `disabled_` prefix never authenticate — refused BEFORE the
 * store lookup, so the property holds even for a key that exists in the store. That is the
 * difference between "rejected structurally" and "unpublished": a random key nobody knows is
 * still perfectly valid; a disabled-prefixed key is invalid by construction.
 */
import { DISABLED_CREDENTIAL_PREFIX, getAgentFromRequest } from "@/lib/auth";
import { claimAgentForHumanUser, getAgentByClaimToken } from "@/lib/store/agents/memory";
import { agents, apiKeyToAgentId, claimTokenToAgentId } from "@/lib/store/_memory-state";

function bearer(key: string): Request {
  return new Request("http://localhost/api/v1/agents/me", {
    headers: { authorization: `Bearer ${key}`, "x-school-id": "foundation" },
  });
}

describe("disabled-credential prefix (C19)", () => {
  it("refuses a disabled-prefixed key even when the store contains it", async () => {
    const apiKey = `${DISABLED_CREDENTIAL_PREFIX}c19_demo_key`;
    agents.set("c19_demo", {
      id: "c19_demo",
      name: "c19_demo",
      description: "",
      apiKey,
      points: 0,
      followerCount: 0,
      isClaimed: false,
      createdAt: new Date().toISOString(),
      isVetted: true,
    });
    apiKeyToAgentId.set(apiKey, "c19_demo");

    expect(await getAgentFromRequest(bearer(apiKey))).toBeNull();
  });

  it("refuses a disabled claim token at BOTH the lookup and the decisive claim (memory)", async () => {
    // The store-level invariant, not merely the route's behavior (review round 2, m6): a direct
    // caller of the decisive claim must be refused too, or the seeded vetted+admitted demo agent
    // is claimable and then re-issuable into a working key.
    const claimToken = `${DISABLED_CREDENTIAL_PREFIX}c19_demo_claim`;
    agents.set("c19_claimable", {
      id: "c19_claimable",
      name: "c19_claimable",
      description: "",
      apiKey: `${DISABLED_CREDENTIAL_PREFIX}c19_claimable_key`,
      points: 0,
      followerCount: 0,
      isClaimed: false,
      createdAt: new Date().toISOString(),
      isVetted: true,
      claimToken,
    });
    claimTokenToAgentId.set(claimToken, "c19_claimable");

    expect(await getAgentByClaimToken(claimToken)).toBeNull();
    expect(await claimAgentForHumanUser(claimToken, "attacker-human", "Attacker")).toBeNull();
    expect(agents.get("c19_claimable")?.isClaimed).toBeFalsy();
  });

  it("still authenticates an ordinary key", async () => {
    const apiKey = "safemolt_c19_ordinary_key";
    agents.set("c19_ok", {
      id: "c19_ok",
      name: "c19_ok",
      description: "",
      apiKey,
      points: 0,
      followerCount: 0,
      isClaimed: false,
      createdAt: new Date().toISOString(),
      isVetted: true,
    });
    apiKeyToAgentId.set(apiKey, "c19_ok");

    expect((await getAgentFromRequest(bearer(apiKey)))?.id).toBe("c19_ok");
  });
});
