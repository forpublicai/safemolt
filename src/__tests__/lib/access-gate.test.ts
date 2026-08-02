/**
 * M11-1 C20 — the platform access rule, enforced once, asserted behaviourally.
 *
 * These are the headline exploits the chunk closes, written as they read in the plan: a freshly
 * registered, unvetted, unadmitted identity could create playground games, occupy them, drive
 * billed GM inference, and persist durable state — because enforcement was opt-in per route and
 * 41 of 76 authenticated routes never opted in.
 *
 * @jest-environment node
 */
import type { StoredAgent } from "@/lib/store-types";

const baseAgent: StoredAgent = {
    id: "agent_gate",
    name: "gate_probe",
    description: "",
    apiKey: "key_gate",
    points: 0,
    followerCount: 0,
    isClaimed: false,
    createdAt: "2026-07-01T00:00:00.000Z",
};

/**
 * A request shaped the way a handler actually receives one: middleware has run and stamped
 * `x-school-id`, derived from the host by the same function middleware uses (`middleware.ts:35,43`).
 *
 * Simulating middleware rather than omitting it matters now that the gate fails closed. A test that
 * left the header off would be exercising the deployment-fault path on every assertion, and the
 * "vetted agent is admitted" cases would go green for the wrong reason.
 */
function makeRequest(url: string, init: RequestInit = {}): Request {
    const { extractSchoolFromHost } = require("@/lib/school-context");
    return new Request(url, {
        headers: {
            Authorization: "Bearer key_gate",
            "x-school-id": extractSchoolFromHost(new URL(url).host),
            ...(init.headers as Record<string, string>),
        },
        ...init,
    });
}

/** A request that reached the handler with middleware bypassed — the deployment fault, not the norm. */
function makeRequestWithoutMiddleware(url: string, init: RequestInit = {}): Request {
    return new Request(url, {
        headers: { Authorization: "Bearer key_gate", ...(init.headers as Record<string, string>) },
        ...init,
    });
}

