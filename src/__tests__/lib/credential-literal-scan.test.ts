/**
 * M11-1 C24 — a credential-shaped source scan.
 *
 * C19's scan looked for three naming prefixes (`safemolt_*`, `claim_*`, `reef-*`). It could never
 * have found a credential named `foundation-api-key`, which is exactly why that one sat in the
 * repository and in the production database for months. This scan looks for the *shape* instead:
 * a string literal standing where an api key or token belongs.
 *
 * The scan is written to be runnable against an arbitrary tree so its own detection can be proved
 * on a fixture, rather than asserted by a green run over a clean repository — a scan that has
 * never been seen to fail is not evidence of anything.
 *
 * @jest-environment node
 */
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join, relative } from "path";

const REPO_ROOT = join(__dirname, "..", "..", "..");

/**
 * A literal assigned to, or passed as, something credential-shaped.
 *
 * Deliberately not anchored on any naming convention: the point is to catch a value whose *role*
 * is a credential regardless of what it is called.
 */
/**
 * Identifiers whose value is a credential, wherever one of them appears.
 *
 * Widened in review round 4: the set was `api_key`/`secret`/`bearer`/`claim_token`, which left
 * `const token = "…"`, `const AUTH_TOKEN = "…"` and `password` uncovered — a scan that finds a
 * credential only when it is *named* like the one that leaked is a scan calibrated to the last
 * incident. `token` on its own is included deliberately, and the exemptions below record the
 * legitimate hits that produces rather than narrowing the pattern back until they disappear.
 */
const CREDENTIAL_IDENTIFIER = /api_?key|apiKey|secret|bearer|claim_?token|claimToken|auth_?token|authToken|\btoken|password|passwd|credential/;

