/**
 * M11-1 C20 — every handler under `src/app/api/v1` is classified by principal, and every
 * agent-bearer handler reaches the access gate.
 *
 * **This classifies handlers; it does not scan imports.** An import scan is trivially satisfiable
 * while the hole stays open, and one such hole existed: `resolveAgentMemoryAuth` calls
 * `getAgentFromRequest` outside the route tree and `POST /api/v1/memory/vector/upsert` persisted
 * durable vector state through it, so a rule of the form "no direct import under
 * `src/app/api/v1`" was satisfied by that route while an unvetted agent wrote memory through it.
 *
 * **Every route file must land in exactly one bucket.** An earlier version of this suite only
 * examined files that mentioned an auth helper, which silently blessed the 43 route files that
 * mention none — so a new route needing authentication, or one hand-rolling its own, would have
 * passed without comment. Classification is now exhaustive: an unclassifiable route fails.
 *
 * @jest-environment node
 */
import { readFileSync, readdirSync, statSync } from "fs";
import { join, relative } from "path";
import { ACCESS_GATE_EXEMPTIONS } from "@/lib/auth";

const REPO_ROOT = join(__dirname, "..", "..", "..");
const V1_ROOT = join(REPO_ROOT, "src", "app", "api", "v1");

const HTTP_METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"] as const;

type Principal =
    | "agent-bearer"
    | "agent-bearer-optional"
    | "agent-bearer-wrapper"
    | "professor"
    | "human-session"
    | "admin-secret"
    | "cron-secret"
    | "service-secret"
    | "public";

/**
 * Markers that identify a handler's principal, in priority order.
 *
 * Order matters: a route that reaches `requireAgent` is an agent-bearer route regardless of what
 * else it also accepts, because that is the branch the access rule governs.
 */
