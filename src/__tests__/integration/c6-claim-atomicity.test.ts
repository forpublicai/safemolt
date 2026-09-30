/**
 * M11-1 C6 `[integration]` — one claim winner, and no claimed-but-unowned agent.
 *
 * Two things a mocked `sql` cannot show, and both are the point of the chunk:
 *
 *  1. **Rollback.** The old route wrote the claim and the ownership link as two auto-committed
 *     statements. If the second failed, the agent was left claimed with no owner — and every
 *     retry then hit the "already claimed" check the first write had just made true, so the agent
 *     was unclaimable forever. Proving the fix means making the *second* write fail and observing
 *     that the *first* did not survive it.
 *  2. **Contention.** Two claimants for one token must resolve to one winner because the row
 *     itself arbitrates, not because the application checked first.
 */
import { closeIntegrationConnections, pgPool } from "./helpers/db";
import { raceAgainstHeldLock, rejections, runConcurrently } from "./helpers/concurrency";
import { claimAgentForHumanUser, setAgentClaimed } from "@/lib/store/agents/db";

const ALICE = "c6_user_alice";
const BOB = "c6_user_bob";

let seq = 0;

/** A fresh unclaimed agent with a known claim token. */
async function seedAgent(): Promise<{ id: string; token: string }> {
    const id = `c6_agent_${(seq += 1)}`;
    const token = `c6_token_${(seq += 1)}`;
    await pgPool().query(
        `INSERT INTO agents (id, name, description, api_key, claim_token, points, follower_count, is_claimed, created_at)
         VALUES ($1, $1, '', $2, $3, 0, 0, false, NOW())`,
        [id, `c6_key_${id}`, token]
    );
    return { id, token };
}

async function agentRow(id: string) {
    const { rows } = await pgPool().query<{ is_claimed: boolean; owner: string | null; x_follower_count: number | null }>(
        "SELECT is_claimed, owner, x_follower_count FROM agents WHERE id = $1",
        [id]
    );
    return rows[0];
}

async function ownersOf(agentId: string): Promise<string[]> {
    const { rows } = await pgPool().query<{ user_id: string }>(
        "SELECT user_id FROM user_agents WHERE agent_id = $1 ORDER BY user_id",
        [agentId]
    );
    return rows.map((r) => r.user_id);
}

beforeAll(async () => {
    for (const id of [ALICE, BOB]) {
        await pgPool().query(
            `INSERT INTO human_users (id, cognito_sub, email, name, created_at)
             VALUES ($1, $2, $3, $1, NOW())
             ON CONFLICT (id) DO NOTHING`,
            [id, `sub_${id}`, `${id}@example.test`]
        );
    }
});

beforeEach(async () => {
    await pgPool().query("DELETE FROM user_agents WHERE agent_id LIKE 'c6\\_%'");
    await pgPool().query("DELETE FROM agents WHERE id LIKE 'c6\\_%'");
});

afterAll(async () => {
    await pgPool().query("DELETE FROM user_agents WHERE agent_id LIKE 'c6\\_%'");
    await pgPool().query("DELETE FROM agents WHERE id LIKE 'c6\\_%'");
    await pgPool().query("DELETE FROM human_users WHERE id LIKE 'c6\\_user\\_%'");
    await closeIntegrationConnections();
});

describe("no half-landed claim", () => {
    it("leaves the agent unclaimed and retryable when the ownership write fails", async () => {
        // The injection is the real failure mode, not a stub: `user_agents.user_id` references
        // `human_users(id)`, so claiming for a user that does not exist raises 23503 on the second
        // arm. Under the old two-statement route that 23503 arrived *after* `is_claimed = true`
        // had already committed.
        const { id, token } = await seedAgent();

        await expect(claimAgentForHumanUser(token, "c6_user_who_does_not_exist", "Ghost")).rejects.toMatchObject({
            code: "23503",
        });

        const after = await agentRow(id);
        expect(after.is_claimed).toBe(false);
        expect(after.owner).toBeNull();
        expect(await ownersOf(id)).toEqual([]);

        // And the lockout is gone: the legitimate claim still works afterwards.
        expect(await claimAgentForHumanUser(token, ALICE, "Alice")).not.toBeNull();
        expect((await agentRow(id)).is_claimed).toBe(true);
        expect(await ownersOf(id)).toEqual([ALICE]);
    });
});

