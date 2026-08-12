/**
 * M11-1 C6 — exactly one claim wins, and a claim never half-lands.
 *
 * Two defects, one shape. `setAgentClaimed` was an **unconditional** update, so a second claimant
 * simply overwrote the first one's owner; and the Cognito route wrote the claim and the ownership
 * link as two auto-committed statements, so a failure of the second left the agent claimed but
 * unowned — and permanently unclaimable, because every retry then hit the "already claimed" check
 * the first write had just made true.
 *
 * @jest-environment node
 */
import { agents } from "@/lib/store/_memory-state";
import { claimAgentForHumanUser, createAgent, getAgentById, setAgentClaimed } from "@/lib/store/agents/memory";
import { upsertHumanUserByCognitoSub, userOwnsAgent } from "@/lib/human-users-memory";

let seq = 0;
function uniqueName(prefix: string): string {
  return `${prefix}_${Date.now()}_${(seq += 1)}`;
}

/**
 * A **real** human user, not an invented id.
 *
 * `user_agents.user_id` references `human_users(id)` in Postgres, so db mode refuses an unknown
 * claimant with a 23503 and rolls the claim back. Tests that pass a made-up id therefore exercise
 * a case db mode rejects, and would keep passing if memory mode diverged.
 */
async function humanUser(label: string): Promise<string> {
  const sub = uniqueName(label);
  const user = await upsertHumanUserByCognitoSub({ cognitoSub: sub, email: `${sub}@example.test`, name: label });
  return user.id;
}

describe("the Cognito claim admits one winner", () => {
  it("gives the agent to exactly one of two concurrent claimants, and links only that one", async () => {
    const agent = await createAgent(uniqueName("c6_agent"), "claimable");
    const [alice, bob] = [await humanUser("alice"), await humanUser("bob")];

    const results = await Promise.all([
      claimAgentForHumanUser(agent.claimToken!, alice, "Alice"),
      claimAgentForHumanUser(agent.claimToken!, bob, "Bob"),
    ]);

    const winners = results.filter((r) => r !== null);
    expect(winners).toHaveLength(1);

    // The loser must own nothing: before C6 both claimants were linked, because the ownership
    // upsert ran regardless of whether the claim itself had been won.
    const owners = [
      await userOwnsAgent(alice, agent.id),
      await userOwnsAgent(bob, agent.id),
    ];
    expect(owners.filter(Boolean)).toHaveLength(1);

    const stored = (await getAgentById(agent.id))!;
    expect(stored.isClaimed).toBe(true);
    expect(stored.owner).toBe(winners[0]!.owner);
  });

  it("refuses a second claim and leaves the first owner in place", async () => {
    const agent = await createAgent(uniqueName("c6_agent"), "claimable");
    const first = await humanUser("first");
    const second = await humanUser("second");

    expect(await claimAgentForHumanUser(agent.claimToken!, first, "First")).not.toBeNull();
    expect(await claimAgentForHumanUser(agent.claimToken!, second, "Second")).toBeNull();

    expect((await getAgentById(agent.id))!.owner).toBe("First");
    expect(await userOwnsAgent(second, agent.id)).toBe(false);
  });

  it("refuses an unknown human user, leaving the agent unclaimed and retryable", async () => {
    // Parity with db mode, where `user_agents.user_id` references `human_users(id)`: an unknown
    // claimant raises 23503 and the whole statement rolls back. Memory has no foreign key, so
    // without an explicit check it would *commit a claim db mode refuses* — and the failing id is
    // reachable, since failed Cognito provisioning yields an `err_<sub>` user id.
    const agent = await createAgent(uniqueName("c6_agent"), "claimable");

    await expect(
      claimAgentForHumanUser(agent.claimToken!, "err_provisioning_failed", "Ghost")
    ).rejects.toThrow(/unknown human user/);

    expect((await getAgentById(agent.id))!.isClaimed).toBe(false);
    expect(await userOwnsAgent("err_provisioning_failed", agent.id)).toBe(false);

    // The lockout is gone: a legitimate claim still works afterwards.
    const real = await humanUser("recovered");
    expect(await claimAgentForHumanUser(agent.claimToken!, real, "Recovered")).not.toBeNull();
    expect(await userOwnsAgent(real, agent.id)).toBe(true);
  });

  it("does not expose a claimed-but-unlinked observation", async () => {
    const agent = await createAgent(uniqueName("c6_agent"), "claimable");
    const human = await humanUser("atomic-observer");
    const claimed = await claimAgentForHumanUser(agent.claimToken!, human, "Owner");

    expect(claimed?.isClaimed).toBe(true);
    expect(await userOwnsAgent(human, agent.id)).toBe(true);
  });

  it("refuses an unknown claim token without touching anything", async () => {
    const before = agents.size;
    expect(await claimAgentForHumanUser("claim_token_that_does_not_exist", await humanUser("nobody"), "Nobody")).toBeNull();
    expect(agents.size).toBe(before);
  });
});

describe("the two claim channels cannot both win", () => {
  it("resolves a concurrent Cognito claim and X verification to one owner", async () => {
    // The repo has two live claim paths: this one through Cognito, and `agents/verify` which calls
    // `setAgentClaimed` after an external Twitter check. Both now gate on unclaimed state, so the
    // pair races to a single winner instead of the later write silently replacing the earlier.
    const agent = await createAgent(uniqueName("c6_agent"), "claimable");
    const human = await humanUser("cognito");

    const [cognito, twitter] = await Promise.all([
      claimAgentForHumanUser(agent.claimToken!, human, "Cognito Owner"),
      setAgentClaimed(agent.id, "@twitter_owner", 42),
    ]);

    expect([cognito !== null, twitter].filter(Boolean)).toHaveLength(1);

    const stored = (await getAgentById(agent.id))!;
    expect(stored.isClaimed).toBe(true);
    expect(stored.owner).toBe(cognito !== null ? "Cognito Owner" : "@twitter_owner");
    // The losing channel wrote nothing, so the winner's fields are internally consistent: an
    // X follower count belongs only to a claim that actually came through X.
    expect(stored.xFollowerCount).toBe(cognito !== null ? undefined : 42);
  });

  it("reports a losing setAgentClaimed rather than overwriting the owner", async () => {
    const agent = await createAgent(uniqueName("c6_agent"), "claimable");

    expect(await setAgentClaimed(agent.id, "@first_owner", 7)).toBe(true);
    expect(await setAgentClaimed(agent.id, "@second_owner", 9)).toBe(false);

    const stored = (await getAgentById(agent.id))!;
    expect(stored.owner).toBe("@first_owner");
    expect(stored.xFollowerCount).toBe(7);
  });
});
