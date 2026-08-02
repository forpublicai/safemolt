/**
 * M11-1 C17 + C24: credentials come from the CSPRNG, and none of them is a source literal.
 *
 * Two defects share this file because they share a root cause — a credential whose value an
 * outsider can obtain without stealing it. C24: `getProfessorFromRequest` accepts any bearer
 * matching `professors.api_key` with no further check, and eleven class routes authenticate that
 * way including grade writes, so a tracked string literal was a published administrator
 * credential — in git and in the live database simultaneously. C17: registration is
 * unauthenticated and returns three generator-derived values in one response, so a
 * `Math.random()` stream is observable and other agents' keys become predictable.
 *
 * @jest-environment node
 */
import { readFileSync, readdirSync, statSync } from "fs";
import { join } from "path";
import {
    generateAgentApiKey,
    generateClaimToken,
    generateProfessorApiKey,
    generateSecret,
    generateVerificationCode,
} from "@/lib/credentials";

const REPO_ROOT = join(__dirname, "..", "..", "..");

/** The literals this milestone knows to have been published. Kept in sync with the migration. */
const PUBLISHED_LITERALS = ["foundation-api-key"];

/**
 * Drop comment lines before scanning.
 *
 * The ban is on credentials in *code*, not on documentation that names the incident: this very
 * file, the rotation migration, and the fixed bootstrap all have to say "foundation-api-key" and
 * "Math.random" out loud to explain themselves. A scan that cannot tell prose from code would
 * force those explanations to be deleted, which is the opposite of what it exists to protect.
 */
function stripCommentLines(source: string): string {
    return source
        .split("\n")
        .filter((line) => {
            const trimmed = line.trim();
            return !trimmed.startsWith("//") && !trimmed.startsWith("*") && !trimmed.startsWith("/*");
        })
        .join("\n");
}

function collectSourceFiles(dir: string, extensions: string[]): string[] {
    const out: string[] = [];
    for (const entry of readdirSync(dir)) {
        if (entry === "node_modules" || entry === ".next" || entry === "__tests__") continue;
        const full = join(dir, entry);
        if (statSync(full).isDirectory()) {
            out.push(...collectSourceFiles(full, extensions));
        } else if (extensions.some((ext) => entry.endsWith(ext))) {
            out.push(full);
        }
    }
    return out;
}

describe("generateProfessorApiKey", () => {
    it("emits a prefixed 256-bit hex secret", () => {
        const key = generateProfessorApiKey();
        expect(key).toMatch(/^prof_[0-9a-f]{64}$/);
    });

    it("does not repeat across calls", () => {
        const keys = new Set(Array.from({ length: 64 }, () => generateProfessorApiKey()));
        expect(keys.size).toBe(64);
    });

    it("honours a caller-chosen entropy width", () => {
        expect(generateSecret(16)).toMatch(/^[0-9a-f]{32}$/);
    });
});

