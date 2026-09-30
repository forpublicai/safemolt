/**
 * M11-1C — agent karma has exactly the writers this file enumerates, and no others.
 *
 * The whole chunk rests on one property: every writer that moves `points` also moves the component
 * that owns that movement, so `points = legacy_unattributed_points + vote_points + evaluation_points`
 * stays true. A new writer added later that touches `points` alone breaks the invariant silently —
 * nothing throws, no test that is about something else notices, and the drift is only visible when
 * somebody compares the columns. The invariant deliberately has **no `CHECK` constraint**, because a
 * constraint would turn a future writer bug into a *failed upvote* for a live agent. This scan is
 * what stands in its place, alongside the migration postcondition and the reconciliation.
 *
 * **Both directions count.** The detectors accept a write to `points` OR to any component, because a
 * writer that moves a component alone is exactly as fatal as one that moves the total alone.
 * M11-1b D1's reversal is the concrete case waiting to be written: an
 * `UPDATE agents SET vote_points = vote_points - $delta` that forgets `points` violates the
 * invariant on its first execution.
 *
 * Written in the style of `credential-literal-scan` and `access-gate-inventory`: runnable against an
 * arbitrary tree so its own detection is proved on fixtures. **A scan that has never been seen to
 * fail is not evidence of anything**, so the decoys below run the real `scanKarmaWriters`.
 *
 * **Scope is `src/lib` and `src/app` only, and that is a claim rather than a convenience.** Test
 * fixtures legitimately write `points` directly — `c21-result-uniqueness.test.ts` does
 * `UPDATE agents SET points = 7` to set up a scenario whose subject is C21, not this invariant.
 * Pretending fixtures are writers would either produce noise or push someone to weaken the scan.
 *
 * @jest-environment node
 */
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join, relative } from "path";

const REPO_ROOT = join(__dirname, "..", "..", "..");

export type KarmaWriterKind =
    /** `UPDATE agents [AS] a SET … <karma column> = …` — any alias, any position in the SET list. */
    | "sql-update-agents-karma"
    /** `INSERT INTO agents (… points …)` — creation. */
    | "sql-insert-agents-points"
    /** `agents.set(id, { … points: … })` — the memory store's write. */
    | "memory-agents-set-karma"
    /** `const x: StoredAgent = { … points: … }` — a constructed agent, memory-store creation. */
    | "memory-stored-agent-literal-points"
    /** `agent.points = …` / `agent.votePoints += …` — a mutation that skips `agents.set`. */
    | "in-place-karma-assignment";

export interface KarmaWriterHit {
    file: string;
    line: number;
    kind: KarmaWriterKind;
    text: string;
}

const SCANNED_EXTENSIONS = [".ts", ".tsx"];

/**
 * A karma column assigned in a SQL `SET` list, at top level of the list.
 *
 * **All four columns, not just `points`.** The invariant is
 * `points = legacy_unattributed_points + vote_points + evaluation_points`, and a writer that moves a
 * COMPONENT without moving `points` breaks it exactly as badly as the reverse. M11-1b D1's reversal
 * is the concrete case: `UPDATE agents SET vote_points = vote_points - $delta` that forgets `points`
 * violates the invariant on its first execution, and a scan looking only for bare `points` would
 * report nothing.
 *
 * Word-anchored on purpose: the three component names all END in `points`, so an unanchored match
 * could not tell them apart. The character before the name must be a `SET` keyword or a comma.
 */
const KARMA_COLUMNS = "points|vote_points|evaluation_points|legacy_unattributed_points";
const SET_KARMA_COLUMN = new RegExp(`(?:\\bSET|,)\\s*(?:${KARMA_COLUMNS})\\s*=`, "i");

/**
 * The `agents` table, however it is spelled: bare, schema-qualified, and with either part quoted —
 * `agents`, `public.agents`, `"agents"`, `public."agents"`. A scan that recognised only the bare
 * form would let `UPDATE public.agents SET vote_points = …` through, and "it is written differently"
 * is not a reason for a writer to escape the inventory.
 */
const AGENTS_TABLE = `(?:"?[A-Za-z_][\\w$]*"?\\s*\\.\\s*)?"?agents"?`;

/**
 * Whitespace, or an SQL line comment, or any mix of the two.
 *
 * Load-bearing, and discovered the hard way: a `--` comment placed between `UPDATE agents a` and
 * `SET` made a real karma writer invisible to this scan. A guard that a comment can switch off is
 * not a guard, and the failure mode is silent — the writer simply stops being enumerated.
 */
const GAP = `(?:\\s|--[^\\n]*\\n)*`;

/** `UPDATE agents`, optionally aliased (`UPDATE agents a`, `UPDATE agents AS a`). */
const UPDATE_AGENTS = new RegExp(
    `\\bUPDATE${GAP}${AGENTS_TABLE}(?:${GAP}(?:AS${GAP})?(?!SET\\b)[A-Za-z_][\\w$]*)?${GAP}SET\\b`,
    "gi"
);

