/**
 * M11-1 C4 — the stale-name release is an unauthenticated deletion primitive, so its predicate is
 * the security boundary.
 *
 * `POST /api/v1/agents/register` calls the cleanup before creating an agent, with no
 * authentication at all. Whatever the predicate matches, any anonymous caller can cause to be
 * deleted simply by attempting that name.
 *
 * These run in **memory mode**, where the primitive is genuinely live: the db side raised a
 * swallowed 42883 on every call and so never deleted anything, while this implementation has
 * always deleted on the bare predicate — and memory mode is Jest and no-DB development, which is
 * where a naive test would be written.
 *
 * @jest-environment node
 */
import { agents, apiKeyToAgentId } from "@/lib/store/_memory-state";
import {
    authenticateAndTouchByApiKey,
    cleanupStaleUnclaimedAgent,
    createAgent,
} from "@/lib/store/agents/memory";
import { linkUserToAgent, listAgentsForUser } from "@/lib/human-users-memory";
import type { StoredAgent } from "@/lib/store-types";

const TWO_HOURS_AGO = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();

async function seed(name: string, overrides: Partial<StoredAgent> = {}): Promise<StoredAgent> {
    const created = await createAgent(name, "");
    const agent: StoredAgent = { ...created, createdAt: TWO_HOURS_AGO, ...overrides };
    agents.set(agent.id, agent);
    return agent;
}

beforeEach(() => {
    agents.clear();
    apiKeyToAgentId.clear();
    delete process.env.AGENT_NAME_RELEASE_HOURS;
});

describe("what the predicate may delete", () => {
    it("releases a pristine unclaimed registration past the window", async () => {
        const agent = await seed("pristine");
        await cleanupStaleUnclaimedAgent("pristine");
        expect(agents.get(agent.id)).toBeUndefined();
    });

    it("matches the name case-insensitively, as registration does", async () => {
        const agent = await seed("Pristine");
        await cleanupStaleUnclaimedAgent("pRiStInE");
        expect(agents.get(agent.id)).toBeUndefined();
    });
});

describe("what the predicate must never delete", () => {
    it("spares a vetted agent", async () => {
        const agent = await seed("vetted_one", { isVetted: true });
        await cleanupStaleUnclaimedAgent("vetted_one");
        expect(agents.get(agent.id)).toBeDefined();
    });

    it("spares an agent that ever authenticated, even if it then went idle for weeks", async () => {
        // A grace-window variant would still destroy this one, which is why the predicate is
        // `last_active_at IS NULL` and not "last active more than N hours ago".
        const longAgo = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString();
        const agent = await seed("idle_one", { lastActiveAt: longAgo });
        await cleanupStaleUnclaimedAgent("idle_one");
        expect(agents.get(agent.id)).toBeDefined();
    });

    it("spares a claimed agent", async () => {
        const agent = await seed("claimed_one", { isClaimed: true });
        await cleanupStaleUnclaimedAgent("claimed_one");
        expect(agents.get(agent.id)).toBeDefined();
    });

    it("spares a registration inside the window", async () => {
        const agent = await seed("fresh_one", { createdAt: new Date().toISOString() });
        await cleanupStaleUnclaimedAgent("fresh_one");
        expect(agents.get(agent.id)).toBeDefined();
    });
});

describe("the release window", () => {
    it("is exactly AGENT_NAME_RELEASE_HOURS", async () => {
        process.env.AGENT_NAME_RELEASE_HOURS = "24";
        const withinDay = await seed("within", {
            createdAt: new Date(Date.now() - 23 * 60 * 60 * 1000).toISOString(),
        });
        const pastDay = await seed("past", {
            createdAt: new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString(),
        });

        await cleanupStaleUnclaimedAgent("within");
        await cleanupStaleUnclaimedAgent("past");

        expect(agents.get(withinDay.id)).toBeDefined();
        expect(agents.get(pastDay.id)).toBeUndefined();
    });

    it("falls back to the documented default for a malformed value, never NaN", async () => {
        // `parseInt("banana")` is NaN, and a NaN window silently matches nothing (or, on the db
        // side, reaches make_interval). Validation is required, not optional.
        process.env.AGENT_NAME_RELEASE_HOURS = "banana";
        const agent = await seed("malformed");
        await cleanupStaleUnclaimedAgent("malformed");
        expect(agents.get(agent.id)).toBeUndefined();
    });

    it("rejects a non-positive value the same way", async () => {
        process.env.AGENT_NAME_RELEASE_HOURS = "0";
        const fresh = await seed("zero_window", { createdAt: new Date().toISOString() });
        await cleanupStaleUnclaimedAgent("zero_window");
        // With the default 1h window a just-created agent survives; a literal 0 would delete it.
        expect(agents.get(fresh.id)).toBeDefined();
    });

    it("rejects a digit string that overflows to Infinity", async () => {
        // `^\d+$` is a *shape* check, not a range check: 400 nines matches it and converts to
        // `Infinity`, which is `> 0` and sailed straight through. The two stores then failed in
        // opposite directions — memory computed a `-Infinity` cutoff and released nothing, while db
        // handed `Infinity` to `make_interval` and swallowed the error — so neither would have
        // surfaced as a test failure. The window falls back to the documented default instead.
        process.env.AGENT_NAME_RELEASE_HOURS = "9".repeat(400);
        const stale = await seed("overflow", {
            createdAt: new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(),
        });
        await cleanupStaleUnclaimedAgent("overflow");
        // Two hours old against the default 1h window: released. Under `Infinity` it survived.
        expect(agents.get(stale.id)).toBeUndefined();
    });
});

