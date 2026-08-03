/**
 * M11-1 C7 — the forgery, refused at the route, with the downstream consequence asserted.
 *
 * A helper-level rejection test proves the predicate; it does not prove the credential is safe.
 * These go the other way round: attempt the forgery through `PATCH /api/v1/agents/me` exactly as
 * an agent would, then read the surface that *consumes* the credential and show it did not move.
 *
 * The two credentials are not equivalent, and the assertions say so. `ao_fellow` is published
 * outright by `/agents/introspect`. `onboarding_complete` is a *prerequisite* the autonomy route
 * checks in addition to a Cognito session and an ownership check — so forging it would not by
 * itself grant autonomy, and claiming otherwise would overstate the defect.
 *
 * @jest-environment node
 */
import type { StoredAgent } from "@/lib/store-types";
import { withMiddlewareHeaders } from "../../helpers/middleware-headers";

const AGENT: StoredAgent = {
    id: "c7_agent",
    name: "c7_probe",
    description: "",
    apiKey: "c7_key",
    points: 0,
    votePoints: 0,
    evaluationPoints: 0,
    legacyUnattributedPoints: 0,
    followerCount: 0,
    isClaimed: false,
    isVetted: true,
    createdAt: "2026-07-01T00:00:00.000Z",
    metadata: { emoji: "🦀" },
};

function patch(body: unknown): Request {
    return new Request("https://safemolt.com/api/v1/agents/me", withMiddlewareHeaders({
        method: "PATCH",
        headers: { Authorization: "Bearer c7_key", "content-type": "application/json" },
        body: JSON.stringify(body),
    }));
}

async function loadRoute(stored: StoredAgent = AGENT) {
    jest.resetModules();
    const state = { agent: { ...stored } };
    const mergeAgentMetadata = jest.fn(async (_id: string, delta: Record<string, unknown>) => {
        state.agent = { ...state.agent, metadata: { ...(state.agent.metadata ?? {}), ...delta } };
        return state.agent;
    });
    jest.doMock("@/lib/store", () => ({
        authenticateAndTouchByApiKey: jest.fn(async () => state.agent),
        updateAgent: jest.fn(async () => state.agent),
        mergeAgentMetadata,
        getFollowingCount: jest.fn(async () => 0),
        getAnnouncement: jest.fn(async () => null),
    }));
    jest.doMock("@/lib/human-users", () => ({ listUserIdsLinkedToAgent: jest.fn(async () => []) }));
    jest.doMock("@/lib/agent-loop/state", () => ({ readLoopStateSafely: jest.fn(async () => null) }));
    const route = await import("@/app/api/v1/agents/me/route");
    return { route, state, mergeAgentMetadata };
}

describe("PATCH /agents/me refuses reserved keys", () => {
    it.each([
        ["ao_fellow", { ao_fellow: true }],
        ["ao_fellowship_cohort", { ao_fellowship_cohort: "2026" }],
        ["a future ao_* key", { ao_something_invented_later: true }],
        ["onboarding_complete", { onboarding_complete: true }],
        ["provisioned_public_ai", { provisioned_public_ai: true }],
        ["system", { system: true }],
        ["test", { test: true }],
        ["source", { source: "forged" }],
        ["public_ai_handle_style", { public_ai_handle_style: "v2" }],
    ])("rejects %s and writes nothing", async (_label, metadata) => {
        const { route, mergeAgentMetadata } = await loadRoute();
        const res = await route.PATCH(patch({ metadata }) as never);

        expect(res.status).toBe(400);
        const body = await res.json();
        expect(body.error_detail.code).toBe("reserved_metadata_key");
        expect(body.reserved_keys).toEqual(Object.keys(metadata));
        expect(mergeAgentMetadata).not.toHaveBeenCalled();
    });

    it("names every offending key, not just the first", async () => {
        const { route } = await loadRoute();
        const res = await route.PATCH(patch({ metadata: { ao_fellow: true, bio: "hi", system: true } }) as never);
        const body = await res.json();
        expect(body.reserved_keys.sort()).toEqual(["ao_fellow", "system"]);
    });

    it("still accepts caller-writable keys, and merges rather than replaces", async () => {
        const { route, state } = await loadRoute();
        const res = await route.PATCH(patch({ metadata: { bio: "hello" } }) as never);
        expect(res.status).toBe(200);
        // The emoji the agent did not mention survives — the old path would have erased it.
        expect(state.agent.metadata).toEqual({ emoji: "🦀", bio: "hello" });
    });

    it("refuses a non-object metadata instead of silently ignoring it", async () => {
        const { route } = await loadRoute();
        for (const metadata of ["a string", 42, ["array"]]) {
            const res = await route.PATCH(patch({ metadata }) as never);
            expect([metadata, res.status]).toEqual([metadata, 400]);
        }
    });
});

describe("downstream: the forgery does not reach the surfaces that consume it", () => {
    it("a refused ao_fellow does not appear in /agents/introspect", async () => {
        const { route, state } = await loadRoute();
        await route.PATCH(patch({ metadata: { ao_fellow: true, ao_fellowship_cohort: "2026" } }) as never);

        const { GET } = await import("@/app/api/v1/agents/introspect/route");
        const res = await GET(
            new Request("https://safemolt.com/api/v1/agents/introspect", withMiddlewareHeaders({
                headers: { Authorization: "Bearer c7_key" },
            }))
        );
        const body = await res.json();
        expect(body.data.credentials?.ao_fellow ?? body.data.ao_fellow).toBeFalsy();
        expect(state.agent.metadata?.ao_fellow).toBeUndefined();
    });

    it("a refused onboarding_complete leaves the autonomy prerequisite unsatisfied", async () => {
        // Precisely: the autonomy route additionally requires a Cognito session and an ownership
        // check, so this is prerequisite forgery on an owned agent — not a one-PATCH autonomy
        // grant. What is asserted is that the prerequisite itself never moved.
        const { route, state } = await loadRoute();
        const res = await route.PATCH(patch({ metadata: { onboarding_complete: true } }) as never);

        expect(res.status).toBe(400);
        const meta = (state.agent.metadata ?? {}) as Record<string, unknown>;
        expect(meta.onboarding_complete).toBeUndefined();
        // The exact predicate the autonomy route evaluates.
        expect(meta.onboarding_complete !== true).toBe(true);
    });
});
