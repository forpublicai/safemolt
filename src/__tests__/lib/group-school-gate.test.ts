/**
 * M11-1 C20, review round 4 — the school that owns a group decides who may act in it.
 *
 * **One defect family, found five times**, which is why it gets a structural gate and not five
 * fixes. `requireAgent` answers "may this identity use SafeMolt at all", keyed on the *request's*
 * host. Resources owned by another school need their own check:
 *
 *   - round 1 found it for `schools/{id}/groups` — fixed there;
 *   - round 2 found the same thing still open for **classes** — fixed there;
 *   - round 4 found it still open for **groups, posts and comments**, and added this suite;
 *   - round 5 found it *still* open for **post/comment votes, pin/unpin and post delete** — because
 *     this suite's own trigger was `getGroup(`, and those handlers resolve a post or a comment.
 *
 * Round 4's lesson was "enumerate the call sites instead of fixing instances". Round 5's is the
 * sharper version: **an enumeration is only as wide as its trigger**, and a trigger keyed on the
 * one resource type the reviewer happened to be looking at will keep the family alive. The trigger
 * is now the resource *set*, and the widening carries a decoy test proving it detects the shape it
 * used to miss.
 *
 * A new mutating route or tool that resolves any of those resources fails here rather than shipping
 * open.
 *
 * **Scope: participation, not visibility.** Group content is already publicly browsable on the web,
 * so reads stay open; the boundary governs who may *act*. Read handlers are listed explicitly with
 * that reason rather than being silently skipped.
 *
 * @jest-environment node
 */
import { readFileSync, readdirSync, statSync } from "fs";
import { join, relative } from "path";
import { groupSchoolAccessDenial, requireGroupSchoolAccess } from "@/lib/school-context";
import type { StoredAgent } from "@/lib/store-types";

const REPO_ROOT = join(__dirname, "..", "..", "..");
const V1_ROOT = join(REPO_ROOT, "src", "app", "api", "v1");
const TOOLS_ROOT = join(REPO_ROOT, "src", "lib", "agent-tools", "definitions");
/**
 * The third surface, added by M11-2 (P1.1/P1.2): the ACTION layer.
 *
 * The strangler moves each mutation's gate out of its route and its tool into one action, which is
 * the point — but it also moves the gate out of this suite's reach, because a thin adapter resolves
 * nothing and is therefore invisible to the enumeration. Scanning only the two original surfaces
 * would have made the suite quietly weaker with every migrated chunk: `POST /api/v1/posts`,
 * `DELETE /posts/{id}`, both post votes, the comment vote and `POST /posts/{id}/comments` have all
 * left it. So the trigger follows the code.
 */
const ACTIONS_ROOT = join(REPO_ROOT, "src", "lib", "actions");

/**
 * What counts as "resolving a school-scoped resource".
 *
 * **Round 5 widened this, and the reason is the whole point of the suite.** The trigger used to be
 * `getGroup(` alone — so a handler that resolved a *post* or a *comment* and acted on its group was
 * invisible to the enumeration, because it never names a group directly. Five mutating handlers
 * were sitting in that blind spot: post upvote, post downvote, comment upvote, pin/unpin, and post
 * delete. A gate that cannot see the resource its own family is keyed on is not a gate.
 */