/** `INSERT INTO agents (` — the column list follows. */
const INSERT_AGENTS = new RegExp(`\\bINSERT\\s+INTO\\s+${AGENTS_TABLE}\\s*(?=\\()`, "gi");

/** A karma column named in an `INSERT INTO agents (…)` column list. Anchored, so `points_at_join` misses. */
const INSERTED_KARMA_COLUMN = new RegExp(`^(?:${KARMA_COLUMNS})$`, "i");

/** `agents.set(` — the memory store's only way to write an agent row. */
const AGENTS_SET = /\bagents\s*\.\s*set\s*\(/g;

/** `: StoredAgent = {` / `: StoredAgent[] = [` — an annotated construction. */
const STORED_AGENT_LITERAL = /:\s*StoredAgent\b[^=;]*=\s*[{[]/g;

/** A `points:` property at the top level of an object literal. */
const OBJECT_POINTS = /(?:^|[{,])\s*points\s*:/;

/**
 * Any karma property — component or total — at the top level of an object literal.
 *
 * **Shorthand counts.** `const votePoints = agent.votePoints - delta; agents.set(id, {...agent, votePoints})`
 * is ordinary TypeScript and writes karma just as surely as `votePoints: …`; a detector that
 * required the colon would miss it entirely. So the name may be followed by `:` (longhand), `,`
 * (shorthand mid-literal) or the end of the literal body (shorthand last).
 *
 * The trailing check is what keeps `pointsEarned:` and `pointsAtJoin:` out: after `points` comes
 * `E`/`A`, which is none of those. `}` is in the set because this is also run over a whole ARGUMENT
 * list (`id, { ...agent, votePoints }`), where a trailing shorthand is followed by the brace rather
 * than by the end of the string.
 */
const KARMA_FIELDS = "points|votePoints|evaluationPoints|legacyUnattributedPoints";
const OBJECT_KARMA = new RegExp(`(?:^|[{,])\\s*(?:${KARMA_FIELDS})\\s*(?::|,|\\}|$)`);

/**
 * `something.points = …` / `something.votePoints += …`, including the compound forms.
 *
 * The memory store holds live objects, so `agent.points += 1` writes karma without ever calling
 * `agents.set` — a writer the detectors above cannot see. `(?!=)` keeps `===`/`==` out, so a
 * comparison is not mistaken for an assignment.
 *
 * **Bracket access counts too.** `agent["votePoints"] += 1` is the same write spelled differently,
 * and a dot-only detector reports nothing for it — so the one thing this scan exists to prevent, a
 * new writer slipping in unlisted, would slip in. **All three** quote styles: a template literal
 * with no substitution is a constant property name like any other, and omitting it leaves an
 * escape that costs one backtick to use.
 *
 * The `\)*` before the operator covers `(agent.votePoints) += 1` — a parenthesised member
 * expression is a legal assignment target, so the parentheses change nothing about what the line
 * does. It introduces no false positive: a read like `fn(a.points) === b` still fails, because the
 * `(?!=)` after the first `=` rejects `==` and `===`, and no later `=` carries the karma prefix.
 */
const KARMA_ASSIGN_OPERATOR = String.raw`\s*\)*\s*(?:\+|-|\*|\/|\*\*|\?\?|\|\||&&)?=(?!=)`;
const KARMA_BRACKET_KEY = `"(?:${KARMA_FIELDS})"|'(?:${KARMA_FIELDS})'|\`(?:${KARMA_FIELDS})\``;
const IN_PLACE_KARMA = new RegExp(
    `(?:\\.(?:${KARMA_FIELDS})|\\[\\s*(?:${KARMA_BRACKET_KEY})\\s*\\])${KARMA_ASSIGN_OPERATOR}`,
    "g"
);

/** Comment lines carry prose about `points` constantly; the ban is on code. */
function stripCommentLines(source: string): string {
    return source
        .split("\n")
        .filter((line) => {
            const trimmed = line.trim();
            return !trimmed.startsWith("//") && !trimmed.startsWith("*") && !trimmed.startsWith("/*");
        })
        .join("\n");
}

function collectFiles(dir: string, out: string[] = []): string[] {
    for (const entry of readdirSync(dir)) {
        if (entry === "node_modules" || entry === ".next" || entry === "__tests__") continue;
        const full = join(dir, entry);
        if (statSync(full).isDirectory()) collectFiles(full, out);
        else if (SCANNED_EXTENSIONS.some((ext) => entry.endsWith(ext))) out.push(full);
    }
    return out;
}

/**
 * Read a balanced region starting at `open` (`(`, `{` or `[`), respecting nesting, quotes and
 * template literals.
 *
 * Needed because the thing being matched — a `points:` property, or a `points =` assignment — is
 * separated from its opening token by an arbitrary amount of other source, and a line-scoped or
 * regex-only reader walks straight past a multi-line one. Both real writers span many lines.
 */
function readBalanced(source: string, open: number): { body: string; end: number } | null {
    const pairs: Record<string, string> = { "(": ")", "{": "}", "[": "]" };
    const closer = pairs[source[open]];
    if (!closer) return null;
    let depth = 0;
    let quote: string | null = null;
    for (let i = open; i < source.length; i++) {
        const ch = source[i];
        if (quote) {
            if (ch === "\\") { i++; continue; }
            if (ch === quote) quote = null;
            continue;
        }
        if (ch === "'" || ch === '"' || ch === "`") { quote = ch; continue; }
        if (ch === source[open]) depth++;
        else if (ch === closer) {
            depth--;
            if (depth === 0) return { body: source.slice(open + 1, i), end: i };
        }
    }
    return null;
}

/**
 * The end of a SQL statement that began at `start`.
 *
 * A `;` at nesting depth 0, or the end of the tagged template. Bounded, because a bare
 * "next `UPDATE`" heuristic would let one statement's SET list absorb the next statement's.
 */
const SQL_QUOTES = new Set(["'", '"']);

/**
 * Ends the statement: the tagged template's closing backtick, the `)` that closes the call around
 * it, or a `;`. Only reached at paren depth 0 — a `)` that merely closes a nested call is consumed
 * by the depth branch first.
 */
const STATEMENT_TERMINATORS = new Set(["`", ")", ";"]);

function readStatement(source: string, start: number): { body: string; end: number } {
    let depth = 0;
    let quote: string | null = null;
    for (let i = start; i < source.length; i++) {
        const ch = source[i];
        if (quote) {
            if (ch === "\\") i++;
            else if (ch === quote) quote = null;
            continue;
        }
        if (SQL_QUOTES.has(ch)) quote = ch;
        else if (ch === "(") depth++;
        else if (ch === ")" && depth > 0) depth--;
        else if (STATEMENT_TERMINATORS.has(ch)) return { body: source.slice(start, i), end: i };
    }
    return { body: source.slice(start), end: source.length };
}

function normalise(text: string): string {
    return text.replace(/\s+/g, " ").trim();
}

function excerpt(text: string): string {
    const flat = normalise(text);
    return flat.length > 90 ? `${flat.slice(0, 90)}…` : flat;
}

function lineOf(source: string, index: number): number {
    return source.slice(0, index).split("\n").length;
}

type RawHit = { kind: KarmaWriterKind; index: number; text: string };

/** SQL writers: an `UPDATE agents … SET … points =`, and an `INSERT INTO agents (… points …)`. */
function scanSqlWriters(source: string): RawHit[] {
    const found: RawHit[] = [];
    for (const match of source.matchAll(UPDATE_AGENTS)) {
        const { body } = readStatement(source, match.index);
        if (SET_KARMA_COLUMN.test(body)) found.push({ kind: "sql-update-agents-karma", index: match.index, text: body });
    }
    for (const match of source.matchAll(INSERT_AGENTS)) {
        const columns = readBalanced(source, match.index + match[0].length);
        if (!columns) continue;
        const named = columns.body.split(",").map((c) => c.replace(/["`]/g, "").trim());
        // ANY karma column, not just `points`. An `INSERT INTO agents (…, vote_points) VALUES (…, 10)`
        // that leaves `points` at its zero default violates the invariant the moment the row exists.
        if (named.some((column) => INSERTED_KARMA_COLUMN.test(column))) {
            found.push({ kind: "sql-insert-agents-points", index: match.index, text: columns.body });
        }
    }
    return found;
}

/**
 * The object a `agents.set(id, next)` call passes, when `next` is a variable rather than an inline
 * literal.
 *
 * `const next = { ...agent, votePoints: … }; agents.set(id, next);` is the idiom D1's reversal is
 * most likely to reach for, and neither the inline-literal detector nor the annotated-`StoredAgent`
 * detector can see it: the object is bound to a name and carries no type annotation. Resolving the
 * binding is what closes that hole. Returns null when the argument is not a bare identifier or its
 * binding is not an object literal — both of which are then simply not reported, as before.
 */
function boundObjectLiteral(source: string, callArgs: string, callIndex: number): string | null {
    const identifier = callArgs.match(/,\s*([A-Za-z_$][\w$]*)\s*$/)?.[1];
    if (!identifier) return null;
    // Escaped: `$` and `_` are legal in an identifier and `$` is a regex metacharacter, so a
    // perfectly ordinary `const $next = { … }` would otherwise compile to a pattern that matches
    // something else entirely — and silently find nothing.
    const escaped = identifier.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    // EVERY binding of that name in the file, not the first. This is a regex, not a scope
    // resolver, so a file with a clean `const next = {...agent}` in one function and a karma-moving
    // `const next = {...agent, votePoints: …}` in another would otherwise resolve to whichever came
    // first and could miss the real writer. Reporting if ANY binding carries karma biases the scan
    // toward false POSITIVES, which cost a line in the inventory; a false negative costs the
    // invariant.
    // Declarations AND later assignments. `let next = {...agent}; next = {...next, votePoints: …};`
    // is ordinary code and the reassignment is where the karma actually moves; a declaration-only
    // pattern reads the clean first value and reports nothing. The prefix class excludes `=`, the
    // comparison and compound-assignment operators, and `.` (so `a.next = {}` is not attributed to
    // `next`).
    //
    // **Only bindings that PRECEDE the call.** This is still a regex rather than a scope resolver,
    // but source order is the one cheap approximation of scope that removes real false positives:
    // without it, a karma-moving `next = {...}` in a later function makes an earlier, innocent
    // `agents.set(id, next)` report as a writer. It costs nothing in safety — a binding after the
    // call cannot be the value the call passed.
    const bindings = new RegExp(
        `(?:\\b(?:const|let|var)\\s+|[^\\w$.=!<>+\\-*/%&|^])${escaped}\\s*(?::[^=;]+)?=(?!=)\\s*\\{`,
        "g"
    );
    let fallback: string | null = null;
    for (const binding of source.matchAll(bindings)) {
        if (binding.index >= callIndex) break; // matchAll yields in source order
        const body = readBalanced(source, binding.index + binding[0].length - 1)?.body ?? null;
        if (body === null) continue;
        if (OBJECT_KARMA.test(body)) return body;
        fallback = body;
    }
    return fallback;
}

/**
 * Memory-store writers: `agents.set(id, { … <karma field> … })` — inline or via a bound variable —
 * an annotated `StoredAgent` literal, and an in-place `agent.points = …` that would bypass both.
 * Component fields count for the same reason the SQL detector accepts them: moving a component
 * without moving `points` breaks the invariant.
 */
function scanMemoryWriters(source: string): RawHit[] {
    const found: RawHit[] = [];
    for (const match of source.matchAll(AGENTS_SET)) {
        const args = readBalanced(source, match.index + match[0].length - 1);
        if (!args) continue;
        const body = OBJECT_KARMA.test(args.body)
            ? args.body
            : boundObjectLiteral(source, args.body, match.index);
        if (body !== null && OBJECT_KARMA.test(body)) {
            found.push({ kind: "memory-agents-set-karma", index: match.index, text: body });
        }
    }
    for (const match of source.matchAll(STORED_AGENT_LITERAL)) {
        const literal = readBalanced(source, match.index + match[0].length - 1);
        if (literal && OBJECT_POINTS.test(literal.body)) {
            found.push({ kind: "memory-stored-agent-literal-points", index: match.index, text: literal.body });
        }
    }
    for (const match of source.matchAll(IN_PLACE_KARMA)) {
        found.push({
            kind: "in-place-karma-assignment",
            index: match.index,
            text: source.slice(Math.max(0, match.index - 40), match.index + 40),
        });
    }
    return found;
}

export function scanKarmaWriters(roots: string[], repoRoot: string = REPO_ROOT): KarmaWriterHit[] {
    const hits: KarmaWriterHit[] = [];
    for (const root of roots) {
        for (const file of collectFiles(root)) {
            const rel = relative(repoRoot, file);
            const source = stripCommentLines(readFileSync(file, "utf8"));
            for (const { kind, index, text } of [...scanSqlWriters(source), ...scanMemoryWriters(source)]) {
                hits.push({ file: rel, line: lineOf(source, index), kind, text: excerpt(text) });
            }
        }
    }
    return hits.sort((a, b) => `${a.file}:${a.line}`.localeCompare(`${b.file}:${b.line}`));
}

/**
 * The complete writer inventory, one entry per site, each with the component it owns.
 *
 * Adding a writer means adding a line here, which is a visible diff to an invariant-critical list —
 * and the person adding it has to answer "which component does this move?" in writing.
 */
const KARMA_WRITERS: Array<{ file: string; kind: KarmaWriterKind; owns: string }> = [
    {
        file: "src/lib/store/agents/db.ts",
        kind: "sql-insert-agents-points",
        owns: "creation — initialises points and all three components to 0",
    },
    {
        file: "src/lib/store/agents/db.ts",
        kind: "sql-update-agents-karma",
        owns: "evaluation_points, in C14's fixed vetting batch (delta form, live-challenge gated)",
    },
    {
        file: "src/lib/store/agents/db.ts",
        kind: "memory-stored-agent-literal-points",
        owns: "creation — the StoredAgent returned by createAgent, mirroring the INSERT above",
    },
    {
        file: "src/lib/store/agents/memory.ts",
        kind: "memory-stored-agent-literal-points",
        owns: "creation — initialises points and all three components to 0",
    },
    {
        file: "src/lib/store/agents/memory.ts",
        kind: "memory-agents-set-karma",
        owns:
            "creation — the SAME site as the literal above, seen a second time because `createAgent` " +
            "binds the object to a name and then calls `agents.set(id, agent)`. Listed rather than " +
            "deduplicated: a scan that collapses two hits into one can also collapse away a real " +
            "second writer, and the redundancy costs one line here",
    },
    {
        file: "src/lib/store/comments/db.ts",
        kind: "sql-update-agents-karma",
        owns: "vote_points, comment upvote (atomic, records points_delta)",
    },
    {
        file: "src/lib/store/comments/memory.ts",
        kind: "memory-agents-set-karma",
        owns: "vote_points, comment upvote (one synchronous section)",
    },
    {
        file: "src/lib/store/evaluations/db.ts",
        kind: "sql-update-agents-karma",
        owns: "evaluation_points, the recompute (delta form)",
    },
    {
        file: "src/lib/store/evaluations/memory.ts",
        kind: "memory-agents-set-karma",
        owns: "evaluation_points, the recompute (delta form)",
    },
    {
        file: "src/lib/store/posts/db.ts",
        kind: "sql-update-agents-karma",
        owns: "vote_points, post upvote (atomic, records points_delta)",
    },
    {
        file: "src/lib/store/posts/db.ts",
        kind: "sql-update-agents-karma",
        owns: "vote_points, post downvote (atomic, records points_delta)",
    },
    {
        file: "src/lib/store/posts/db.ts",
        kind: "sql-update-agents-karma",
        owns:
            "vote_points, M11-1b D1's deletion REVERSAL — the only writer that subtracts. It reverses " +
            "the recorded `points_delta` of the deleted post's votes and of its comments' votes, so it " +
            "gives back exactly what was awarded; rows with a NULL delta predate M11-1C, their award " +
            "is unknowable, and they are excluded rather than guessed at",
    },
    {
        file: "src/lib/store/posts/memory.ts",
        kind: "memory-agents-set-karma",
        owns: "vote_points, post upvote and downvote (one synchronous section)",
    },
    {
        file: "src/lib/store/posts/memory.ts",
        kind: "memory-agents-set-karma",
        owns: "vote_points, M11-1b D1's deletion reversal (one synchronous section) — mirrors the db statement above",
    },
];

function inventoryKey(hit: { file: string; kind: KarmaWriterKind }): string {
    return `${hit.file} :: ${hit.kind}`;
}

describe("the scanner detects what it claims to detect", () => {
    let fixtureDir: string;

    beforeEach(() => {
        fixtureDir = mkdtempSync(join(tmpdir(), "karma-writer-scan-"));
    });

    afterEach(() => rmSync(fixtureDir, { recursive: true, force: true }));

    // The decoy. Without this, a green run over a clean repository would prove only that the
    // regexes never matched anything — including the writers they exist to find.
    it("fails when a new SQL writer is added", () => {
        writeFileSync(
            join(fixtureDir, "rogue.ts"),
            "export async function reward(id: string) {\n" +
                "  await sql`UPDATE agents SET points = points + 10 WHERE id = ${id}`;\n" +
                "}\n"
        );
        const hits = scanKarmaWriters([fixtureDir], fixtureDir);
        expect(hits.map((h) => h.kind)).toEqual(["sql-update-agents-karma"]);
    });

    it("fails when a new memory writer is added", () => {
        writeFileSync(
            join(fixtureDir, "rogue-memory.ts"),
            "export function reward(id: string) {\n" +
                "  const agent = agents.get(id)!;\n" +
                "  agents.set(id, { ...agent, points: agent.points + 10 });\n" +
                "}\n"
        );
        const hits = scanKarmaWriters([fixtureDir], fixtureDir);
        expect(hits.map((h) => h.kind)).toEqual(["memory-agents-set-karma"]);
    });

    it("finds an aliased UPDATE, which is the shape the atomic vote statement uses", () => {
        writeFileSync(
            join(fixtureDir, "aliased.ts"),
            "const q = sql`\n  UPDATE agents a\n  SET points      = l.points + l.delta,\n" +
                "      vote_points = l.vote_points + l.delta\n  FROM locked l WHERE a.id = l.id`;\n"
        );
        expect(scanKarmaWriters([fixtureDir], fixtureDir).map((h) => h.kind)).toEqual([
            "sql-update-agents-karma",
        ]);
    });

    it("finds one whose SET is separated from the table by a COMMENT", () => {
        // The blind spot this closes: a `--` comment between `UPDATE agents a` and `SET` used to
        // hide the writer entirely, so an author could switch the guard off without meaning to.
        writeFileSync(
            join(fixtureDir, "commented.ts"),
            "const q = sql`\n  UPDATE agents a\n  -- one floored amount, applied to both columns\n" +
                "  SET points      = a.points + 1,\n      vote_points = a.vote_points + 1\n  WHERE a.id = ${id}`;\n"
        );
        expect(scanKarmaWriters([fixtureDir], fixtureDir).map((h) => h.kind)).toEqual([
            "sql-update-agents-karma",
        ]);
    });

    it("finds one whose points assignment is not first in the SET list", () => {
        // The evaluation writer assigns `evaluation_points` first. A scan anchored on `SET points`
        // touching the keyword would miss every writer shaped like the one this chunk introduces.
        writeFileSync(
            join(fixtureDir, "second.ts"),
            "const q = sql`UPDATE agents SET evaluation_points = 1, points = points + 1 WHERE id = ${id}`;\n"
        );
        expect(scanKarmaWriters([fixtureDir], fixtureDir).map((h) => h.kind)).toEqual([
            "sql-update-agents-karma",
        ]);
    });

    it("fails when a writer mutates points in place, bypassing agents.set", () => {
        // The memory store holds live objects, so this writes karma without any `agents.set` call
        // for the other detectors to see.
        writeFileSync(
            join(fixtureDir, "in-place.ts"),
            "export function reward(agent: StoredAgent) {\n  agent.points += 10;\n  agent.points = 0;\n}\n"
        );
        expect(scanKarmaWriters([fixtureDir], fixtureDir).map((h) => h.kind)).toEqual([
            "in-place-karma-assignment",
            "in-place-karma-assignment",
        ]);
    });

    it("fires on a BRACKET-property karma write, which a dot-only detector misses", () => {
        // `agent["votePoints"] += 1` is `agent.votePoints += 1` spelled differently and breaks the
        // invariant identically — it moves a component without moving `points`. A scan that reads
        // only dot access reports nothing, which is precisely the failure this suite exists to
        // prevent: a new writer landing unlisted.
        writeFileSync(
            join(fixtureDir, "bracket.ts"),
            'export function reward(agent: StoredAgent) {\n' +
                '  agent["votePoints"] += 1;\n' +
                "  agent['points'] = 0;\n" +
                "}\n"
        );
        expect(scanKarmaWriters([fixtureDir], fixtureDir).map((h) => h.kind)).toEqual([
            "in-place-karma-assignment",
            "in-place-karma-assignment",
        ]);
    });

    it("fires on the two spellings that escaped the first bracket detector", () => {
        // Found by re-review, not by imagination. A template-literal key with no substitution is a
        // constant property name, and a parenthesised member expression is a legal assignment
        // target — both write karma, and both read as ordinary code in a diff.
        writeFileSync(
            join(fixtureDir, "escapes.ts"),
            "export function reward(agent: StoredAgent) {\n" +
                "  agent[`votePoints`] += 1;\n" +
                "  (agent.points) += 1;\n" +
                "}\n"
        );
        expect(scanKarmaWriters([fixtureDir], fixtureDir).map((h) => h.kind)).toEqual([
            "in-place-karma-assignment",
            "in-place-karma-assignment",
        ]);
    });

    it("does NOT mistake a parenthesised points READ for a write", () => {
        // The `\\)*` that catches `(agent.points) += 1` must not turn every `fn(a.points) === b`
        // into a writer; `(?!=)` is what keeps `==`/`===` out.
        writeFileSync(
            join(fixtureDir, "paren-read.ts"),
            "export const same = (a: StoredAgent, b: StoredAgent) =>\n" +
                "  Math.max(a.points) === Math.max(b.points) || Number(a.votePoints) == 0;\n"
        );
        expect(scanKarmaWriters([fixtureDir], fixtureDir)).toEqual([]);
    });

    it("does NOT mistake a bracket points READ for a write", () => {
        writeFileSync(
            join(fixtureDir, "bracket-read.ts"),
            'export const total = (a: StoredAgent) => a["points"] + a["votePoints"];\n'
        );
        expect(scanKarmaWriters([fixtureDir], fixtureDir)).toEqual([]);
    });

    it("does NOT mistake a points comparison for an assignment", () => {
        writeFileSync(
            join(fixtureDir, "compare-points.ts"),
            "export const same = (a: StoredAgent, b: StoredAgent) => a.points === b.points || a.points == 0;\n"
        );
        expect(scanKarmaWriters([fixtureDir], fixtureDir)).toEqual([]);
    });

    it("fires on a COMPONENT-only write, which breaks the invariant just as badly", () => {
        // The concrete case is M11-1b D1's reversal: `SET vote_points = vote_points - $delta` that
        // forgets `points` violates `points = legacy + vote + evaluation` on its first execution.
        // A scan looking only for a bare `points` assignment would report nothing at all.
        writeFileSync(
            join(fixtureDir, "components.ts"),
            "const a = sql`UPDATE agents SET vote_points = vote_points - ${delta} WHERE id = ${id}`;\n" +
                "const b = sql`UPDATE agents SET evaluation_points = 3 WHERE id = ${id}`;\n" +
                "const c = sql`UPDATE agents SET legacy_unattributed_points = 0 WHERE id = ${id}`;\n"
        );
        expect(scanKarmaWriters([fixtureDir], fixtureDir).map((h) => h.kind)).toEqual([
            "sql-update-agents-karma",
            "sql-update-agents-karma",
            "sql-update-agents-karma",
        ]);
    });

    it("fires when the object is bound to a variable first — the D1 reversal idiom", () => {
        // `const next = { ...agent, votePoints: … }; agents.set(id, next);` is the shape a reversal
        // writer is most likely to take, and it is invisible to both the inline-literal detector
        // and the annotated-`StoredAgent` detector.
        writeFileSync(
            join(fixtureDir, "bound.ts"),
            "export function reverse(id: string, delta: number) {\n" +
                "  const agent = agents.get(id)!;\n" +
                "  const next = { ...agent, votePoints: agent.votePoints - delta };\n" +
                "  agents.set(id, next);\n" +
                "}\n"
        );
        expect(scanKarmaWriters([fixtureDir], fixtureDir).map((h) => h.kind)).toEqual([
            "memory-agents-set-karma",
        ]);
    });

    it("fires on a SHORTHAND karma property", () => {
        // `const votePoints = …; agents.set(id, { ...agent, votePoints })` writes karma without ever
        // spelling `votePoints:`. A detector that required the colon would miss it.
        writeFileSync(
            join(fixtureDir, "shorthand.ts"),
            "export function reverse(id: string, delta: number) {\n" +
                "  const agent = agents.get(id)!;\n" +
                "  const votePoints = agent.votePoints - delta;\n" +
                "  agents.set(id, { ...agent, votePoints });\n" +
                "}\n"
        );
        expect(scanKarmaWriters([fixtureDir], fixtureDir).map((h) => h.kind)).toEqual([
            "memory-agents-set-karma",
        ]);
    });

    it("resolves the karma-carrying binding even when a clean one of the same name comes first", () => {
        // The resolver is a regex, not a scope resolver. Taking the FIRST binding would resolve
        // `next` to the clean one in `touch` and miss the reversal entirely.
        writeFileSync(
            join(fixtureDir, "shadowed.ts"),
            "export function touch(id: string) {\n" +
                "  const next = { ...agents.get(id)!, lastActiveAt: now };\n" +
                "  agents.set(id, next);\n" +
                "}\n" +
                "export function reverse(id: string, delta: number) {\n" +
                "  const next = { ...agents.get(id)!, votePoints: 0 - delta };\n" +
                "  agents.set(id, next);\n" +
                "}\n"
        );
        // Exactly ONE hit: `reverse`'s. `touch`'s call is preceded only by the clean binding, so
        // resolving in source order correctly leaves it alone — reporting it would be a false
        // positive that pushes an innocent setter into the inventory.
        const hits = scanKarmaWriters([fixtureDir], fixtureDir);
        expect(hits.map((h) => h.kind)).toEqual(["memory-agents-set-karma"]);
        expect(hits[0].text).toContain("votePoints");
    });

    it("does NOT attribute a LATER karma binding to an earlier innocent setter", () => {
        // Source order is the cheap approximation of scope. A binding that appears after the call
        // cannot be the value the call passed.
        writeFileSync(
            join(fixtureDir, "later.ts"),
            "export function touch(id: string) {\n" +
                "  const next = { ...agents.get(id)!, lastActiveAt: now };\n" +
                "  agents.set(id, next);\n" +
                "}\n" +
                "export function elsewhere() {\n" +
                "  let next = { a: 1 };\n" +
                "  next = { ...next, points: 1 };\n" +
                "  return next;\n" +
                "}\n"
        );
        expect(scanKarmaWriters([fixtureDir], fixtureDir)).toEqual([]);
    });

    it("finds a binding whose name contains regex metacharacters", () => {
        // `$` is legal in an identifier and is a regex metacharacter. Unescaped, the pattern
        // compiles to something that matches nothing and the writer disappears.
        writeFileSync(
            join(fixtureDir, "dollar.ts"),
            "const $next = { ...agent, votePoints: 1 };\nagents.set(id, $next);\n"
        );
        expect(scanKarmaWriters([fixtureDir], fixtureDir).map((h) => h.kind)).toEqual([
            "memory-agents-set-karma",
        ]);
    });

    it("finds a schema-qualified or quoted UPDATE", () => {
        // `UPDATE public.agents SET vote_points = …` is the same writer written differently, and
        // "spelled another way" is not a reason to escape the inventory.
        writeFileSync(
            join(fixtureDir, "qualified.ts"),
            "const a = sql`UPDATE public.agents SET vote_points = vote_points + 1 WHERE id = ${id}`;\n" +
                'const b = sql`UPDATE "agents" SET points = 0 WHERE id = ${id}`;\n' +
                "const c = sql`INSERT INTO public.agents (id, vote_points) VALUES (${id}, 1)`;\n"
        );
        expect(scanKarmaWriters([fixtureDir], fixtureDir).map((h) => h.kind)).toEqual([
            "sql-update-agents-karma",
            "sql-update-agents-karma",
            "sql-insert-agents-points",
        ]);
    });

    it("follows a REASSIGNMENT, not only the declaration", () => {
        // `let next = {...agent}; next = {...next, votePoints: …}; agents.set(id, next)` — the
        // declaration is clean and the reassignment is where the karma moves.
        writeFileSync(
            join(fixtureDir, "reassigned.ts"),
            "export function reverse(id: string, delta: number) {\n" +
                "  let next = { ...agents.get(id)! };\n" +
                "  next = { ...next, votePoints: next.votePoints - delta };\n" +
                "  agents.set(id, next);\n" +
                "}\n"
        );
        expect(scanKarmaWriters([fixtureDir], fixtureDir).map((h) => h.kind)).toEqual([
            "memory-agents-set-karma",
        ]);
    });

    it("fires on an INSERT that names a component but not points", () => {
        // `INSERT INTO agents (…, vote_points) VALUES (…, 10)` leaves `points` at its zero default
        // and violates the invariant the moment the row exists.
        writeFileSync(
            join(fixtureDir, "insert-component.sql.ts"),
            "const q = sql`INSERT INTO agents (id, name, vote_points) VALUES (${id}, ${name}, 10)`;\n"
        );
        expect(scanKarmaWriters([fixtureDir], fixtureDir).map((h) => h.kind)).toEqual([
            "sql-insert-agents-points",
        ]);
    });

    it("does NOT fire on an INSERT naming a similarly-spelled non-karma column", () => {
        writeFileSync(
            join(fixtureDir, "insert-other.ts"),
            "const q = sql`INSERT INTO agents (id, name, points_at_join) VALUES (${id}, ${name}, 0)`;\n"
        );
        expect(scanKarmaWriters([fixtureDir], fixtureDir)).toEqual([]);
    });

    it("does NOT fire when the bound object touches no karma field", () => {
        writeFileSync(
            join(fixtureDir, "bound-clean.ts"),
            "const next = { ...agent, isVetted: true, identityMd };\nagents.set(id, next);\n"
        );
        expect(scanKarmaWriters([fixtureDir], fixtureDir)).toEqual([]);
    });

    it("fires on a component-only memory write too", () => {
        writeFileSync(
            join(fixtureDir, "component-memory.ts"),
            "agents.set(id, { ...agent, votePoints: agent.votePoints - delta });\n" +
                "other.evaluationPoints += 3;\n"
        );
        expect(scanKarmaWriters([fixtureDir], fixtureDir).map((h) => h.kind)).toEqual([
            "memory-agents-set-karma",
            "in-place-karma-assignment",
        ]);
    });

    it("counts a SET list touching several karma columns as ONE writer", () => {
        // The real vote statement assigns `points` and `vote_points` together. Reporting it twice
        // would make the inventory list every writer twice and hide a genuine second one.
        writeFileSync(
            join(fixtureDir, "both.ts"),
            "const q = sql`UPDATE agents a SET points = l.points + l.delta, vote_points = l.vote_points + l.delta FROM locked l WHERE a.id = l.id`;\n"
        );
        expect(scanKarmaWriters([fixtureDir], fixtureDir)).toHaveLength(1);
    });

    it("does NOT fire on a different table's points, or on a read", () => {
        writeFileSync(
            join(fixtureDir, "elsewhere.ts"),
            "const a = sql`UPDATE groups SET points = COALESCE(points, 0) + ${delta} WHERE id = ${id}`;\n" +
                "const b = sql`SELECT points FROM agents WHERE id = ${id}`;\n" +
                "const c = { points: agent.points };\n" +
                "groups.set(id, { ...group, points: 5 });\n"
        );
        expect(scanKarmaWriters([fixtureDir], fixtureDir)).toEqual([]);
    });

    it("does NOT fire on an agents.set that leaves points alone", () => {
        // `setAgentVetted` and friends rewrite the row without touching karma. Reporting those
        // would drown the inventory in sites that are not writers.
        writeFileSync(
            join(fixtureDir, "untouched.ts"),
            "agents.set(agentId, { ...agent, isVetted: true, identityMd });\n"
        );
        expect(scanKarmaWriters([fixtureDir], fixtureDir)).toEqual([]);
    });

    it("does NOT fire on prose that mentions points", () => {
        writeFileSync(
            join(fixtureDir, "prose.ts"),
            "// UPDATE agents SET points = points + 1 was the old writer\n" +
                "/**\n * agents.set(id, { ...agent, points: 0 })\n */\nexport const x = 1;\n"
        );
        expect(scanKarmaWriters([fixtureDir], fixtureDir)).toEqual([]);
    });

    it("walks subdirectories and skips __tests__", () => {
        mkdirSync(join(fixtureDir, "nested", "__tests__"), { recursive: true });
        writeFileSync(
            join(fixtureDir, "nested", "writer.ts"),
            "const q = sql`UPDATE agents SET points = 0 WHERE id = ${id}`;\n"
        );
        writeFileSync(
            join(fixtureDir, "nested", "__tests__", "fixture.ts"),
            "const q = sql`UPDATE agents SET points = 7 WHERE id = ${id}`;\n"
        );
        expect(scanKarmaWriters([fixtureDir], fixtureDir).map((h) => h.file)).toEqual([
            join("nested", "writer.ts"),
        ]);
    });
});

describe("the inventory is exactly the enumerated writers", () => {
    it("finds every enumerated site and nothing else under src/lib and src/app", () => {
        const hits = scanKarmaWriters([join(REPO_ROOT, "src", "lib"), join(REPO_ROOT, "src", "app")]);
        // Compared as sorted multisets of `file :: kind`, so two writers of the same kind in one
        // file (the post upvote and downvote statements) both have to be present.
        expect(hits.map(inventoryKey).sort()).toEqual(KARMA_WRITERS.map(inventoryKey).sort());
    });

    it("names the component every writer owns", () => {
        for (const writer of KARMA_WRITERS) {
            expect([inventoryKey(writer), writer.owns.length > 0]).toEqual([inventoryKey(writer), true]);
        }
    });
});