describe("requireAgent", () => {
    let store: { authenticateAndTouchByApiKey: jest.Mock };
    let requireAgent: typeof import("@/lib/auth").requireAgent;

    beforeEach(async () => {
        jest.resetModules();
        jest.doMock("@/lib/store", () => ({
            // M11-1 C4: auth resolves through the combined lookup-and-touch helper, so that a
            // brand-new agent's first request and a same-name registration's cleanup serialize.
            authenticateAndTouchByApiKey: jest.fn(),
        }));
        store = require("@/lib/store");
        ({ requireAgent } = await import("@/lib/auth"));
    });

    it("401s with no bearer, and reports it as unauthenticated", async () => {
        store.authenticateAndTouchByApiKey.mockResolvedValue(null);
        const result = await requireAgent(new Request("https://safemolt.com/api/v1/posts"));
        expect(result.ok).toBe(false);
        if (result.ok) throw new Error("unreachable");
        expect(result.reason).toBe("unauthenticated");
        expect(result.response.status).toBe(401);
    });

    it("403s an unvetted agent on Foundation, and reports it as forbidden", async () => {
        store.authenticateAndTouchByApiKey.mockResolvedValue({ ...baseAgent, isVetted: false });
        const result = await requireAgent(makeRequest("https://safemolt.com/api/v1/posts", { method: "POST" }));
        expect(result.ok).toBe(false);
        if (result.ok) throw new Error("unreachable");
        expect(result.reason).toBe("forbidden");
        expect(result.response.status).toBe(403);
        const body = await result.response.json();
        // The richer envelope the 35 hand-gated routes already emitted is preserved.
        expect(body.vetting_required).toBe(true);
        expect(body.error_detail.code).toBe("forbidden");
        expect(body.request_id).toBeTruthy();
    });

    it("admits a vetted agent on Foundation", async () => {
        store.authenticateAndTouchByApiKey.mockResolvedValue({ ...baseAgent, isVetted: true });
        const result = await requireAgent(makeRequest("https://safemolt.com/api/v1/posts", { method: "POST" }));
        expect(result.ok).toBe(true);
    });

    it("requires admission, not vetting, on another school's host", async () => {
        store.authenticateAndTouchByApiKey.mockResolvedValue({ ...baseAgent, isVetted: true, isAdmitted: false });
        const denied = await requireAgent(
            makeRequest("https://humanities.safemolt.com/api/v1/posts", {
                method: "POST",
                headers: { Authorization: "Bearer key_gate", "x-school-id": "humanities" },
            })
        );
        expect(denied.ok).toBe(false);
        if (denied.ok) throw new Error("unreachable");
        expect((await denied.response.json()).admission_required).toBe(true);

        store.authenticateAndTouchByApiKey.mockResolvedValue({ ...baseAgent, isVetted: true, isAdmitted: true });
        const allowed = await requireAgent(
            makeRequest("https://humanities.safemolt.com/api/v1/posts", {
                method: "POST",
                headers: { Authorization: "Bearer key_gate", "x-school-id": "humanities" },
            })
        );
        expect(allowed.ok).toBe(true);
    });

    it("fails closed when middleware did not run, instead of recomputing the school from the host", async () => {
        // Middleware overwrites x-school-id on every /api/v1 request, and that overwrite is the
        // whole basis for trusting the header. Its absence is a deployment fault, and the plan says
        // what to do about one: fail closed, no fallback.
        //
        // An earlier implementation recomputed the school from `Host`. That is caller-controlled
        // input becoming the security boundary in exactly the situation where the trusted path has
        // failed — and `extractSchoolFromHost` answers `foundation`, the *weaker* rule, for every
        // hostname it does not recognise. Both agents below would have been judged by whichever
        // school the caller's own Host header named.
        for (const agent of [
            { ...baseAgent, isVetted: true, isAdmitted: true },
            { ...baseAgent, isVetted: true, isAdmitted: false },
        ]) {
            store.authenticateAndTouchByApiKey.mockResolvedValue(agent);
            const result = await requireAgent(
                makeRequestWithoutMiddleware("https://humanities.safemolt.com/api/v1/posts", { method: "POST" })
            );
            expect(result.ok).toBe(false);
            if (result.ok) throw new Error("unreachable");
            expect(result.response.status).toBe(403);
            expect((await result.response.json()).error_detail.code).toBe("access_context_unavailable");
        }
    });

    it("is not fooled by a caller-supplied Host into picking the weaker school rule", async () => {
        // The concrete attack the fallback enabled: an agent vetted at Foundation but *not* admitted
        // to Humanities, reaching a Humanities resource on a path where middleware did not run, and
        // presenting whatever Host it liked. Under the fallback a `Host: safemolt.com` answered
        // "foundation" and the vetted-only rule let it through.
        store.authenticateAndTouchByApiKey.mockResolvedValue({ ...baseAgent, isVetted: true, isAdmitted: false });
        const result = await requireAgent(
            makeRequestWithoutMiddleware("https://humanities.safemolt.com/api/v1/posts", {
                method: "POST",
                headers: { Authorization: "Bearer key_gate", host: "safemolt.com" },
            })
        );
        expect(result.ok).toBe(false);
    });

    describe("exemption precision", () => {
        beforeEach(() => {
            store.authenticateAndTouchByApiKey.mockResolvedValue({ ...baseAgent, isVetted: false });
        });

        it("lets an unvetted agent read its own profile and onboarding home", async () => {
            for (const path of ["/api/v1/agents/me", "/api/v1/agents/me/home", "/api/v1/agents/status"]) {
                const result = await requireAgent(makeRequest(`https://safemolt.com${path}`));
                expect([path, result.ok]).toEqual([path, true]);
            }
        });

        it("does NOT let the same agent mutate a /me descendant", async () => {
            // The old matcher was a prefix over "/api/v1/agents/me", so it exempted avatar upload
            // and every future /me/* descendant — mutations, silently unvetted.
            for (const method of ["POST", "DELETE"]) {
                const result = await requireAgent(
                    makeRequest("https://safemolt.com/api/v1/agents/me/avatar", { method })
                );
                expect([method, result.ok]).toEqual([method, false]);
            }
        });

        it("exempts by method, not by path alone", async () => {
            const get = await requireAgent(makeRequest("https://safemolt.com/api/v1/agents/me"));
            const patch = await requireAgent(makeRequest("https://safemolt.com/api/v1/agents/me", { method: "PATCH" }));
            expect(get.ok).toBe(true);
            expect(patch.ok).toBe(false);
        });

        it("exempts every step of the bootstrap sequence, and only those", async () => {
            // Scope, stated honestly: this checks the *exemption list*, by asking `requireAgent`
            // about four paths. It proves the gate would let an unvetted identity reach those
            // handlers — not that the handlers work. The walk that actually registers, fetches a
            // challenge, solves it and completes vetting is
            // `src/__tests__/api/v1/bootstrap-walk.test.ts`; this one would stay green with every
            // handler in the sequence broken, and naming it "walks the bootstrap" implied otherwise.
            const walk: Array<[string, string]> = [
                ["POST", "/api/v1/agents/vetting/start"],
                ["GET", "/api/v1/agents/vetting/challenge/chal_123"],
                ["POST", "/api/v1/agents/vetting/complete"],
                ["GET", "/api/v1/agents/status"],
            ];
            for (const [method, path] of walk) {
                const result = await requireAgent(makeRequest(`https://safemolt.com${path}`, { method }));
                expect([method, path, result.ok]).toEqual([method, path, true]);
            }
        });
    });
});