const RESOURCE_RESOLVERS = /\b(getGroup|getPost|getComment)\s*\(/;

/**
 * Handlers that resolve a school-scoped resource and deliberately do **not** gate, each with the
 * reason. Keys are `path` for a whole file or `path:METHOD` for one handler — mixed files must use
 * the per-method form, since a blanket exemption on a file that also mutates is how `DELETE
 * /posts/{id}` stayed ungated behind "post detail — public content".
 */
const READ_ONLY_GROUP_SITES: Record<string, string> = {
    "groups/[name]/route.ts": "group detail — the same content the public web renders",
    "groups/[name]/feed/route.ts": "group feed — public content",
    "groups/[name]/moderators/route.ts:GET": "moderator list — public content; POST and DELETE are gated",
    "feed/route.ts": "personal feed assembly; membership already decided what is in it",
    "search/route.ts": "public search",
    "posts/[id]/route.ts:GET": "post detail — public content; DELETE is gated",
    "posts/route.ts:GET": "post listing — public content; POST is gated",
    // `posts/[id]/comments/route.ts` is deliberately absent: since P1.2 its POST is an adapter over
    // `actions/comments.createComment` and its GET resolves nothing, so the file no longer trips the
    // trigger at all — and a stale exemption is a hole waiting for a handler under the same name.
    "get_my_group_role": "reads the caller's own role",
    "list_moderators": "moderator list — public content",
    "list_feed": "public content",
    "list_groups": "public content",
    "list_comments": "public content",
    "search_posts": "public search",
};

function collectFiles(dir: string, match: (name: string) => boolean, out: string[] = []): string[] {
    for (const entry of readdirSync(dir)) {
        const full = join(dir, entry);
        if (statSync(full).isDirectory()) collectFiles(full, match, out);
        else if (match(entry)) out.push(full);
    }
    return out;
}

/** Strip comments and string literals so a mention in prose cannot satisfy a check. */
function stripNonCode(source: string): string {
    return source
        .replace(/\/\*[\s\S]*?\*\//g, " ")
        .replace(/(^|[^:])\/\/[^\n]*/g, "$1 ")
        .replace(/`(?:[^`\\]|\\.)*`/g, '""')
        .replace(/'(?:[^'\\\n]|\\.)*'/g, '""')
        .replace(/"(?:[^"\\\n]|\\.)*"/g, '""');
}

/**
 * Slice a route module down to one exported handler's body.
 *
 * The boundary is the next top-level declaration of any kind, not the next `export` — stopping at
 * exports swallows an unexported helper declared between two handlers and attributes its markers
 * to the handler above it.
 */
function handlerBody(code: string, method: string): string {
    const start = code.search(new RegExp(`export\\s+(async\\s+)?(function|const)\\s+${method}\\b`));
    if (start === -1) return "";
    const rest = code.slice(start + 1);
    const next = rest.search(/\n(export\s+)?(async\s+)?(function|const|class)\s/);
    return next === -1 ? rest : rest.slice(0, next);
}

/**
 * Every top-level function in a module, name → body.
 *
 * The boundary is the next top-level `function` declaration, exported or not — the same rule
 * `handlerBody` uses, and for the same reason: stopping at `export` swallows the private helpers
 * declared between two exports.
 */
function topLevelFunctions(code: string): Map<string, string> {
    const declarations = [...code.matchAll(/^(?:export\s+)?(?:async\s+)?function\s+(\w+)\s*[(<]/gm)];
    const bodies = new Map<string, string>();
    declarations.forEach((match, index) => {
        const start = match.index!;
        const end = index + 1 < declarations.length ? declarations[index + 1].index! : code.length;
        bodies.set(match[1], code.slice(start, end));
    });
    return bodies;
}

/**
 * One function's body **plus every local function it reaches**, transitively.
 *
 * **Without this the scan is defeated by a two-line wrapper**, which is exactly the shape the vote
 * actions took: `export function upvotePost(input) { return votePost(input, "up"); }` resolves no
 * resource and mentions no gate, so an inspection of the export alone skipped it — and the policy it
 * skipped was living, correctly, in the private `votePost` beside it. A refactor must not be able to
 * hide a mutation from its own invariant, so the trigger follows the call.
 */
function reachableBody(name: string, bodies: Map<string, string>, seen = new Set<string>()): string {
    if (seen.has(name)) return "";
    seen.add(name);
    const own = bodies.get(name) ?? "";
    const called = [...own.matchAll(/\b(\w+)\s*\(/g)].map((match) => match[1]);
    return [own, ...called.filter((callee) => bodies.has(callee)).map((callee) => reachableBody(callee, bodies, seen))].join(
        "\n"
    );
}

const agent = (over: Partial<StoredAgent> = {}): StoredAgent => ({
    id: "a1",
    name: "probe",
    description: "",
    apiKey: "k",
    points: 0,
    votePoints: 0,
    evaluationPoints: 0,
    legacyUnattributedPoints: 0,
    followerCount: 0,
    isClaimed: false,
    createdAt: "2026-07-01T00:00:00.000Z",
    ...over,
});

describe("the rule itself", () => {
    it("treats a group with no school as Foundation's", () => {
        // Every group created before per-school scoping has school_id NULL. Reading that as "no
        // school, therefore no rule" would exempt the majority of the table.
        expect(requireGroupSchoolAccess(agent({ isVetted: false }), { schoolId: null })).not.toBeNull();
        expect(requireGroupSchoolAccess(agent({ isVetted: false }), {})).not.toBeNull();
        expect(requireGroupSchoolAccess(agent({ isVetted: true }), { schoolId: null })).toBeNull();
    });

    it("refuses a Foundation-vetted, AO-unadmitted agent acting in an AO group", () => {
        // The exploit, stated directly: the identity satisfies the Foundation rule, and the request
        // arrives on the Foundation host, but the *group* is AO's.
        const vettedNotAdmitted = agent({ isVetted: true, isAdmitted: false });
        expect(requireGroupSchoolAccess(vettedNotAdmitted, { schoolId: "ao" })).not.toBeNull();
        expect(requireGroupSchoolAccess(vettedNotAdmitted, { schoolId: "foundation" })).toBeNull();

        const admitted = agent({ isVetted: true, isAdmitted: true });
        expect(requireGroupSchoolAccess(admitted, { schoolId: "ao" })).toBeNull();
    });

    it("gives the tool surface the same verdict as the route surface", () => {
        // Two presentations, one decision. A route that refuses while the tool allows is the drift
        // this milestone keeps finding; asserting them together is what keeps them honest.
        for (const schoolId of ["foundation", "ao", "humanities", null]) {
            for (const a of [
                agent({ isVetted: false }),
                agent({ isVetted: true, isAdmitted: false }),
                agent({ isVetted: true, isAdmitted: true }),
            ]) {
                const route = requireGroupSchoolAccess(a, { schoolId });
                const tool = groupSchoolAccessDenial(a, { schoolId });
                expect([schoolId, a.isVetted, a.isAdmitted, route === null]).toEqual([
                    schoolId,
                    a.isVetted,
                    a.isAdmitted,
                    tool === null,
                ]);
            }
        }
    });
});

describe("every group-mutating call site applies it", () => {
    it("gates each mutating v1 route handler that resolves a school-scoped resource", () => {
        // Per **method**, not per file. A file-level verdict reports the stricter handler and hides
        // the weaker one — which is exactly how `DELETE /posts/{id}` shipped ungated while its
        // sibling `GET` carried the "public content" exemption.
        const ungated: string[] = [];
        for (const file of collectFiles(V1_ROOT, (n) => n === "route.ts")) {
            const rel = relative(V1_ROOT, file);
            const code = stripNonCode(readFileSync(file, "utf8"));
            if (READ_ONLY_GROUP_SITES[rel] !== undefined) continue;

            for (const method of ["POST", "PATCH", "PUT", "DELETE"]) {
                const body = handlerBody(code, method);
                if (!body) continue;
                if (READ_ONLY_GROUP_SITES[`${rel}:${method}`] !== undefined) continue;
                if (!RESOURCE_RESOLVERS.test(body)) continue;
                if (!/requireGroupSchoolAccess\s*\(/.test(body)) ungated.push(`${rel}:${method}`);
            }
        }
        expect(ungated).toEqual([]);
    });

    it("that widening actually detects the handlers it was blind to", () => {
        // A check nobody has seen fire is not evidence. This is the exact shape of the five
        // handlers round 5 found: resolve a post, act on its group, never mention `getGroup`.
        const decoy = `
            export async function POST(request: NextRequest) {
                const post = await getPost(id);
                return upvotePost(id, agent.id);
            }`;
        const body = handlerBody(stripNonCode(decoy), "POST");
        expect(RESOURCE_RESOLVERS.test(body)).toBe(true);
        expect(/requireGroupSchoolAccess\s*\(/.test(body)).toBe(false);

        // And the old trigger would have missed it, which is why the widening was needed.
        expect(/\bgetGroup\s*\(/.test(body)).toBe(false);
    });

    it("gates each mutating agent-tool executor that resolves a group", () => {
        // The tool path is the one a route-only fix leaves open — tools call the store directly.
        const ungated: string[] = [];
        for (const file of collectFiles(TOOLS_ROOT, (n) => n.endsWith(".ts"))) {
            const code = stripNonCode(readFileSync(file, "utf8"));
            // Executor bodies: `  name: async (args, { agent }) => {` up to the next executor.
            const executors = [...code.matchAll(/^ {2}(\w+): async \(args, \{[^}]*\}\) => \{$/gm)];
            executors.forEach((match, i) => {
                const start = match.index!;
                const end = i + 1 < executors.length ? executors[i + 1].index! : code.length;
                const body = code.slice(start, end);
                const name = match[1];
                if (!RESOURCE_RESOLVERS.test(body)) return;
                if (READ_ONLY_GROUP_SITES[name] !== undefined) return;
                if (!/groupSchoolAccessDenial\s*\(/.test(body)) ungated.push(`${relative(REPO_ROOT, file)}:${name}`);
            });
        }
        expect(ungated).toEqual([]);
    });

    /**
     * The third surface (M11-2): every exported ACTION that resolves a school-scoped resource.
     *
     * Actions are where the two adapters' gates converge, so this is where the rule now lives for
     * every migrated mutation. There is no exemption list: an action is by definition a mutation
     * path, and a read that needed no gate would not be one.
     */
    it("gates each exported action that resolves a school-scoped resource, through its helpers", () => {
        const ungated: string[] = [];
        const inspected: string[] = [];
        for (const file of collectFiles(ACTIONS_ROOT, (n) => n.endsWith(".ts"))) {
            const code = stripNonCode(readFileSync(file, "utf8"));
            const bodies = topLevelFunctions(code);
            for (const name of [...code.matchAll(/^export\s+(?:async\s+)?function\s+(\w+)\s*[(<]/gm)].map((m) => m[1])) {
                // The export PLUS every local helper it reaches: a thin wrapper delegating to a
                // policy-bearing helper must be judged on what it actually runs.
                const body = reachableBody(name, bodies);
                if (!RESOURCE_RESOLVERS.test(body)) continue;
                inspected.push(name);
                if (!/groupSchoolAccessDenial\s*\(/.test(body)) {
                    ungated.push(`${relative(REPO_ROOT, file)}:${name}`);
                }
            }
        }
        expect(ungated).toEqual([]);
        // **The scan must be seen to REACH the migrated mutations**, not merely to pass. Both vote
        // actions are two-line wrappers whose gate lives one call down; an empty inspection set
        // would satisfy the assertion above while checking nothing, which is how they were skipped.
        //
        // **The group actions are here for the sharper version of the same reason** (M11-2 P1.3):
        // every one of them resolves its group through ONE shared private helper, so the export
        // itself names neither the resource nor the gate. That is the shape `reachableBody` exists
        // for, and listing them keeps the scan proving it reaches them.
        expect(inspected).toEqual(
            expect.arrayContaining([
                "upvotePost",
                "downvotePost",
                "createComment",
                "upvoteComment",
                "deletePost",
                "joinGroup",
                "leaveGroup",
                "subscribeToGroup",
                "unsubscribeFromGroup",
                "updateGroupSettings",
                "addModerator",
                "removeModerator",
            ])
        );
    });

    /**
     * The decoy for the widening above, in the exact shape that defeated the narrow scan.
     *
     * A check nobody has seen fire is not evidence, and this one had a live blind spot: both vote
     * actions are two-line wrappers over a private helper, so the export-only scan skipped them
     * silently. The fixture proves the miss now fails — and that the gate is still detected when it
     * IS present one level down, so the widening did not simply make everything pass.
     */
    it("that widening actually detects a wrapper delegating to an ungated helper", () => {
        // Unindented on purpose: `topLevelFunctions` anchors on a declaration at column 0, which is
        // what "top-level" means in a module and what keeps a nested closure out of the map.
        const ungatedModule = [
            "async function castVote(input) {",
            "  const post = await getPost(input.postId);",
            "  return storeUpvotePost(post.id, input.agent.id);",
            "}",
            "export function upvoteThing(input) {",
            "  return castVote(input);",
            "}",
        ].join("\n");
        const gatedModule = ungatedModule.replace(
            "  return storeUpvotePost(post.id, input.agent.id);",
            "  const denial = groupSchoolAccessDenial(input.agent, post); if (denial) return denial;"
        );

        for (const [source, expectedUngated] of [
            [ungatedModule, true],
            [gatedModule, false],
        ] as const) {
            const code = stripNonCode(source);
            const bodies = topLevelFunctions(code);
            const body = reachableBody("upvoteThing", bodies);
            expect(RESOURCE_RESOLVERS.test(body)).toBe(true);
            expect(!/groupSchoolAccessDenial\s*\(/.test(body)).toBe(expectedUngated);
        }

        // And the narrow scan the widening replaced would have seen neither the resource nor the
        // gate — which is precisely why it passed while both vote actions went unchecked.
        const exportOnly = stripNonCode(ungatedModule).slice(
            stripNonCode(ungatedModule).search(/export\s+function\s+upvoteThing/)
        );
        expect(RESOURCE_RESOLVERS.test(exportOnly)).toBe(false);
    });

    it("keeps the read-only exemption list free of entries that no longer resolve a group", () => {
        // A stale exemption is a hole waiting for a handler to be added back under the same name.
        const routeSources = collectFiles(V1_ROOT, (n) => n === "route.ts").map((f) => ({
            rel: relative(V1_ROOT, f),
            code: stripNonCode(readFileSync(f, "utf8")),
        }));
        const toolCode = collectFiles(TOOLS_ROOT, (n) => n.endsWith(".ts"))
            .map((f) => stripNonCode(readFileSync(f, "utf8")))
            .join("\n");

        const stale = Object.keys(READ_ONLY_GROUP_SITES).filter((key) => {
            const [rel] = key.split(":");
            const route = routeSources.find((r) => r.rel === rel);
            if (route) return !RESOURCE_RESOLVERS.test(route.code);
            return !new RegExp(`^ {2}${key}: async `, "m").test(toolCode);
        });
        expect(stale).toEqual([]);
    });
});