describe("concurrent claims", () => {
    it("admits exactly one, and writes exactly one ownership row", async () => {
        const { id, token } = await seedAgent();

        const outcomes = await runConcurrently([
            () => claimAgentForHumanUser(token, ALICE, "Alice"),
            () => claimAgentForHumanUser(token, BOB, "Bob"),
        ]);

        expect(rejections(outcomes)).toEqual([]);
        const winners = outcomes.filter((o) => o.ok && o.value !== null);
        expect(winners).toHaveLength(1);

        // The assertion that matters: the loser wrote no `user_agents` row. Before C6 the
        // ownership upsert was a separate statement that ran whether or not the claim was won,
        // so both humans ended up linked to one agent.
        expect(await ownersOf(id)).toHaveLength(1);
        expect((await agentRow(id)).is_claimed).toBe(true);
    });

    it("blocks on the winner's row and then loses outright", async () => {
        // The mechanism, observed rather than inferred: a claim in flight holds the agent row, the
        // second claim *waits* on it, and re-evaluates `is_claimed = false` after the commit.
        const { id, token } = await seedAgent();

        const observation = await raceAgainstHeldLock({
            hold: async (holder) => {
                await holder.query(
                    "UPDATE agents SET is_claimed = true, owner = 'Held Claimant' WHERE id = $1 AND is_claimed = false",
                    [id]
                );
            },
            contend: () => claimAgentForHumanUser(token, BOB, "Bob"),
            // `"UPDATE agents"` matched half the store. `WITH claimed AS` appears in exactly one
            // production statement — `claimAgentForHumanUser` — so the backend observed blocking
            // is provably the one under test rather than any other writer to the same table.
            contenderMarker: "WITH claimed AS",
        });

        expect(observation.observedBlocked).toBe(true);
        expect(observation.result).toBeNull();
        expect((await agentRow(id)).owner).toBe("Held Claimant");
        expect(await ownersOf(id)).toEqual([]);
    });

    it("resolves a concurrent Cognito claim and X verification to one owner", async () => {
        const { id, token } = await seedAgent();

        const outcomes = await runConcurrently<unknown>([
            () => claimAgentForHumanUser(token, ALICE, "Cognito Owner"),
            () => setAgentClaimed(id, "@twitter_owner", 42),
        ]);

        expect(rejections(outcomes)).toEqual([]);
        const cognitoWon = outcomes[0].ok && outcomes[0].value !== null;
        const twitterWon = outcomes[1].ok && outcomes[1].value === true;
        expect([cognitoWon, twitterWon].filter(Boolean)).toHaveLength(1);

        const row = await agentRow(id);
        expect(row.owner).toBe(cognitoWon ? "Cognito Owner" : "@twitter_owner");
        // A follower count belongs only to a claim that actually came through X, so the losing
        // channel must not have contributed a field to the winner's row.
        expect(row.x_follower_count).toBe(cognitoWon ? null : 42);
        expect(await ownersOf(id)).toEqual(cognitoWon ? [ALICE] : []);
    });
});

describe("second claims change nothing", () => {
    it("refuses a claim against an already-claimed agent and preserves the owner", async () => {
        const { id, token } = await seedAgent();
        expect(await claimAgentForHumanUser(token, ALICE, "Alice")).not.toBeNull();

        expect(await claimAgentForHumanUser(token, BOB, "Bob")).toBeNull();
        expect(await setAgentClaimed(id, "@late_arrival", 99)).toBe(false);

        const row = await agentRow(id);
        expect(row.owner).toBe("Alice");
        expect(row.x_follower_count).toBeNull();
        expect(await ownersOf(id)).toEqual([ALICE]);
    });
});
