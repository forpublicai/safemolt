/**
 * @jest-environment node
 *
 * UX3: Centralized provenance derivation must match the persona matrix.
 * Pure function tests — no DB / no route involvement.
 */
import { deriveProvenance } from "@/lib/agent-home/provenance";
import type { StoredAgent } from "@/lib/store-types";

function baseAgent(over: Partial<StoredAgent> = {}): StoredAgent {
  return {
    id: "agent_x",
    name: "x",
    description: "",
    apiKey: "key",
    points: 0,
    votePoints: 0,
    evaluationPoints: 0,
    legacyUnattributedPoints: 0,
    followerCount: 0,
    isClaimed: false,
    createdAt: "2026-01-01T00:00:00.000Z",
    ...over,
  };
}

describe("deriveProvenance", () => {
  it("Chaos persona: claimed off-platform agent — agent_kind=off_platform, is_human_claimed=true, is_platform_hosted=false, admitted=true", () => {
    const agent = baseAgent({
      isClaimed: true,
      isAdmitted: true,
      owner: "@chaos",
    });
    const p = deriveProvenance({ agent, loopEnabled: false, linkedHumanUserCount: 0 });
    expect(p.agent_kind).toBe("off_platform");
    expect(p.is_human_claimed).toBe(true);
    expect(p.is_platform_hosted).toBe(false);
    expect(p.is_admitted).toBe(true);
    expect(p.human_link_kind).toBeNull();
  });

  it("ChaosAI persona: same as Chaos (legacy isClaimed flag, off-platform)", () => {
    const agent = baseAgent({ isClaimed: true, isAdmitted: true });
    const p = deriveProvenance({ agent, loopEnabled: false, linkedHumanUserCount: 0 });
    expect(p.agent_kind).toBe("off_platform");
    expect(p.is_human_claimed).toBe(true);
    expect(p.is_platform_hosted).toBe(false);
  });

  it("river_learns persona: Public AI autonomous — provisioned + loop enabled, dashboard linked, not publicly claimed", () => {
    const agent = baseAgent({
      isClaimed: false,
      isAdmitted: false,
      isVetted: true,
      metadata: { provisioned_public_ai: true },
    });
    const p = deriveProvenance({ agent, loopEnabled: true, linkedHumanUserCount: 1 });
    expect(p.agent_kind).toBe("public_ai_autonomous");
    expect(p.is_platform_hosted).toBe(true);
    expect(p.human_link_kind).toBe("cognito_dashboard");
    expect(p.is_human_claimed).toBe(false);
  });

  it("arlo_sketches persona: same shape as river_learns", () => {
    const agent = baseAgent({
      metadata: { provisioned_public_ai: true },
      isVetted: true,
    });
    const p = deriveProvenance({ agent, loopEnabled: true, linkedHumanUserCount: 1 });
    expect(p.agent_kind).toBe("public_ai_autonomous");
    expect(p.is_platform_hosted).toBe(true);
    expect(p.human_link_kind).toBe("cognito_dashboard");
  });

  it("Public AI manual: provisioned but loop disabled -> public_ai_manual", () => {
    const agent = baseAgent({ metadata: { provisioned_public_ai: true } });
    const p = deriveProvenance({ agent, loopEnabled: false, linkedHumanUserCount: 1 });
    expect(p.agent_kind).toBe("public_ai_manual");
    expect(p.is_platform_hosted).toBe(true);
  });

  it("Public AI manual: provisioned but loop state unavailable -> public_ai_manual", () => {
    const agent = baseAgent({ metadata: { provisioned_public_ai: true } });
    const p = deriveProvenance({ agent, loopEnabled: null, linkedHumanUserCount: 1 });
    expect(p.agent_kind).toBe("public_ai_manual");
    expect(p.is_platform_hosted).toBe(true);
  });

  it("system agent: metadata.system === true -> agent_kind=system", () => {
    const agent = baseAgent({ metadata: { system: true } });
    const p = deriveProvenance({ agent, loopEnabled: false, linkedHumanUserCount: 0 });
    expect(p.agent_kind).toBe("system");
  });

  it("test agent: metadata.test === true -> agent_kind=test", () => {
    const agent = baseAgent({ metadata: { test: true } });
    const p = deriveProvenance({ agent, loopEnabled: false, linkedHumanUserCount: 0 });
    expect(p.agent_kind).toBe("test");
  });

  it("test agent: metadata.source === 'test' -> agent_kind=test", () => {
    const agent = baseAgent({ metadata: { source: "test" } });
    const p = deriveProvenance({ agent, loopEnabled: false, linkedHumanUserCount: 0 });
    expect(p.agent_kind).toBe("test");
  });

  it("does not infer system/test from agent names", () => {
    // Plan invariant: do not classify by name patterns.
    const agent = baseAgent({ name: "test_agent_system_bot" });
    const p = deriveProvenance({ agent, loopEnabled: false, linkedHumanUserCount: 0 });
    expect(p.agent_kind).toBe("off_platform");
  });

  it("is_poaw_vetted mirrors agent.isVetted", () => {
    const vetted = deriveProvenance({
      agent: baseAgent({ isVetted: true }),
      loopEnabled: false,
      linkedHumanUserCount: 0,
    });
    const unvetted = deriveProvenance({
      agent: baseAgent({ isVetted: false }),
      loopEnabled: false,
      linkedHumanUserCount: 0,
    });
    expect(vetted.is_poaw_vetted).toBe(true);
    expect(unvetted.is_poaw_vetted).toBe(false);
  });

  it("human_link_kind is null when no users are linked", () => {
    const p = deriveProvenance({
      agent: baseAgent({ metadata: { provisioned_public_ai: true } }),
      loopEnabled: false,
      linkedHumanUserCount: 0,
    });
    expect(p.human_link_kind).toBeNull();
  });

  it("is_human_claimed is independent from human_link_kind (dashboard-linked != publicly claimed)", () => {
    const agent = baseAgent({
      isClaimed: false,
      metadata: { provisioned_public_ai: true },
    });
    const p = deriveProvenance({ agent, loopEnabled: true, linkedHumanUserCount: 2 });
    expect(p.is_human_claimed).toBe(false);
    expect(p.human_link_kind).toBe("cognito_dashboard");
  });
});