const PRINCIPAL_MARKERS: Array<{ principal: Principal; pattern: RegExp }> = [
    { principal: "agent-bearer", pattern: /\brequireAgent\s*\(/ },
    // Wrappers that reach the gate on their bearer branch. Each is asserted to still do so below.
    { principal: "agent-bearer-wrapper", pattern: /\b(resolveAgentMemoryAuth|authorizeAgentMemory)\s*\(/ },
    { principal: "agent-bearer-optional", pattern: /\boptionalAgent\s*\(/ },
    { principal: "professor", pattern: /\bgetProfessorFromRequest\s*\(/ },
    { principal: "cron-secret", pattern: /CRON_SECRET|requireCronAuth/ },
    { principal: "admin-secret", pattern: /ADMIN_SECRET/ },
    {
        principal: "service-secret",
        pattern: /authorizeSchoolService|authorizeSchoolEvent|authorizeAgentMetadataMerge/,
    },
    { principal: "human-session", pattern: /from ["']@\/auth["']/ },
];

/**
 * Routes that are deliberately unauthenticated. Every entry is a claim a human made and a
 * reviewer can check, and adding one is a visible diff to a security-relevant list.
 */
const PUBLIC_ROUTES: Record<string, string> = {
    "GET route.ts": "API index",
    "POST route.ts": "API index",
    "PUT route.ts": "API index",
    "PATCH route.ts": "API index",
    "DELETE route.ts": "API index",
    "GET [...notfound]/route.ts": "404 handler",
    "POST [...notfound]/route.ts": "404 handler",
    "PUT [...notfound]/route.ts": "404 handler",
    "PATCH [...notfound]/route.ts": "404 handler",
    "DELETE [...notfound]/route.ts": "404 handler",
    "POST agents/register/route.ts": "creates the identity the rule would be checked against",
    "POST agents/verify/route.ts": "external X/Twitter verification; the verification code is the capability",
    "GET agents/vetting/challenge/[id]/route.ts":
        "the challenge id issued by vetting/start IS the capability; there is no identity to check yet",
    "GET announcements/route.ts": "public announcement read",
    "GET memory/health/route.ts": "liveness probe, no data",
    "GET playground/games/route.ts": "static game catalogue",
    "GET playground/prefabs/route.ts": "static personality templates",
    "GET playground/sessions/route.ts": "public session listing, same content the web UI renders",
    "GET playground/sessions/[id]/route.ts": "public session detail, same content the web UI renders",
    "GET schools/route.ts": "public school directory",
    "GET schools/[id]/route.ts": "public school detail",
    "GET schools/[id]/leaderboard/route.ts": "public leaderboard",
    "GET schools/[id]/professors/route.ts": "public faculty listing",
    "GET companies/route.ts": "public AO company directory",
    "GET companies/[id]/route.ts": "public AO company detail",
    "GET companies/[id]/evaluations/route.ts": "public AO evaluation record",
    "GET companies/leaderboard/route.ts": "public AO leaderboard",
    "GET demo-days/route.ts": "public AO demo day listing",
    "GET demo-days/[id]/route.ts": "public AO demo day detail",
    "GET updates/route.ts": "public AO updates firehose",
    "GET working-papers/[slug]/route.ts": "public working paper",
    "GET evaluations/[id]/versions/route.ts": "public evaluation version history",
    "GET evaluations/results/[resultId]/route.ts": "public result, already shown on profiles",
    "GET evaluations/[id]/results/[resultId]/transcript/route.ts": "public result transcript",
};

/**
 * Remove comments and string literals before classifying.
 *
 * Classification is regex-based, so without this a mention of `requireAgent` in a comment, a
 * docstring, or a string constant would satisfy the check while the handler stayed ungated. This
 * does not make the scan an AST parse — it removes the cheapest way to fool it.
 */
function stripNonCode(source: string): string {
    const withoutComments = source
        .replace(/\/\*[\s\S]*?\*\//g, " ")
        .replace(/(^|[^:])\/\/[^\n]*/g, "$1 ");
    // Import lines keep their string literals: some principals are identified by *what a module
    // imports* (`from "@/auth"`), and blanking those would misclassify every human-session route.
    return withoutComments
        .split("\n")
        .map((line) =>
            /^\s*import\b/.test(line)
                ? line
                : line
                      .replace(/`(?:[^`\\]|\\.)*`/g, '""')
                      .replace(/'(?:[^'\\\n]|\\.)*'/g, '""')
                      .replace(/"(?:[^"\\\n]|\\.)*"/g, '""')
        )
        .join("\n");
}

function collectRouteFiles(dir: string, out: string[] = []): string[] {
    for (const entry of readdirSync(dir)) {
        const full = join(dir, entry);
        if (statSync(full).isDirectory()) collectRouteFiles(full, out);
        else if (entry === "route.ts") out.push(full);
    }
    return out;
}

function exportedMethods(source: string): string[] {
    return HTTP_METHODS.filter(
        (method) =>
            new RegExp(`export\\s+(async\\s+)?function\\s+${method}\\b`).test(source) ||
            new RegExp(`export\\s+const\\s+${method}\\b`).test(source)
    );
}

/**
 * Handler methods exported through an **export clause** rather than a declaration.
 *
 * `const write = …; export { write as POST }` is a perfectly valid Next.js route handler that a
 * declaration-only scan cannot see — and worse than merely invisible: if the same file also exports
 * a conventional `GET`, the "every file exposes at least one method" assertion is satisfied and the
 * aliased `POST` is never classified at all. A route could ship ungated with the inventory green.
 *
 * These are **banned rather than parsed**. Per-method classification works by slicing the module at
 * declaration boundaries, so an aliased export has no handler body to slice and would need a real
 * AST to resolve. Nothing in the tree uses the form, the convention costs nothing, and a ban is a
 * guarantee where a parser is a second thing to get right.
 */
function aliasedMethodExports(source: string): string[] {
    const found: string[] = [];
    for (const clause of stripNonCode(source).matchAll(/export\s*\{([^}]*)\}/g)) {
        for (const specifier of clause[1].split(",")) {
            const parts = specifier.trim().split(/\s+as\s+/);
            const exported = (parts[1] ?? parts[0] ?? "").trim();
            if ((HTTP_METHODS as readonly string[]).includes(exported)) found.push(specifier.trim());
        }
    }
    return found;
}

/**
 * Slice a route module into its exported handler bodies.
 *
 * Classification is **per method**, not per file: one module can legitimately expose a public GET
 * and a gated POST (`about/timeline/reactions` does exactly that), and a file-level verdict would
 * report the stricter of the two and hide the weaker one.
 */
function handlerBody(source: string, method: string): string {
    const start = source.search(new RegExp(`export\\s+(async\\s+)?(function|const)\\s+${method}\\b`));
    if (start === -1) return "";
    const rest = source.slice(start + 1);
    // The boundary is the next *top-level declaration of any kind*, not the next `export`.
    // Stopping only at exports would swallow an unexported helper declared between two handlers
    // and attribute its markers to the handler above it — which is exactly how
    // `GET about/timeline/reactions` briefly classified as agent-bearer because
    // `resolveWriteViewer` sits between it and POST.
    const nextTopLevel = rest.search(/\n(export\s+)?(async\s+)?(function|const|class)\s/);
    return nextTopLevel === -1 ? rest : rest.slice(0, nextTopLevel);
}

/**
 * Methods whose principal is established by a module-level helper or import rather than by a call
 * inside the handler body. Classification falls back to module scope for exactly these.
 *
 * The list is asserted to be exact, so the fallback cannot quietly become the general case and a
 * new route cannot join it without a human writing down why.
 */
const FILE_SCOPED_PRINCIPAL: Record<string, string> = {
    "POST announcements/route.ts": "module-level ADMIN_SECRET check",
    "DELETE announcements/route.ts": "module-level ADMIN_SECRET check",
    "POST about/timeline/reactions/route.ts": "resolveWriteViewer wraps requireAgent",
    "GET about/timeline/reactions/route.ts": "resolveViewer wraps optionalAgent",
    "POST admin/sync-classes/route.ts": "module-level admin secret check",
    "POST agents/claim/route.ts": "claim token is the credential; Cognito session imported at module scope",
    "GET classes/[id]/assistants/route.ts": "professor bearer resolved by a module helper",
    "GET companies/[id]/team/route.ts": "AO school access resolved by a module helper",
    "GET companies/[id]/updates/route.ts": "AO school access resolved by a module helper",
    "GET fellowship/applications/route.ts": "AO staff check over the module-scope Cognito session",
    "GET fellowship/applications/[id]/route.ts": "AO staff check over the module-scope Cognito session",
    "PATCH fellowship/applications/[id]/route.ts": "AO staff check over the module-scope Cognito session",
    "GET working-papers/route.ts": "module-level requireAoSchool over the gated agent",
};

interface Handler {
    rel: string;
    method: string;
    principal: Principal | null;
    fellBack: boolean;
    /** Why this handler's gate does not decide anything, or null when it does. */
    gateDefect: string | null;
}

interface HandlerFile {
    rel: string;
    source: string;
    methods: string[];
    principal: Principal | null;
}

/**
 * Does this scope let the gate's verdict *decide anything*?
 *
 * Classification asks whether `requireAgent(` appears. That is presence, not enforcement: a handler
 * could call it, drop the `{ ok: false }` on the floor, and go on to write — and the inventory would
 * have called it gated. `AgentAuthResult`'s discriminated shape makes that hard to do by accident,
 * but "hard to do by accident" is not what a security gate's CI check should be asserting.
 *
 * So the result must be **bound**, and the binding must be **early-returned on denial**. Both arms
 * are keyed on the same variable name, which is what stops a body that guards one call and quietly
 * ignores a second. Two return shapes are accepted, because both appear in the tree and both are
 * correct: `return v.response` from a handler, and `return { ok: false, response: v.response }` from
 * a helper that propagates the denial to its own caller.
 *
 * Not an AST parse — but the thing it now proves is a property of the code rather than of its text.
 */
function gateDecidesSomething(scope: string): string | null {
    const code = stripNonCode(scope);
    const binding = /(?:const|let|var)\s+(\w+)\s*=\s*await\s+requireAgent\s*\(/g;
    let bound = 0;
    let match: RegExpExecArray | null;

    while ((match = binding.exec(code)) !== null) {
        bound += 1;
        const variable = match[1];
        // `return` immediately, or a block that contains one. `[^}]*` deliberately refuses to look
        // past the end of the guard's own block.
        const guard = new RegExp(`if\\s*\\(\\s*!\\s*${variable}\\.ok\\s*\\)\\s*(?:return\\b|\\{[^}]*\\breturn\\b)`);
        if (!guard.test(code.slice(match.index))) {
            return `'${variable}' is bound from requireAgent but never early-returned on !${variable}.ok`;
        }
    }

    if (bound === 0) return "requireAgent appears but its result is never bound to a variable";
    return null;
}

/** Marker-only: what principal does this code establish, ignoring any exemption list? */
function markerPrincipal(scope: string): Principal | null {
    return PRINCIPAL_MARKERS.find((m) => m.pattern.test(stripNonCode(scope)))?.principal ?? null;
}

function classify(scope: string, key: string): Principal | null {
    return markerPrincipal(scope) ?? (PUBLIC_ROUTES[key] !== undefined ? "public" : null);
}

const handlerFiles: HandlerFile[] = collectRouteFiles(V1_ROOT).map((file) => {
    const rel = relative(V1_ROOT, file);
    const source = readFileSync(file, "utf8");
    return { rel, source, methods: exportedMethods(source), principal: markerPrincipal(source) };
});

const handlers: Handler[] = handlerFiles.flatMap((f) =>
    f.methods.map((method) => {
        const body = handlerBody(f.source, method);
        // Public exemptions are keyed per method: adding an unprotected mutation to an
        // already-public file must not inherit that file's verdict.
        const inline = classify(body, `${method} ${f.rel}`);
        // Fall back to module scope only for methods named above.
        const fellBack = inline === null && FILE_SCOPED_PRINCIPAL[`${method} ${f.rel}`] !== undefined;
        const principal = inline ?? (fellBack ? f.principal : null);
        // Checked against whichever scope produced the classification, so a helper-mediated handler
        // is judged on the module that actually holds the call.
        const gateDefect =
            principal === "agent-bearer" ? gateDecidesSomething(fellBack ? f.source : body) : null;
        return { rel: f.rel, method, principal, fellBack, gateDefect };
    })
);

describe("v1 handler inventory", () => {
    it("finds the route tree and every exported handler in it", () => {
        expect(handlerFiles.length).toBeGreaterThan(100);
        expect(handlerFiles.filter((f) => f.methods.length === 0).map((f) => f.rel)).toEqual([]);
    });

    it("refuses a handler exported through an alias, which it could not classify", () => {
        // The gap this closes: `export { write as POST }` is invisible to a declaration scan, and a
        // file that *also* exports a conventional GET satisfies the "at least one method" check
        // above — so the aliased POST slips through unclassified and ungated.
        const offenders = handlerFiles
            .flatMap((f) => aliasedMethodExports(f.source).map((spec) => `${f.rel}: export { ${spec} }`));
        expect(offenders).toEqual([]);
    });

    it("that ban actually detects the form it bans", () => {
        // A check nobody has seen fire is not evidence — the same reason the credential scan runs
        // over fixture trees.
        expect(aliasedMethodExports(`const write = async () => {}; export { write as POST };`)).toEqual([
            "write as POST",
        ]);
        expect(aliasedMethodExports(`const POST = async () => {}; export { POST };`)).toEqual(["POST"]);
        expect(aliasedMethodExports(`export { a as POST, b as DELETE };`)).toEqual([
            "a as POST",
            "b as DELETE",
        ]);
        // Not a handler export, and not flagged.
        expect(aliasedMethodExports(`export { helper, someConst as OTHER };`)).toEqual([]);
        // A mention inside a comment or string is not an export.
        expect(aliasedMethodExports(`// export { write as POST }\nconst s = "export { x as GET }";`)).toEqual([]);
    });

    it("classifies every exported handler method — an unclassifiable one is a failure", () => {
        // A new route that needs authentication, or that hand-rolls its own, lands here rather
        // than being silently blessed as public.
        const unclassified = handlers.filter((h) => h.principal === null).map((h) => `${h.method} ${h.rel}`);
        expect(unclassified).toEqual([]);
    });

    it("keeps the module-scope fallback to an exact, named set", () => {
        // Per-method classification is the rule; falling back to file scope is the exception, and
        // an exception nobody wrote down is how a hole gets in.
        const actual = handlers.filter((h) => h.fellBack).map((h) => `${h.method} ${h.rel}`).sort();
        expect(actual).toEqual(Object.keys(FILE_SCOPED_PRINCIPAL).sort());
    });

    it("never leaves a mutating method on an optional bearer", () => {
        // The substantive constraint, and not a restatement of the classification: an optional
        // bearer grants no rights, so a *write* reached with one is a write nobody authorized.
        // `about/timeline/reactions` POST is the case this is aimed at — it must reach
        // requireAgent even though the sibling GET is deliberately optional.
        const writes = handlers
            .filter((h) => h.principal === "agent-bearer-optional")
            .filter((h) => !["GET", "HEAD", "OPTIONS"].includes(h.method))
            .map((h) => `${h.method} ${h.rel}`);
        expect(writes).toEqual([]);
    });

    it("bans raw getAgentFromRequest under the v1 route tree", () => {
        // The route-facing choice is requireAgent (gated) or optionalAgent (classified). Reaching
        // for the raw authenticator is how a route ends up authenticating without deciding access.
        expect(handlerFiles.filter((f) => /\bgetAgentFromRequest\b/.test(f.source)).map((f) => f.rel)).toEqual([]);
    });

    it("requires every agent-bearer handler's gate to actually decide something", () => {
        // Not a restatement of the classification. Classification asks "does `requireAgent` appear";
        // this asks "does its verdict control whether the handler proceeds". A handler that calls
        // the gate, ignores `{ ok: false }`, and writes anyway is classified gated and is not.
        const defects = handlers
            .filter((h) => h.gateDefect !== null)
            .map((h) => `${h.method} ${h.rel}: ${h.gateDefect}`);
        expect(defects).toEqual([]);
    });

    it("that check fires on a handler that calls the gate and ignores it", () => {
        // A decoy, for the same reason the credential scan has fixture trees: a check that has
        // never been seen to fail is not evidence. All three shapes are exercised — the ignored
        // verdict, the guard that returns nothing, and a second call guarded under the first
        // call's variable name.
        expect(
            gateDecidesSomething(`
                export async function POST(request: Request) {
                    const access = await requireAgent(request);
                    return jsonResponse({ ok: true, who: access.agent });
                }`)
        ).toMatch(/never early-returned/);

        expect(
            gateDecidesSomething(`
                export async function POST(request: Request) {
                    const access = await requireAgent(request);
                    if (!access.ok) { console.warn("denied"); }
                    return jsonResponse({ ok: true });
                }`)
        ).toMatch(/never early-returned/);

        expect(
            gateDecidesSomething(`
                export async function POST(request: Request) {
                    const access = await requireAgent(request);
                    if (!access.ok) return access.response;
                    const second = await requireAgent(request);
                    if (!access.ok) return access.response;
                    return write(second.agent);
                }`)
        ).toMatch(/'second' is bound/);

        // And passes on the shape the tree actually uses, in both accepted return forms.
        expect(
            gateDecidesSomething(`
                const access = await requireAgent(request);
                if (!access.ok) return access.response;`)
        ).toBeNull();
        expect(
            gateDecidesSomething(`
                const access = await requireAgent(request);
                if (!access.ok) return { ok: false, response: access.response };`)
        ).toBeNull();

        // A mention in a comment or a string is not a gate.
        expect(
            gateDecidesSomething(`
                export async function POST() {
                    // this handler should call requireAgent(request) one day
                    return jsonResponse({ ok: true });
                }`)
        ).toMatch(/never bound/);
    });

    it("keeps the wrapper it trusts actually gated, and gated load-bearingly", () => {
        // `toContain("platformAccessDenial")` was satisfied by a comment or by unreachable code.
        // The wrapper's bearer branch must compute the denial and return on it; the behavioural
        // proof that it does is in `access-gate.test.ts` ("refuses an unvetted bearer and writes no
        // vector row"), and this keeps the structure from drifting away from that test.
        const authorize = stripNonCode(
            readFileSync(join(REPO_ROOT, "src", "lib", "memory", "authorize.ts"), "utf8")
        );

        // Two shapes, both load-bearing: the denial tested directly as the condition, or bound and
        // then tested. What is rejected is a `platformAccessDenial` whose result goes nowhere.
        const inline = /if\s*\(\s*platformAccessDenial\s*\([^)]*\)\s*\)\s*(?:return\b|\{[^}]*\breturn\b)/.test(
            authorize
        );
        const bound = /(?:const|let)\s+(\w+)\s*=\s*platformAccessDenial\s*\(/.exec(authorize);
        const boundAndReturned =
            bound !== null &&
            new RegExp(`if\\s*\\(\\s*${bound[1]}\\s*\\)\\s*(?:return\\b|\\{[^}]*\\breturn\\b)`).test(authorize);

        expect({ inline, boundAndReturned }).not.toEqual({ inline: false, boundAndReturned: false });
    });

    it("keeps the optional-bearer set small and named", () => {
        // Each of these grants no rights from the bearer; `optionalAgent`'s docblock records the
        // per-route justification. Growth here should be a deliberate, visible decision.
        //
        // Three files that *also* use `optionalAgent` are absent on purpose: `about/timeline/
        // reactions` and `classes/[id]/sessions/[sessionId]/messages` gate their write branch with
        // `requireAgent`, so they classify as agent-bearer; `classes/[id]/results` moved to
        // `requireAgent` outright, because its bearer branch returns data the public branch
        // refuses for a draft class — presenting a bearer bought a capability.
        const optional = handlerFiles.filter((f) => f.principal === "agent-bearer-optional").map((f) => f.rel).sort();
        expect(optional).toEqual(
            [
                "classes/[id]/enrollments/route.ts",
                "classes/[id]/evaluations/route.ts",
                "classes/[id]/route.ts",
                "classes/[id]/sessions/[sessionId]/route.ts",
                "classes/[id]/sessions/route.ts",
                "classes/route.ts",
                "evaluations/[id]/results/route.ts",
                "evaluations/[id]/route.ts",
                "evaluations/route.ts",
            ].sort()
        );
    });

    it("does not list a public exemption for a handler that no longer exists", () => {
        const known = new Set(handlers.map((h) => `${h.method} ${h.rel}`));
        expect(Object.keys(PUBLIC_ROUTES).filter((key) => !known.has(key))).toEqual([]);
    });

    it("is not fooled by a mention of requireAgent in a comment or a string", () => {
        // The scan is regex-based, so this is the cheapest way to defeat it. Proving the strip
        // works is what makes the classification mean anything.
        const decoy = `export async function POST() { /* requireAgent */ const s = "requireAgent("; return s; }`;
        expect(stripNonCode(decoy)).not.toContain("requireAgent(");
    });
});

describe("exemption list", () => {
    it("is exact path + method, never a prefix", () => {
        for (const exemption of ACCESS_GATE_EXEMPTIONS) {
            expect(HTTP_METHODS).toContain(exemption.method);
            expect(exemption.path.startsWith("/api/v1/")).toBe(true);
            expect(exemption.path.endsWith("/")).toBe(false);
            expect(exemption.reason.length).toBeGreaterThan(10);
        }
    });

    it("covers the whole bootstrap walk and nothing beyond it", () => {
        const entries = ACCESS_GATE_EXEMPTIONS.map((e) => `${e.method} ${e.path}`).sort();
        expect(entries).toEqual(
            [
                "GET /api/v1/agents/me",
                // M11-2 P4.2: the agent's own senses, exempt for the same reason /me/home is.
                "GET /api/v1/agents/me/context",
                "GET /api/v1/agents/me/home",
                "GET /api/v1/agents/status",
                "GET /api/v1/agents/vetting/challenge/:challengeId",
                "POST /api/v1/agents/register",
                "POST /api/v1/agents/vetting/complete",
                "POST /api/v1/agents/vetting/start",
            ].sort()
        );
    });

    it("names, for each exemption, whether it is live or defensive", () => {
        // Two entries are inert: `POST /agents/register` and
        // `GET /agents/vetting/challenge/{id}` are unauthenticated routes that never call
        // `requireAgent`, so their exemptions can never fire. They are kept deliberately — the
        // plan seeded them, and if either route ever gains authentication the exemption is
        // already correct — but a security-relevant constant should not quietly contain entries
        // that do nothing, so the inertness is asserted rather than assumed.
        const inert = new Set(["POST /api/v1/agents/register", "GET /api/v1/agents/vetting/challenge/:challengeId"]);
        for (const exemption of ACCESS_GATE_EXEMPTIONS) {
            const key = `${exemption.method} ${exemption.path}`;
            if (!inert.has(key)) continue;
            const rel = `${exemption.path.replace("/api/v1/", "").replace(/\/:[^/]+$/, "/[id]")}/route.ts`;
            const handler = handlers.find((h) => h.rel === rel && h.method === exemption.method);
            expect([key, handler?.principal]).toEqual([key, "public"]);
        }
    });
});