describe("first authentication versus cleanup", () => {
    it("is decided by one synchronous section, so an await cannot open a window", async () => {
        // Lookup and touch used to be two separate async functions invoked as two awaits, and
        // every await yields the event loop — so a cleanup scheduled in between ran before the
        // touch and destroyed an agent that had already authenticated.
        const agent = await seed("racer");

        const authentication = authenticateAndTouchByApiKey(agent.apiKey);
        const cleanup = cleanupStaleUnclaimedAgent("racer");
        const [authenticated] = await Promise.all([authentication, cleanup]);

        // Either the name was released before the authentication, or the agent survives with a
        // stamp. What must not happen is being destroyed *after* authenticating.
        if (authenticated) {
            expect(authenticated.lastActiveAt).toBeTruthy();
            expect(agents.get(agent.id)).toBeDefined();
        } else {
            expect(agents.get(agent.id)).toBeUndefined();
        }
    });

    it("stamps last_active_at on first authentication, which is what protects the row", async () => {
        const agent = await seed("first_auth");
        expect(agent.lastActiveAt).toBeUndefined();

        await authenticateAndTouchByApiKey(agent.apiKey);
        expect(agents.get(agent.id)?.lastActiveAt).toBeTruthy();

        await cleanupStaleUnclaimedAgent("first_auth");
        expect(agents.get(agent.id)).toBeDefined();
    });

    it("does not rewrite a fresh stamp on every request", async () => {
        const agent = await seed("fresh_stamp", { lastActiveAt: new Date().toISOString() });
        const before = agents.get(agent.id)?.lastActiveAt;
        await authenticateAndTouchByApiKey(agent.apiKey);
        expect(agents.get(agent.id)?.lastActiveAt).toBe(before);
    });

    it("returns null for an unknown key without touching anything", async () => {
        expect(await authenticateAndTouchByApiKey("safemolt_not_a_key")).toBeNull();
    });
});

describe("dashboard linking is an authentication event", () => {
    it("protects the linked agent from the cleanup that would cascade the link away", async () => {
        // The hole this closes: the dashboard's link route used a **pure lookup** that did not
        // stamp `last_active_at`, and `linkUserToAgent` writes only `user_agents`. So a human could
        // present a valid API key, link an agent that had never authenticated, and the row stayed
        // pristine — deletable by an anonymous same-name registration, with `ON DELETE CASCADE`
        // taking the ownership link with it.
        const agent = await seed("linked_agent");
        expect(agent.lastActiveAt).toBeUndefined();

        // What the route now does before linking.
        const authenticated = await authenticateAndTouchByApiKey(agent.apiKey);
        expect(authenticated).not.toBeNull();
        await linkUserToAgent("user_1", agent.id);

        await cleanupStaleUnclaimedAgent("linked_agent");

        expect(agents.get(agent.id)).toBeDefined();
        expect(await listAgentsForUser("user_1")).toHaveLength(1);
    });

    it("has no non-stamping credential lookup left to reach for", async () => {
        // The route was correct-by-choice before; it is correct-by-construction now. `getAgentByApiKey`
        // authenticated without protecting the row, and its only caller was the route above — so it
        // is gone rather than left in place for the next caller to find.
        const store = await import("@/lib/store");
        expect(Object.keys(store)).not.toContain("getAgentByApiKey");
    });
});
