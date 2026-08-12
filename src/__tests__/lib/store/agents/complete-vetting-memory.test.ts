/**
 * @jest-environment node
 */
import {
  completeVetting,
  createAgent,
  createVettingChallenge,
  deleteAgent,
  getAgentById,
  pruneExpiredVettingChallenges,
} from "@/lib/store";
import {
  agents,
  evaluationRegistrations,
  evaluationResults,
  vettingChallenges,
} from "@/lib/store/_memory-state";

/**
 * M11-1 C14, memory mode. The db-side gates (atomic batch, locks, cascades) run in
 * `src/__tests__/integration/c14-vetting-durability.test.ts`; these assert the memory store's
 * preflight-then-mutate parity: one synchronous section, same outcomes, same bootstrap shapes.
 */

let seq = 0;
async function freshAgent() {
  return createAgent(`C14Mem_${Date.now()}_${seq++}`, "vetting fixture");
}

function bootstrapRows(agentId: string) {
  const regs = Array.from(evaluationRegistrations.values()).filter((r) => r.agentId === agentId);
  const results = Array.from(evaluationResults.values()).filter((r) => r.agentId === agentId);
  return { regs, results };
}

describe("completeVetting (memory)", () => {
  it("fresh agent: vets, consumes, and writes two terminal registrations with two results", async () => {
    const agent = await freshAgent();
    const challenge = await createVettingChallenge(agent.id);

    const outcome = await completeVetting(agent.id, challenge.id, "# I am\n");
    expect(outcome.outcome).toBe("completed");
    if (outcome.outcome !== "completed") throw new Error("unreachable");
    expect(outcome.bootstrap.map((b) => b.evaluationId).sort()).toEqual(["identity-check", "poaw"]);

    const stored = await getAgentById(agent.id);
    expect(stored?.isVetted).toBe(true);
    expect(stored?.identityMd).toBe("# I am\n");
    expect(vettingChallenges.get(challenge.id)?.consumed).toBe(true);

    const { regs, results } = bootstrapRows(agent.id);
    expect(regs).toHaveLength(2);
    expect(regs.every((r) => r.status === "completed" && r.schoolScopeTrusted)).toBe(true);
    expect(results).toHaveLength(2);
    expect(results.every((r) => r.passed)).toBe(true);
    // Points recomputed as the sum of the bootstrap results.
    const expected = results.reduce((sum, r) => sum + (r.pointsEarned ?? 0), 0);
    expect(stored?.points).toBe(expected);
  });

  it("replay of a consumed challenge is refused and writes nothing new", async () => {
    const agent = await freshAgent();
    const challenge = await createVettingChallenge(agent.id);
    await completeVetting(agent.id, challenge.id, "first");

    const before = bootstrapRows(agent.id);
    const replay = await completeVetting(agent.id, challenge.id, "second");
    expect(replay.outcome).toBe("unavailable");

    const after = bootstrapRows(agent.id);
    expect(after.regs).toHaveLength(before.regs.length);
    expect(after.results).toHaveLength(before.results.length);
    expect((await getAgentById(agent.id))?.identityMd).toBe("first");
  });

  it("an expired challenge is refused and the agent stays unvetted", async () => {
    const agent = await freshAgent();
    const challenge = await createVettingChallenge(agent.id);
    vettingChallenges.get(challenge.id)!.expiresAt = new Date(Date.now() - 1000).toISOString();

    expect((await completeVetting(agent.id, challenge.id, "x")).outcome).toBe("unavailable");
    expect((await getAgentById(agent.id))?.isVetted).toBeFalsy();
  });

  it("another agent's challenge is refused", async () => {
    const owner = await freshAgent();
    const attacker = await freshAgent();
    const challenge = await createVettingChallenge(owner.id);

    expect((await completeVetting(attacker.id, challenge.id, "x")).outcome).toBe("unavailable");
    expect((await getAgentById(attacker.id))?.isVetted).toBeFalsy();
    expect(vettingChallenges.get(challenge.id)?.consumed).toBe(false);
  });

  it("a pre-registered agent reuses its active registration — no duplicate", async () => {
    const agent = await freshAgent();
    const regId = `c14_prereg_${seq++}`;
    evaluationRegistrations.set(regId, {
      id: regId,
      agentId: agent.id,
      evaluationId: "poaw",
      registeredAt: new Date().toISOString(),
      status: "registered",
    });
    const challenge = await createVettingChallenge(agent.id);
    await completeVetting(agent.id, challenge.id, "x");

    const poawRegs = Array.from(evaluationRegistrations.values()).filter(
      (r) => r.agentId === agent.id && r.evaluationId === "poaw"
    );
    expect(poawRegs).toHaveLength(1);
    expect(poawRegs[0].id).toBe(regId);
    expect(poawRegs[0].status).toBe("completed");
  });

  it("an already-passed evaluation gains no second registration or result", async () => {
    const agent = await freshAgent();
    const first = await createVettingChallenge(agent.id);
    await completeVetting(agent.id, first.id, "x");
    const before = bootstrapRows(agent.id);

    // A second valid challenge is refused by the decisive already-vetted classification.
    const second = await createVettingChallenge(agent.id);
    const outcome = await completeVetting(agent.id, second.id, "y");
    expect(outcome).toEqual({ outcome: "completed", bootstrap: [] });
    expect(vettingChallenges.get(second.id)?.consumed).toBe(true);

    const after = bootstrapRows(agent.id);
    expect(after.regs).toHaveLength(before.regs.length);
    expect(after.results).toHaveLength(before.results.length);
  });

  it("sequential completions with two different challenges produce exactly one bootstrap set", async () => {
    const agent = await freshAgent();
    const a = await createVettingChallenge(agent.id);
    const b = await createVettingChallenge(agent.id);
    await completeVetting(agent.id, a.id, "a");
    await completeVetting(agent.id, b.id, "b");
    const { regs, results } = bootstrapRows(agent.id);
    expect(regs).toHaveLength(2); // one per bootstrap evaluation, never four
    expect(results).toHaveLength(2);
  });

  it("agent deletion removes the agent's challenges (memory has no FK cascade)", async () => {
    const agent = await freshAgent();
    await createVettingChallenge(agent.id);
    await createVettingChallenge(agent.id);
    expect(
      Array.from(vettingChallenges.values()).filter((c) => c.agentId === agent.id)
    ).toHaveLength(2);

    await deleteAgent(agent.id);
    expect(
      Array.from(vettingChallenges.values()).filter((c) => c.agentId === agent.id)
    ).toHaveLength(0);
    expect(agents.has(agent.id)).toBe(false);
  });

  it("failure injection: a throw in the derivation phase consumes nothing and vets nobody (review round 2, m8)", async () => {
    // The memory batch's discipline is "throwing work FIRST": the field derivation reads the
    // definition loader and may throw, and everything after it is the synchronous mutate section.
    // If the throw could happen after the vetting write, a failed completion would burn the
    // challenge and half-vet the agent — this asserts it cannot.
    const agent = await freshAgent();
    const challenge = await createVettingChallenge(agent.id);

    // A fresh module registry with the derivation mocked to throw. The store's maps live on
    // globalThis (_memory-state), so the re-imported module operates on the same state.
    await jest.isolateModulesAsync(async () => {
      jest.doMock("@/lib/store/evaluations/result-fields", () => ({
        computeEvaluationResultFields: () => {
          throw new Error("injected derivation failure");
        },
      }));
      const { completeVetting: failing } = await import("@/lib/store/agents/memory");
      await expect(failing(agent.id, challenge.id, "x")).rejects.toThrow("injected derivation failure");
    });
    jest.dontMock("@/lib/store/evaluations/result-fields");

    // Nothing committed: unvetted, unconsumed, no bootstrap rows — and the same challenge works
    // once the fault clears.
    expect((await getAgentById(agent.id))?.isVetted).toBeFalsy();
    expect(vettingChallenges.get(challenge.id)?.consumed).toBe(false);
    expect(bootstrapRows(agent.id).results).toHaveLength(0);
    expect((await completeVetting(agent.id, challenge.id, "retry")).outcome).toBe("completed");
  });

  it("pruning removes only challenges expired past the retention window", async () => {
    const agent = await freshAgent();
    const stale = await createVettingChallenge(agent.id);
    const recent = await createVettingChallenge(agent.id);
    vettingChallenges.get(stale.id)!.expiresAt = new Date(Date.now() - 48 * 3_600_000).toISOString();
    vettingChallenges.get(recent.id)!.expiresAt = new Date(Date.now() - 3_600_000).toISOString();

    await pruneExpiredVettingChallenges(24 * 3_600_000);
    expect(vettingChallenges.has(stale.id)).toBe(false);
    expect(vettingChallenges.has(recent.id)).toBe(true);
  });
});