const CREDENTIAL_LITERAL_PATTERNS: Array<{ name: string; regex: RegExp }> = [
    {
        // `\s` rather than a same-line class: `const apiKey =\n  "literal"` is ordinary
        // formatting, and a line-scoped scan would have walked straight past it.
        //
        // The optional quote after the identifier covers a quoted object key —
        // `{ "api_key": "literal" }` — which is how a credential appears in JSON-shaped source and
        // which the unquoted form silently missed.
        name: "literal assigned to an api-key/token identifier",
        regex: new RegExp(`\\b(${CREDENTIAL_IDENTIFIER.source})['"\`]?\\s*[:=]\\s*['"\`][^'"\`]{8,}['"\`]`, "i"),
    },
    {
        // Third positional argument of createProfessor is the api key. Newlines allowed for the
        // same reason as above — a multi-line call is the normal way to write this.
        name: "literal in a credential argument position",
        regex: /\bcreateProfessor\s*\(\s*(?:[^,()]+,\s*){2}['"`][^'"`$]+['"`]/,
    },
    {
        // A credential *compared* against a literal is a hardcoded credential just as much as one
        // assigned from it — `if (apiKey === "foundation-api-key")` is the shape a published bearer
        // takes once someone moves the check out of the database.
        name: "credential compared against a literal",
        regex: new RegExp(`\\b(${CREDENTIAL_IDENTIFIER.source})['"\`]?\\s*[=!]==?\\s*['"\`][^'"\`]{8,}['"\`]`, "i"),
    },
];

/**
 * Values that look credential-shaped but are not credentials.
 *
 * Each entry is a claim a human made and a reviewer can check. Keeping the list here rather than
 * loosening a pattern means widening the exemption is a visible diff.
 */
const NOT_A_CREDENTIAL = [
    /process\.env\./, // reading configuration is the correct shape
    /Bearer <api_key>/, // documentation and error hints
    /Bearer \*\*\*/,
    /[:=]\s*`[^`]*\$\{/, // a template with interpolation is constructed, not a literal
    /gen_random_bytes|encode\(/, // SQL generating a credential rather than stating one
];

/**
 * Files allowed to contain a credential literal, each with the reason and its exit condition.
 *
 * An exemption list is the honest shape here. The alternative — narrowing the patterns until these
 * stop matching — would weaken the scan for every other file too.
 */
const SCAN_EXEMPTIONS: Record<string, string> = {
    "scripts/migrate-rotate-published-professor-keys.sql":
        "must name the literal it rotates; the predicate IS the remediation (M11-1 C24)",
    "scripts/migrate-ao-seed-moiraine.sql":
        "seeds a structurally disabled demo credential (disabled_ prefix) that getAgentFromRequest refuses before any lookup (M11-1 C19) — non-authenticating by construction",
    "scripts/migrate-neutralize-seeded-credentials.sql":
        "must name the dead literals it rewrites; the predicate IS the remediation (M11-1 C19), same shape as the professor rotation above",
};

function stripCommentLines(source: string): string {
    return source
        .split("\n")
        .filter((line) => {
            const trimmed = line.trim();
            return !trimmed.startsWith("//") && !trimmed.startsWith("*") && !trimmed.startsWith("/*");
        })
        .join("\n");
}

/**
 * `.sql` is in the list deliberately. C19's scan looked only at naming prefixes in TypeScript and
 * so could not have seen a credential seeded by a migration — which is exactly where one is.
 */
const SCANNED_EXTENSIONS = [".ts", ".tsx", ".js", ".mjs", ".sql"];

function collectFiles(dir: string, extensions: string[], out: string[] = []): string[] {
    for (const entry of readdirSync(dir)) {
        if (entry === "node_modules" || entry === ".next" || entry === "__tests__") continue;
        const full = join(dir, entry);
        if (statSync(full).isDirectory()) collectFiles(full, extensions, out);
        else if (extensions.some((ext) => entry.endsWith(ext))) out.push(full);
    }
    return out;
}

/** SQL uses `--` for line comments; the ban is on code, not on prose that explains it. */
function stripSqlComments(source: string): string {
    return source
        .split("\n")
        .filter((line) => !line.trim().startsWith("--"))
        .join("\n");
}

export interface CredentialLiteralHit {
    file: string;
    line: number;
    pattern: string;
    text: string;
}

const SQL_INSERT_PATTERN = "credential column given a literal by an INSERT";

/** Read a parenthesised group starting at `open`, respecting nesting and quotes. */
function readBalanced(source: string, open: number): { body: string; end: number } | null {
    if (source[open] !== "(") return null;
    let depth = 0;
    let quote: string | null = null;
    for (let i = open; i < source.length; i++) {
        const ch = source[i];
        if (quote) {
            if (ch === quote) quote = null;
            continue;
        }
        if (ch === "'" || ch === '"') quote = ch;
        else if (ch === "(") depth++;
        else if (ch === ")") {
            depth--;
            if (depth === 0) return { body: source.slice(open + 1, i), end: i };
        }
    }
    return null;
}

/** Split a tuple body on top-level commas — `encode(gen_random_bytes(32), 'hex')` is ONE value. */
function splitTopLevel(body: string): string[] {
    const parts: string[] = [];
    let depth = 0;
    let quote: string | null = null;
    let current = "";
    for (const ch of body) {
        if (quote) {
            current += ch;
            if (ch === quote) quote = null;
            continue;
        }
        if (ch === "'" || ch === '"') quote = ch;
        else if (ch === "(") depth++;
        else if (ch === ")") depth--;
        else if (ch === "," && depth === 0) {
            parts.push(current.trim());
            current = "";
            continue;
        }
        current += ch;
    }
    if (current.trim()) parts.push(current.trim());
    return parts;
}

/** Clauses that end an `INSERT … SELECT` select list at nesting depth 0. */
const SELECT_LIST_TERMINATORS = /\b(FROM|WHERE|ON\s+CONFLICT|RETURNING|GROUP\s+BY|ORDER\s+BY|LIMIT|UNION)\b/iy;

/**
 * Read the select list of an `INSERT … SELECT`, from just after `SELECT` to its first top-level
 * terminating clause (or the statement's end).
 */
function startsTerminatingClause(source: string, i: number): boolean {
    if (!/[A-Za-z]/.test(source[i])) return false;
    if (/[\w$]/.test(source[i - 1] ?? " ")) return false; // mid-identifier, not a keyword
    SELECT_LIST_TERMINATORS.lastIndex = i;
    return SELECT_LIST_TERMINATORS.exec(source) !== null;
}

function readSelectList(source: string, start: number): { body: string; end: number } {
    let depth = 0;
    let quote: string | null = null;
    for (let i = start; i < source.length; i++) {
        const ch = source[i];
        if (quote) {
            if (ch === quote) quote = null;
            continue;
        }
        if (ch === "'" || ch === '"') {
            quote = ch;
            continue;
        }
        if (ch === "(") depth += 1;
        else if (ch === ")") depth -= 1;
        else if (depth === 0 && (ch === ";" || startsTerminatingClause(source, i))) {
            return { body: source.slice(start, i), end: i };
        }
    }
    return { body: source.slice(start), end: source.length };
}

/**
 * Find a credential column that an `INSERT` fills with a quoted literal.
 *
 * The assignment patterns above cannot see this shape at all: in
 * `INSERT INTO agents (name, api_key) VALUES ('demo', 'literal')` the identifier `api_key` is
 * followed by `)`, not by `=` or `:`, so nothing matches — and a *seeded* credential is precisely
 * the case this scan exists for. C19's scan missed the Foundation professor key for the same
 * reason: it was looking at the wrong shape.
 *
 * **Both insert forms, because this repository's one real seeded credential uses the second.**
 * `scripts/migrate-ao-seed-moiraine.sql` is `INSERT INTO agents (…) SELECT … WHERE NOT EXISTS (…)`
 * — the idempotent upsert pattern — so a detector that understood only `VALUES` would have
 * reproduced the original blind spot in a new place while its fixtures went green.
 *
 * Positional rather than a single regex, because the column and its value are separated by the
 * whole column list. Splitting is paren- and quote-aware so a value like
 * `encode(gen_random_bytes(32), 'hex')` counts as one item and stays aligned with its column.
 */
function sqlInsertCredentialHits(source: string): Array<{ index: number; text: string }> {
    const hits: Array<{ index: number; text: string }> = [];
    const insert = /\bINSERT\s+INTO\s+[\w."]+\s*(?=\()/gi;
    const identifier = new RegExp(`^${CREDENTIAL_IDENTIFIER.source}$`, "i");
    let match: RegExpExecArray | null;

    while ((match = insert.exec(source)) !== null) {
        const columns = readBalanced(source, match.index + match[0].length);
        if (!columns) continue;

        const valuesKeyword = /\s*VALUES\s*(?=\()/iy;
        valuesKeyword.lastIndex = columns.end + 1;
        const selectKeyword = /\s*SELECT\s+/iy;
        selectKeyword.lastIndex = columns.end + 1;

        let valueBody: string | null = null;
        if (valuesKeyword.exec(source)) {
            valueBody = readBalanced(source, valuesKeyword.lastIndex)?.body ?? null;
        } else if (selectKeyword.exec(source)) {
            valueBody = readSelectList(source, selectKeyword.lastIndex).body;
        }
        if (valueBody === null) continue;

        const columnNames = splitTopLevel(columns.body).map((c) => c.replace(/["`]/g, "").trim());
        const valueExprs = splitTopLevel(valueBody);

        columnNames.forEach((column, i) => {
            if (!identifier.test(column)) return;
            const value = valueExprs[i];
            // Only a bare quoted literal is a finding. A parameter (`$1`), a call
            // (`gen_random_bytes`), or anything computed is the correct shape and must not fire.
            if (!value || !/^'[^']{8,}'$/.test(value)) return;
            hits.push({
                index: match!.index,
                text: `${source.slice(match!.index, match!.index + 40).replace(/\s+/g, " ").trim()}… ${column} => ${value}`,
            });
        });
    }
    return hits;
}

export function scanTree(roots: string[], repoRoot: string = REPO_ROOT): CredentialLiteralHit[] {
    const hits: CredentialLiteralHit[] = [];
    for (const root of roots) {
        for (const file of collectFiles(root, SCANNED_EXTENSIONS)) {
            const rel = relative(repoRoot, file);
            if (SCAN_EXEMPTIONS[rel] !== undefined) continue;
            const source = stripSqlComments(stripCommentLines(readFileSync(file, "utf8")));
            // Matched over the whole file, not line by line: the patterns tolerate newlines
            // between the identifier, the assignment and the literal.
            for (const { name, regex } of CREDENTIAL_LITERAL_PATTERNS) {
                const global = new RegExp(regex.source, `${regex.flags.replace("g", "")}g`);
                let match: RegExpExecArray | null;
                while ((match = global.exec(source)) !== null) {
                    const text = match[0].replace(/\s+/g, " ").trim();
                    if (NOT_A_CREDENTIAL.some((allowed) => allowed.test(match![0]))) continue;
                    const line = source.slice(0, match.index).split("\n").length;
                    hits.push({ file: rel, line, pattern: name, text });
                }
            }
            for (const { index, text } of sqlInsertCredentialHits(source)) {
                if (NOT_A_CREDENTIAL.some((allowed) => allowed.test(text))) continue;
                hits.push({
                    file: rel,
                    line: source.slice(0, index).split("\n").length,
                    pattern: SQL_INSERT_PATTERN,
                    text,
                });
            }
        }
    }
    return hits;
}

describe("the scan detects what it claims to detect", () => {
    it("flags a literal passed where the Foundation professor key used to be", () => {
        const offending = `await createProfessor('Foundation Professor', 'foundation@safemolt.com', 'foundation-api-key', profId);`;
        expect(
            CREDENTIAL_LITERAL_PATTERNS.some((p) => p.regex.test(offending))
        ).toBe(true);
    });

    it("flags a literal assigned to an api-key identifier", () => {
        expect(
            CREDENTIAL_LITERAL_PATTERNS.some((p) => p.regex.test(`const apiKey = "safemolt_static_value";`))
        ).toBe(true);
    });

    it("does not flag configuration reads or documentation hints", () => {
        const benign = [
            `const apiKey = process.env.FOUNDATION_PROFESSOR_API_KEY;`,
            `return errorResponse("Unauthorized", "Valid Authorization: Bearer <api_key> required", 401);`,
        ];
        for (const line of benign) {
            const flagged =
                CREDENTIAL_LITERAL_PATTERNS.some((p) => p.regex.test(line)) &&
                !NOT_A_CREDENTIAL.some((allowed) => allowed.test(line));
            expect([line, flagged]).toEqual([line, false]);
        }
    });
});

describe("the scanner itself is exercised, not just its regexes", () => {
    // A green run over a clean repository proves nothing about a scanner that was never seen to
    // fire. These run the real `scanTree` over a fixture tree.
    let fixtureDir: string;

    beforeEach(() => {
        fixtureDir = mkdtempSync(join(tmpdir(), "credential-scan-"));
    });

    afterEach(() => rmSync(fixtureDir, { recursive: true, force: true }));

    it("finds a literal in TypeScript", () => {
        writeFileSync(join(fixtureDir, "leak.ts"), `const apiKey = "safemolt_static_value";\n`);
        expect(scanTree([fixtureDir], fixtureDir)).toHaveLength(1);
    });

    it("finds one split across lines, which is ordinary formatting", () => {
        writeFileSync(
            join(fixtureDir, "multiline.ts"),
            `const apiKey =\n    "safemolt_static_value_on_the_next_line";\n\n` +
                `await createProfessor(\n  'Foundation Professor',\n  'foundation@safemolt.com',\n  'a-hardcoded-key',\n  profId\n);\n`
        );
        expect(scanTree([fixtureDir], fixtureDir).length).toBeGreaterThanOrEqual(2);
    });

    // The two SQL forms are asserted **separately, with exact counts**. Putting both in one fixture
    // and asserting `length > 0` is how the INSERT blind spot survived: the UPDATE matched, the
    // assertion went green, and nothing ever established that the INSERT was seen. A seeded
    // credential — the case this scan exists for — is written as an INSERT.
    it("finds a credential literal in an INSERT column position", () => {
        writeFileSync(
            join(fixtureDir, "seed-insert.sql"),
            `INSERT INTO agents (name, api_key) VALUES ('demo', 'safemolt_seeded_literal_key');\n`
        );
        const hits = scanTree([fixtureDir], fixtureDir);
        expect(hits).toHaveLength(1);
        expect(hits[0].pattern).toBe(SQL_INSERT_PATTERN);
    });

    it("finds one in the idempotent INSERT … SELECT upsert, which is the shape actually used", () => {
        // Not a hypothetical form. `scripts/migrate-ao-seed-moiraine.sql` seeds its credential
        // exactly this way, and a `VALUES`-only detector missed it — the same blind spot as the
        // original defect, relocated. Both credential columns must be seen, not just the first.
        writeFileSync(
            join(fixtureDir, "upsert.sql"),
            `INSERT INTO agents (\n  id,\n  name,\n  api_key,\n  metadata,\n  claim_token\n)\n` +
                `SELECT\n  'agent_seeded',\n  'Seeded',\n  'safemolt_seeded_literal_key',\n` +
                `  '{"emoji":"🔮"}'::jsonb,\n  'claim_seeded_literal_token'\n` +
                `WHERE NOT EXISTS (\n  SELECT 1 FROM agents WHERE LOWER(TRIM(name)) = 'seeded'\n);\n`
        );
        const hits = scanTree([fixtureDir], fixtureDir);
        expect(hits.map((h) => h.pattern)).toEqual([SQL_INSERT_PATTERN, SQL_INSERT_PATTERN]);
        expect(hits.map((h) => h.text.split("=> ")[1])).toEqual([
            "'safemolt_seeded_literal_key'",
            "'claim_seeded_literal_token'",
        ]);
    });

    it("finds a credential literal in an UPDATE assignment", () => {
        writeFileSync(
            join(fixtureDir, "seed-update.sql"),
            `UPDATE agents SET api_key = 'another_hardcoded_credential' WHERE name = 'demo';\n`
        );
        expect(scanTree([fixtureDir], fixtureDir)).toHaveLength(1);
    });

    it("keeps its column-to-value alignment when a value contains commas", () => {
        // `encode(gen_random_bytes(32), 'hex')` is one value, not two. A naive comma split would
        // shift every later column by one and read the wrong expression for `api_key`.
        writeFileSync(
            join(fixtureDir, "generated.sql"),
            `INSERT INTO agents (name, api_key, note)\n` +
                `VALUES ('a_long_display_name', encode(gen_random_bytes(32), 'hex'), 'a_harmless_note');\n`
        );
        expect(scanTree([fixtureDir], fixtureDir)).toEqual([]);
    });

    it("does not fire on an INSERT whose credential column is parameterised", () => {
        writeFileSync(
            join(fixtureDir, "parameterised.sql"),
            `INSERT INTO agents (name, api_key) VALUES ('a_long_display_name', $1);\n`
        );
        expect(scanTree([fixtureDir], fixtureDir)).toEqual([]);
    });

    it("finds credentials named something other than the one that leaked", () => {
        // The scan used to key on `api_key`/`secret`/`bearer`/`claim_token` — the vocabulary of the
        // last incident. A scan calibrated to the previous leak does not find the next one.
        for (const [name, line] of [
            ["token", `const token = "safemolt_static_value";`],
            ["AUTH_TOKEN", `const AUTH_TOKEN = "safemolt_static_value";`],
            ["password", `const password = "hunter2_but_longer";`],
            ["credential", `const credential = "safemolt_static_value";`],
        ] as const) {
            writeFileSync(join(fixtureDir, `${name}.ts`), `${line}\n`);
        }
        expect(scanTree([fixtureDir], fixtureDir)).toHaveLength(4);
    });

    it("finds a credential compared against a literal, not only assigned from one", () => {
        // `if (apiKey === "foundation-api-key")` is the shape a published bearer takes the moment
        // someone moves the check out of the database and into the source.
        writeFileSync(
            join(fixtureDir, "compare.ts"),
            `export function isFoundation(apiKey: string) {\n  return apiKey === "foundation-api-key";\n}\n`
        );
        const hits = scanTree([fixtureDir], fixtureDir);
        expect(hits).toHaveLength(1);
        expect(hits[0].pattern).toBe("credential compared against a literal");
    });

    it("finds a credential behind a quoted object key", () => {
        // `{ "api_key": "..." }` — the JSON-shaped form. The unquoted pattern required the
        // identifier to touch the `:`, so the closing quote walked it past this entirely.
        writeFileSync(
            join(fixtureDir, "config.ts"),
            `export const config = { "api_key": "safemolt_static_value" };\n`
        );
        expect(scanTree([fixtureDir], fixtureDir)).toHaveLength(1);
    });

    it("does not fire on the fixed bootstrap or on configuration reads", () => {
        writeFileSync(
            join(fixtureDir, "clean.ts"),
            `const apiKey = generateProfessorApiKey();\n` +
                `const other = process.env.FOUNDATION_PROFESSOR_API_KEY;\n` +
                `await createProfessor('Foundation Professor', 'foundation@safemolt.com', generateProfessorApiKey(), profId);\n`
        );
        expect(scanTree([fixtureDir], fixtureDir)).toEqual([]);
    });

    it("honours the exemption list rather than weakening the patterns", () => {
        // The rotation migration must name the literal it rotates. Exempting the file keeps the
        // scan strict everywhere else instead of loosening a pattern until it stops matching.
        expect(Object.keys(SCAN_EXEMPTIONS)).toContain("scripts/migrate-rotate-published-professor-keys.sql");
    });
});

describe("the tree is clean", () => {
    it("has no credential-shaped literal under src/ or scripts/", () => {
        const hits = scanTree([join(REPO_ROOT, "src"), join(REPO_ROOT, "scripts")]);
        expect(hits.map((h) => `${h.file}:${h.line} — ${h.text}`)).toEqual([]);
    });
});
