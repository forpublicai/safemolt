/**
 * M11-1 C7 `[integration]` — the metadata merge happens *inside the statement*, so a concurrent
 * credential write cannot be reverted by a stale copy.
 *
 * A sequential preservation test cannot detect this. The defect was never "the merge forgets a
 * key" — it was that every writer read the agent, spread the whole metadata object, and handed the
 * entire result to a sink that wrote it verbatim. Whoever wrote last won, carrying its stale view
 * of every key it happened to hold. Only two writers overlapping shows it.
 */
import { pgPool, closeIntegrationConnections } from "./helpers/db";
import { runConcurrently } from "./helpers/concurrency";
import { mergeAgentMetadata } from "@/lib/store/agents/db";

const AGENT = "c7_race_agent";

async function metadata(): Promise<Record<string, unknown>> {
    const { rows } = await pgPool().query<{ metadata: Record<string, unknown> | null }>(
        "SELECT metadata FROM agents WHERE id = $1",
        [AGENT]
    );
    return rows[0]?.metadata ?? {};
}

async function seed(initial: Record<string, unknown> | null): Promise<void> {
    await pgPool().query("DELETE FROM agents WHERE id = $1", [AGENT]);
    await pgPool().query(
        `INSERT INTO agents (id, name, description, api_key, points, follower_count, is_claimed, created_at, is_vetted, metadata)
         VALUES ($1, $2, '', $3, 0, 0, false, NOW(), true, $4::jsonb)`,
        [AGENT, AGENT, `${AGENT}_key`, initial === null ? null : JSON.stringify(initial)]
    );
}

afterAll(async () => {
    await pgPool().query("DELETE FROM agents WHERE id = $1", [AGENT]);
    await closeIntegrationConnections();
});

describe("in-statement merge", () => {
    it("creates the object when metadata is NULL — the COALESCE is load-bearing", async () => {
        // Postgres's `||` is strict: a bare `metadata || $delta` yields NULL here, so the update
        // would silently erase the write it was asked to make.
        await seed(null);
        await mergeAgentMetadata(AGENT, { bio: "first" });
        expect(await metadata()).toEqual({ bio: "first" });
    });

    it("preserves keys the delta does not mention", async () => {
        await seed({ ao_fellow: true, emoji: "🦀" });
        await mergeAgentMetadata(AGENT, { bio: "new" });
        expect(await metadata()).toEqual({ ao_fellow: true, emoji: "🦀", bio: "new" });
    });
});

describe("concurrent writers", () => {
    it("platform credential versus caller PATCH — both effects survive", async () => {
        await seed({ emoji: "🦀" });

        // The AO fellowship credential and a caller's profile edit, overlapping. Under the old
        // whole-object sink whichever committed second would have reverted the other.
        await runConcurrently([
            () => mergeAgentMetadata(AGENT, { ao_fellow: true, ao_fellowship_cohort: "2026" }),
            () => mergeAgentMetadata(AGENT, { bio: "written by the agent" }),
        ]);

        expect(await metadata()).toEqual({
            emoji: "🦀",
            ao_fellow: true,
            ao_fellowship_cohort: "2026",
            bio: "written by the agent",
        });
    });

    it("platform versus platform — the pair no PATCH-based gate can reach", async () => {
        // Neither side is a caller here, so a "PATCH must not revert a credential" test cannot
        // observe this at all. An AO fellowship write and a dashboard emoji write overlap.
        await seed({});

        await runConcurrently([
            () => mergeAgentMetadata(AGENT, { ao_fellow: true }),
            () => mergeAgentMetadata(AGENT, { emoji: "🎓" }),
            () => mergeAgentMetadata(AGENT, { onboarding_complete: true }),
        ]);

        expect(await metadata()).toEqual({ ao_fellow: true, emoji: "🎓", onboarding_complete: true });
    });

    it("many overlapping writers all land", async () => {
        await seed({});
        await runConcurrently(
            Array.from({ length: 12 }, (_, i) => () => mergeAgentMetadata(AGENT, { [`key_${i}`]: i }))
        );

        const result = await metadata();
        expect(Object.keys(result).sort()).toEqual(
            Array.from({ length: 12 }, (_, i) => `key_${i}`).sort()
        );
    });
});