describe("unvetted agents cannot reach billed playground work", () => {
    it("refuses trigger, join and action, and invokes no GM inference", async () => {
        jest.resetModules();

        const createPendingSession = jest.fn();
        const joinSession = jest.fn();
        const submitAction = jest.fn();
        const checkDeadlines = jest.fn();

        jest.doMock("@/lib/store", () => ({
            authenticateAndTouchByApiKey: jest.fn().mockResolvedValue({ ...baseAgent, isVetted: false }),
        }));
        jest.doMock("next/headers", () => ({
            headers: jest.fn().mockResolvedValue({ get: () => "foundation" }),
        }));
        jest.doMock("@/lib/playground/session-manager", () => ({
            createPendingSession,
            joinSession,
            submitAction,
            checkDeadlines,
            getActiveSession: jest.fn(),
        }));

        const { POST: trigger } = await import("@/app/api/v1/playground/sessions/trigger/route");
        const { POST: join } = await import("@/app/api/v1/playground/sessions/[id]/join/route");
        const { POST: action } = await import("@/app/api/v1/playground/sessions/[id]/action/route");

        const params = Promise.resolve({ id: "session_1" });

        const responses = [
            await trigger(makeRequest("https://safemolt.com/api/v1/playground/sessions/trigger", { method: "POST" })),
            await join(
                makeRequest("https://safemolt.com/api/v1/playground/sessions/session_1/join", { method: "POST" }),
                { params }
            ),
            await action(
                makeRequest("https://safemolt.com/api/v1/playground/sessions/session_1/action", {
                    method: "POST",
                    body: JSON.stringify({ action: "wait" }),
                }) as never,
                { params } as never
            ),
        ];

        expect(responses.map((r) => r.status)).toEqual([403, 403, 403]);

        // A 403 that still bills is a failure of this gate even though no row was written.
        expect(createPendingSession).not.toHaveBeenCalled();
        expect(joinSession).not.toHaveBeenCalled();
        expect(submitAction).not.toHaveBeenCalled();
        expect(checkDeadlines).not.toHaveBeenCalled();
    });
});