describe("agent credentials", () => {
    it("emits a 256-bit hex api key", () => {
        expect(generateAgentApiKey()).toMatch(/^safemolt_[0-9a-f]{64}$/);
    });

    it("emits a 128-bit hex claim token", () => {
        expect(generateClaimToken()).toMatch(/^claim_[0-9a-f]{32}$/);
    });

    it("keeps the verification code human-readable while drawing it from the CSPRNG", () => {
        // Its own entropy is low by design — it is a confirmation aid, not a bearer credential.
        // What mattered was that observing it used to leak state that predicted the api key.
        const code = generateVerificationCode();
        expect(code).toMatch(/^reef-[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{4}$/);
    });

    it("does not repeat api keys across calls", () => {
        // A statistical smoke check, and deliberately not evidence that the defect is closed: no
        // uniqueness test can demonstrate the *absence* of derivable PRNG structure. The source
        // assertions below are what close it.
        const keys = new Set(Array.from({ length: 256 }, () => generateAgentApiKey()));
        expect(keys.size).toBe(256);
    });
});

describe("credential source hygiene", () => {
    /**
     * A credential-named binding assigned from an expression containing `Math.random`.
     *
     * `generateId` still draws entity ids from `Math.random`, which is fine and stays fine — the
     * pattern requires the thing being *assigned* to be credential-named.
     */
    const CREDENTIAL_FROM_MATH_RANDOM =
        /\b(api_?key|apiKey|claim_?token|claimToken|verification_?code|verificationCode|auth_?token|authToken|secret|password)\b\s*[:=]\s*[^;]{0,200}?Math\.random/i;

    it("keeps Math.random out of credential assignment anywhere under src/", () => {
        // **Whole tree, and newline-tolerant.** This used to read three hard-coded files, line by
        // line: a credential generator added in a fourth file was invisible, and even inside those
        // three, `const apiKey =\n  Math.random()…` — ordinary formatting — walked straight past.
        // Both are unremarkable ways to write the defect this gate exists to prevent.
        const offenders: string[] = [];
        for (const file of collectSourceFiles(join(REPO_ROOT, "src"), [".ts", ".tsx"])) {
            if (file.includes("__tests__")) continue;
            const match = CREDENTIAL_FROM_MATH_RANDOM.exec(stripCommentLines(readFileSync(file, "utf8")));
            if (match) offenders.push(`${file.slice(REPO_ROOT.length + 1)}: ${match[0].replace(/\s+/g, " ").slice(0, 90)}`);
        }
        expect(offenders).toEqual([]);
    });

    it("that guard detects the defect it guards against, including the wrapped form", () => {
        // A gate nobody has seen fire is not evidence. The wrapped case is the one that defeated
        // the previous line-based version.
        expect(CREDENTIAL_FROM_MATH_RANDOM.test(`const apiKey = "sk_" + Math.random().toString(36);`)).toBe(true);
        expect(
            CREDENTIAL_FROM_MATH_RANDOM.test(`const claimToken =\n    "claim_" +\n    Math.random().toString(36);`)
        ).toBe(true);
        // The object-property form too — `{ apiKey: Math.random()… }` is how a credential reaches a
        // store insert, and requiring `=` would have missed every one of them.
        expect(CREDENTIAL_FROM_MATH_RANDOM.test(`  verificationCode: Math.random().toString(36),`)).toBe(true);
        expect(CREDENTIAL_FROM_MATH_RANDOM.test(`await insert({ api_key: "k_" + Math.random() })`)).toBe(true);
        // The legitimate entity-id use stays legitimate.
        expect(CREDENTIAL_FROM_MATH_RANDOM.test("return `${prefix}_${Math.random().toString(36)}`;")).toBe(false);
    });

    it("draws professor keys from the CSPRNG, never Math.random", () => {
        const source = readFileSync(join(REPO_ROOT, "src", "lib", "credentials.ts"), "utf8");
        expect(source).toContain("randomBytes");
        expect(stripCommentLines(source)).not.toContain("Math.random");
    });

    it("has no published professor literal anywhere under src/ or scripts/", () => {
        const files = [
            ...collectSourceFiles(join(REPO_ROOT, "src"), [".ts", ".tsx"]),
            ...collectSourceFiles(join(REPO_ROOT, "scripts"), [".js", ".mjs", ".ts"]),
        ];
        const offenders: string[] = [];
        for (const file of files) {
            const contents = stripCommentLines(readFileSync(file, "utf8"));
            for (const literal of PUBLISHED_LITERALS) {
                if (contents.includes(literal)) offenders.push(`${file} contains ${literal}`);
            }
        }
        expect(offenders).toEqual([]);
    });

    it("bootstraps the Foundation professor with a generated key", () => {
        const loader = readFileSync(join(REPO_ROOT, "src", "lib", "schools", "class-loader.ts"), "utf8");
        expect(loader).toContain("generateProfessorApiKey");
        // The bootstrap must not pass any string literal where the api key belongs.
        expect(loader).toMatch(/createProfessor\(\s*'Foundation Professor',\s*'foundation@safemolt\.com',\s*generateProfessorApiKey\(\)/);
    });
});

describe("rotation migration", () => {
    const migrationFile = "migrate-rotate-published-professor-keys.sql";

    it("is registered in the append-only runner list", () => {
        const runner = readFileSync(join(REPO_ROOT, "scripts", "migrate.js"), "utf8");
        expect(runner).toContain(migrationFile);
    });

    it("rotates every known literal and asserts a postcondition", () => {
        const sql = readFileSync(join(REPO_ROOT, "scripts", migrationFile), "utf8");
        for (const literal of PUBLISHED_LITERALS) {
            expect(sql).toContain(literal);
        }
        expect(sql).toContain("gen_random_bytes(32)");
        // Fails loudly rather than recording a rotation that did not happen.
        expect(sql).toContain("RAISE EXCEPTION");
        expect(sql).toContain("postcondition failed");
    });
});
