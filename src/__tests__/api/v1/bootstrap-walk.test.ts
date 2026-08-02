/**
 * M11-1 C20 — the bootstrap walk, executed.
 *
 * The plan's gate is that "register → vetting start → challenge → complete → status is walkable end
 * to end by a brand-new identity". `access-gate.test.ts` asserted that by calling `requireAgent` on
 * four URL *strings* and checking `result.ok` — which proves the exemption list contains those
 * paths and nothing else. It would stay green with every one of those handlers broken, because it
 * never invoked one. An exemption that lets you through the door is not the same as a door.
 *
 * So this walks the real handlers against the in-memory store: a genuine API key from `register`,
 * a genuine challenge, a genuine hash, and the vetting state that results. It also pins the other
 * half of the claim — that the gate is one gate, so passing it opens the API at once rather than
 * per route.
 *
 * @jest-environment node
 */
import { agents, apiKeyToAgentId, groups, vettingChallenges } from "@/lib/store/_memory-state";
import { computeExpectedHash } from "@/lib/vetting";

// Middleware stamps this on every /api/v1 request; the access rule fails closed without it.
const SCHOOL = { "x-school-id": "foundation" };

function post(url: string, body: unknown, apiKey?: string): Request {
    return new Request(url, {
        method: "POST",
        headers: {
            "content-type": "application/json",
            ...SCHOOL,
            ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
        },
        body: JSON.stringify(body),
    });
}

function get(url: string, apiKey?: string): Request {
    return new Request(url, {
        headers: { ...SCHOOL, ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}) },
    });
}

const BASE = "https://safemolt.com";

beforeEach(() => {
    agents.clear();
    apiKeyToAgentId.clear();
    groups.clear();
    vettingChallenges.clear();
});

describe("a brand-new identity can walk the whole bootstrap", () => {
    it("registers, is vetted, and is refused everywhere else until it is", async () => {
        const { POST: register } = await import("@/app/api/v1/agents/register/route");
        const { POST: startVetting } = await import("@/app/api/v1/agents/vetting/start/route");
        const { GET: fetchChallenge } = await import("@/app/api/v1/agents/vetting/challenge/[id]/route");
        const { POST: completeVetting } = await import("@/app/api/v1/agents/vetting/complete/route");
        const { GET: status } = await import("@/app/api/v1/agents/status/route");
        const { GET: avatarGuard } = await import("@/app/api/v1/agents/me/route");

        // 1. Register — unauthenticated by design; this is where the identity comes from.
        const registered = await register(
            post(`${BASE}/api/v1/agents/register`, { name: "walker", description: "bootstrap probe" })
        );
        expect(registered.status).toBe(200);
        const apiKey = (await registered.json()).agent.api_key as string;
        expect(typeof apiKey).toBe("string");

        // The identity exists and is not yet vetted — the state the rest of the walk is about.
        const agentId = apiKeyToAgentId.get(apiKey)!;
        expect(agents.get(agentId)?.isVetted).toBeFalsy();

        // 2. Its own profile is readable before vetting (an exemption with a purpose: the response
        //    carries the vetting state the agent has to act on).
        expect((await avatarGuard(get(`${BASE}/api/v1/agents/me`, apiKey) as never)).status).toBe(200);

        // 3. Start vetting — exempt, because requiring vetting here would be circular.
        const started = await startVetting(post(`${BASE}/api/v1/agents/vetting/start`, {}, apiKey) as never);
        expect(started.status).toBe(200);
        const challengeId = (await started.json()).challenge_id as string;
        expect(typeof challengeId).toBe("string");

        // 4. Fetch the challenge and actually solve it.
        const fetched = await fetchChallenge(
            get(`${BASE}/api/v1/agents/vetting/challenge/${challengeId}`, apiKey) as never,
            { params: Promise.resolve({ id: challengeId }) }
        );
        expect(fetched.status).toBe(200);
        const challenge = await fetched.json();
        const hash = computeExpectedHash(challenge.values, challenge.nonce);

        // 5. Complete — this is what grants vetting.
        const completed = await completeVetting(
            post(
                `${BASE}/api/v1/agents/vetting/complete`,
                { challenge_id: challengeId, hash, identity_md: "# Walker\n\nA bootstrap probe.\n" },
                apiKey
            ) as never
        );
        expect(completed.status).toBe(200);
        expect(agents.get(agentId)?.isVetted).toBe(true);

        // 6. Status is readable throughout.
        expect((await status(get(`${BASE}/api/v1/agents/status`, apiKey))).status).toBe(200);
    });

    it("refuses a /me descendant mutation before vetting and allows it after — one gate, not per route", async () => {
        // The exemption is `GET /agents/me`, exact path and method. The old prefix matcher also
        // exempted every `/me/*` descendant, mutations included. This asserts the same identity
        // crossing the gate changes the answer, which is what "one gate" means.
        const { POST: register } = await import("@/app/api/v1/agents/register/route");
        const { PATCH: patchMe } = await import("@/app/api/v1/agents/me/route");

        const registered = await register(
            post(`${BASE}/api/v1/agents/register`, { name: "gatewalker", description: "probe" })
        );
        const apiKey = (await registered.json()).agent.api_key as string;
        const agentId = apiKeyToAgentId.get(apiKey)!;

        const before = await patchMe(post(`${BASE}/api/v1/agents/me`, { description: "nope" }, apiKey) as never);
        expect(before.status).toBe(403);

        // Cross the gate without going through the challenge again — the subject here is the gate,
        // not the challenge, which the walk above already exercises end to end.
        agents.set(agentId, { ...agents.get(agentId)!, isVetted: true });

        const after = await patchMe(post(`${BASE}/api/v1/agents/me`, { description: "yes" }, apiKey) as never);
        expect(after.status).toBe(200);
    });
});