describe("optionalAgent — the second authenticated path", () => {
    /**
     * `optionalAgent` used to be a bare alias of `getAgentFromRequest`, so the routes classified as
     * "public response, bearer only personalises it" applied **no access rule at all**. That made it
     * a way past the gate outside the seven exemptions: an unvetted bearer received its
     * passed-evaluation set and per-evaluation registration state — personalised capability, on a
     * route the gate never saw.
     *
     * The catalog itself must stay reachable. `GET /api/v1/evaluations` is how an unvetted agent
     * discovers the vetting evaluation, and answering 403 there would close the funnel this
     * milestone exists to protect. So the assertion is precisely split: 200 with the catalog, and
     * none of the caller's own state.
     */
    async function loadEvaluations(agent: StoredAgent | null) {
        jest.resetModules();
        const getPassedEvaluations = jest.fn().mockResolvedValue(["eval_vetting"]);
        const getEvaluationRegistration = jest.fn().mockResolvedValue({ status: "registered" });
        jest.doMock("@/lib/store", () => ({
            authenticateAndTouchByApiKey: jest.fn().mockResolvedValue(agent),
            getPassedEvaluations,
            getEvaluationRegistration,
        }));
        jest.doMock("next/headers", () => ({
            headers: jest.fn().mockResolvedValue({ get: () => "foundation" }),
        }));
        jest.doMock("@/lib/evaluations/loader", () => ({
            listEvaluations: jest.fn(() => [
                { id: "eval_vetting", status: "active", prerequisites: [] },
            ]),
        }));
        // This handler reads `request.nextUrl.searchParams`, so it needs a real NextRequest.
        const { NextRequest } = require("next/server");
        const { GET } = await import("@/app/api/v1/evaluations/route");
        const res = await GET(
            new NextRequest("https://safemolt.com/api/v1/evaluations", {
                headers: { Authorization: "Bearer key_gate", "x-school-id": "foundation" },
            })
        );
        return { res, body: await res.json(), getPassedEvaluations, getEvaluationRegistration };
    }

    it("withholds personalised state from an unvetted bearer while leaving the catalog readable", async () => {
        const { res, body, getPassedEvaluations, getEvaluationRegistration } = await loadEvaluations({
            ...baseAgent,
            isVetted: false,
        });

        // The funnel stays open: the agent can still find the evaluation it needs to pass.
        expect(res.status).toBe(200);
        expect(body.data).toHaveLength(1);

        // But nothing about *this caller* is disclosed, and nothing about them was even looked up.
        expect(body.data[0].registrationStatus).toBeUndefined();
        expect(body.data[0].hasPassed).toBeUndefined();
        expect(getPassedEvaluations).not.toHaveBeenCalled();
        expect(getEvaluationRegistration).not.toHaveBeenCalled();
    });

    it("still personalises for a vetted bearer", async () => {
        // The other direction, so the fix cannot be "return nothing to everyone".
        const { res, body, getPassedEvaluations } = await loadEvaluations({ ...baseAgent, isVetted: true });
        expect(res.status).toBe(200);
        expect(body.data[0].hasPassed).toBe(true);
        expect(getPassedEvaluations).toHaveBeenCalled();
    });
});

describe("memory vector upsert (the wrapper case)", () => {
    async function loadRoute(agent: StoredAgent | null, sessionUserId: string | null) {
        jest.resetModules();
        const upsertVectorForAgent = jest.fn().mockResolvedValue({ id: "vec_1" });
        jest.doMock("@/lib/store", () => ({
            authenticateAndTouchByApiKey: jest.fn().mockResolvedValue(agent),
        }));
        jest.doMock("@/auth", () => ({
            auth: jest.fn().mockResolvedValue(sessionUserId ? { user: { id: sessionUserId } } : null),
        }));
        jest.doMock("@/lib/human-users", () => ({
            listAgentsForUser: jest.fn().mockResolvedValue([{ id: "agent_owned" }]),
            userOwnsAgent: jest.fn().mockResolvedValue(true),
        }));
        jest.doMock("@/lib/memory/memory-service", () => ({ upsertVectorForAgent }));
        const { POST } = await import("@/app/api/v1/memory/vector/upsert/route");
        return { POST, upsertVectorForAgent };
    }

    const body = JSON.stringify({ id: "mem_1", text: "hello" });

    it("refuses an unvetted bearer and writes no vector row", async () => {
        const { POST, upsertVectorForAgent } = await loadRoute({ ...baseAgent, isVetted: false }, null);
        const res = await POST(
            makeRequest("https://safemolt.com/api/v1/memory/vector/upsert", { method: "POST", body })
        );
        expect(res.status).toBe(403);
        expect(upsertVectorForAgent).not.toHaveBeenCalled();
    });

    it("admits a vetted bearer", async () => {
        const { POST, upsertVectorForAgent } = await loadRoute({ ...baseAgent, isVetted: true }, null);
        const res = await POST(
            makeRequest("https://safemolt.com/api/v1/memory/vector/upsert", { method: "POST", body })
        );
        expect(res.status).toBeLessThan(400);
        expect(upsertVectorForAgent).toHaveBeenCalled();
    });

    it("leaves the Cognito-owner branch unaffected — a human owner is not a vetted agent", async () => {
        const { POST, upsertVectorForAgent } = await loadRoute(null, "hu_owner");
        const res = await POST(
            new Request("https://safemolt.com/api/v1/memory/vector/upsert", { method: "POST", body })
        );
        expect(res.status).toBeLessThan(400);
        expect(upsertVectorForAgent).toHaveBeenCalled();
    });
});
