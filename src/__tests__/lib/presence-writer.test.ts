/**
 * P6.4 — `last_active_at` has exactly two legitimate writers, and no others.
 *
 * The remedy's promise ("presence = recency of authenticated API activity") only holds if nothing
 * besides the Tier-B auth touch (and its stale-touch twin) ever stamps the column: a route, action
 * or consumer that also wrote it would let something other than authentication move an agent's
 * presence bucket. Written in the style of `karma-writer-ownership.test.ts` — a scan proven against
 * decoys, then run over the real tree.
 *
 * Scope is `src/lib` and `src/app`, `__tests__` excluded — the same scope-is-a-claim reasoning as
 * the karma scan: fixtures legitimately write timestamps for unrelated scenarios.
 */
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join, relative } from "path";

const REPO_ROOT = join(__dirname, "..", "..", "..");
const SCANNED_EXTENSIONS = [".ts", ".tsx"];

/** The only functions ever allowed to write `last_active_at` / `lastActiveAt`. */
const ALLOWED_FUNCTIONS = ["authenticateAndTouchByApiKey", "touchAgentLastActiveAtIfStale"];
const ALLOWED_FILES = ["src/lib/store/agents/db.ts", "src/lib/store/agents/memory.ts"];

/**
 * `SET last_active_at =`, or `last_active_at =` as a LATER column in a multi-column `SET` clause
 * (codex round 2 F5: `SET description = $2, last_active_at = NOW()` was invisible to a
 * SET-prefix-only match). The predicate's `IS NULL`/`<` reads use no `=`, so neither shape matches.
 */
const SQL_WRITE = /(?:\bSET\s+|,\s*)last_active_at\s*=/gi;

/** `agents.set(` — the memory store's only way to persist an agent row. */
const AGENTS_SET = /\bagents\s*\.\s*set\s*\(/g;

/**
 * A direct field assignment: `x.lastActiveAt = …`. `(?!=)` keeps `===`/`==` comparisons out. This
 * shape needs no `agents.set(` guard — an in-place mutation of a live object IS the write, exactly
 * like the karma scanner's `in-place-karma-assignment`.
 */
const DIRECT_ASSIGN = /\.lastActiveAt\s*=(?!=)/g;

/** A `lastActiveAt:` key at the top level of an object literal — read the same way as `OBJECT_KARMA`. */
const OBJECT_LAST_ACTIVE = /(?:^|[{,])\s*lastActiveAt\s*(?::|,|\}|$)/m;

function collectFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry === ".next" || entry === "__tests__") continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) collectFiles(full, out);
    else if (SCANNED_EXTENSIONS.some((ext) => entry.endsWith(ext))) out.push(full);
  }
  return out;
}

/** Comment lines carry prose about `last_active_at` constantly; the ban is on code. */
function stripCommentLines(source: string): string {
  return source
    .split("\n")
    .filter((line) => {
      const trimmed = line.trim();
      return !trimmed.startsWith("//") && !trimmed.startsWith("*") && !trimmed.startsWith("/*");
    })
    .join("\n");
}

/** A balanced region starting at `open` (`(`, `{` or `[`), respecting nesting, quotes and templates. */
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
 * `agents.set(id, touched)` — the value is a bound identifier, not an inline literal
 * (`authenticateAndTouchByApiKey`'s shape). Resolve the nearest preceding binding of the name and
 * test ITS literal, mirroring the karma scanner's `boundObjectLiteral`.
 */
function boundObjectLiteral(source: string, callArgs: string, callIndex: number): string | null {
  const identifier = callArgs.match(/,\s*([A-Za-z_$][\w$]*)\s*$/)?.[1];
  if (!identifier) return null;
  const escaped = identifier.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const bindings = new RegExp(`(?:\\bconst\\s+|[^\\w$.=!<>+\\-*/%&|^])${escaped}\\s*=(?!=)\\s*\\{`, "g");
  for (const binding of source.matchAll(bindings)) {
    if (binding.index >= callIndex) break; // matchAll yields in source order
    const body = readBalanced(source, binding.index + binding[0].length - 1)?.body ?? null;
    if (body !== null && OBJECT_LAST_ACTIVE.test(body)) return body;
  }
  return null;
}

function lineOf(source: string, index: number): number {
  return source.slice(0, index).split("\n").length;
}

/** The enclosing `function <name>(` — nearest preceding declaration, sufficient for this file's two flat functions. */
function enclosingFunction(source: string, offset: number): string | null {
  const decl = /function\s+([A-Za-z0-9_]+)\s*\(/g;
  let best: { name: string; index: number } | null = null;
  for (const m of source.matchAll(decl)) {
    if (m.index <= offset && (!best || m.index > best.index)) best = { name: m[1], index: m.index };
  }
  return best?.name ?? null;
}

export interface PresenceWriterHit {
  file: string;
  line: number;
  fn: string | null;
}

export function scanLastActiveAtWriters(roots: string[], repoRoot: string = REPO_ROOT): PresenceWriterHit[] {
  const hits: PresenceWriterHit[] = [];
  for (const root of roots) {
    for (const file of collectFiles(root)) {
      const rel = relative(repoRoot, file);
      const source = stripCommentLines(readFileSync(file, "utf8"));
      const indices: number[] = [];

      for (const match of source.matchAll(SQL_WRITE)) indices.push(match.index);
      for (const match of source.matchAll(DIRECT_ASSIGN)) indices.push(match.index);
      // Only `lastActiveAt:` INSIDE an `agents.set(...)` call's arguments counts — an arbitrary
      // object literal elsewhere (e.g. `rowToAgent` mapping a read row) is not a store write. The
      // value may be inline or a bound identifier declared earlier in the same function.
      for (const match of source.matchAll(AGENTS_SET)) {
        const args = readBalanced(source, match.index + match[0].length - 1);
        if (!args) continue;
        const written = OBJECT_LAST_ACTIVE.test(args.body)
          ? args.body
          : boundObjectLiteral(source, args.body, match.index);
        if (written !== null) indices.push(match.index);
      }

      for (const index of indices) {
        hits.push({ file: rel, line: lineOf(source, index), fn: enclosingFunction(source, index) });
      }
    }
  }
  return hits.sort((a, b) => `${a.file}:${a.line}`.localeCompare(`${b.file}:${b.line}`));
}

function isAllowed(hit: PresenceWriterHit): boolean {
  return ALLOWED_FILES.includes(hit.file) && hit.fn !== null && ALLOWED_FUNCTIONS.includes(hit.fn);
}

describe("the scanner detects what it claims to detect", () => {
  let fixtureDir: string;

  beforeEach(() => {
    fixtureDir = mkdtempSync(join(tmpdir(), "presence-writer-scan-"));
  });

  afterEach(() => rmSync(fixtureDir, { recursive: true, force: true }));

  it("fails when a new SQL writer is added outside the auth touch", () => {
    writeFileSync(
      join(fixtureDir, "rogue.ts"),
      "export async function touch(id: string) {\n" +
        "  await sql`UPDATE agents SET last_active_at = NOW() WHERE id = ${id}`;\n" +
        "}\n"
    );
    const hits = scanLastActiveAtWriters([fixtureDir], fixtureDir);
    expect(hits).toHaveLength(1);
    expect(hits[0].fn).toBe("touch");
  });

  /** Codex round 2 F5: a SET-prefix-only match missed `last_active_at` as a later column. */
  it("fails when last_active_at is a later column in a multi-column SET clause", () => {
    writeFileSync(
      join(fixtureDir, "rogue-multicolumn.ts"),
      "export async function touch(id: string, description: string) {\n" +
        "  await sql`UPDATE agents SET description = ${description}, last_active_at = NOW() WHERE id = ${id}`;\n" +
        "}\n"
    );
    const hits = scanLastActiveAtWriters([fixtureDir], fixtureDir);
    expect(hits).toHaveLength(1);
    expect(hits[0].fn).toBe("touch");
  });

  it("fails when a new memory writer is added via agents.set (object literal shape)", () => {
    writeFileSync(
      join(fixtureDir, "rogue-memory.ts"),
      "export function touch(id: string) {\n" +
        "  const agent = agents.get(id)!;\n" +
        "  agents.set(id, { ...agent, lastActiveAt: new Date().toISOString() });\n" +
        "}\n"
    );
    const hits = scanLastActiveAtWriters([fixtureDir], fixtureDir);
    expect(hits).toHaveLength(1);
    expect(hits[0].fn).toBe("touch");
  });

  it("fails when a new memory writer is added (direct assignment shape)", () => {
    writeFileSync(
      join(fixtureDir, "rogue-assign.ts"),
      "export function touch(id: string, next: { lastActiveAt?: string }) {\n" +
        "  next.lastActiveAt = new Date().toISOString();\n" +
        "}\n"
    );
    const hits = scanLastActiveAtWriters([fixtureDir], fixtureDir);
    expect(hits).toHaveLength(1);
  });

  it("finds an agents.set(id, boundVar) write, the real authenticateAndTouchByApiKey shape", () => {
    writeFileSync(
      join(fixtureDir, "bound.ts"),
      "export function touch(id: string) {\n" +
        "  const agent = agents.get(id)!;\n" +
        "  const touched = { ...agent, lastActiveAt: new Date().toISOString() };\n" +
        "  agents.set(id, touched);\n" +
        "}\n"
    );
    const hits = scanLastActiveAtWriters([fixtureDir], fixtureDir);
    expect(hits).toHaveLength(1);
    expect(hits[0].fn).toBe("touch");
  });

  it("does NOT mistake a plain object literal's lastActiveAt (no agents.set) for a write", () => {
    // `rowToAgent`'s shape: mapping a read row's column into the returned object is not a store
    // mutation, and a scan that fired on any `lastActiveAt:` would report it as one.
    writeFileSync(
      join(fixtureDir, "row-mapper.ts"),
      "export function rowToAgent(r: Record<string, unknown>) {\n" +
        "  return {\n    id: r.id,\n    lastActiveAt: r.last_active_at != null ? String(r.last_active_at) : undefined,\n  };\n" +
        "}\n"
    );
    expect(scanLastActiveAtWriters([fixtureDir], fixtureDir)).toEqual([]);
  });

  it("does NOT mistake the auth predicate's reads for a write", () => {
    writeFileSync(
      join(fixtureDir, "reads.ts"),
      "export async function check(id: string) {\n" +
        "  return sql`SELECT * FROM agents WHERE last_active_at IS NULL OR last_active_at < NOW()`;\n" +
        "}\n" +
        "export function checkMemory(agent: { lastActiveAt?: string }) {\n" +
        "  return agent.lastActiveAt ? Date.parse(agent.lastActiveAt) : 0;\n" +
        "}\n"
    );
    expect(scanLastActiveAtWriters([fixtureDir], fixtureDir)).toEqual([]);
  });

  it("does NOT mistake a type annotation for a write", () => {
    writeFileSync(
      join(fixtureDir, "types.ts"),
      "export function updateAgent(updates: { lastActiveAt?: string }) {\n  return updates;\n}\n"
    );
    expect(scanLastActiveAtWriters([fixtureDir], fixtureDir)).toEqual([]);
  });

  it("does NOT mistake prose about the column for code", () => {
    writeFileSync(
      join(fixtureDir, "prose.ts"),
      "// UPDATE agents SET last_active_at = NOW() was the old writer\n" +
        "/**\n * agents.set(id, { lastActiveAt: x })\n */\nexport const x = 1;\n"
    );
    expect(scanLastActiveAtWriters([fixtureDir], fixtureDir)).toEqual([]);
  });
});

describe("the only writers in src/lib and src/app are the allowlisted touch functions", () => {
  it("finds every last_active_at write inside authenticateAndTouchByApiKey or touchAgentLastActiveAtIfStale, in db.ts and memory.ts only", () => {
    const hits = scanLastActiveAtWriters([join(REPO_ROOT, "src", "lib"), join(REPO_ROOT, "src", "app")]);
    const offenders = hits.filter((h) => !isAllowed(h));
    expect(offenders).toEqual([]);
    // Both files, both functions, at least one write apiece — an empty result would also pass the
    // filter above and hide a scanner that stopped matching anything.
    for (const file of ALLOWED_FILES) {
      for (const fn of ALLOWED_FUNCTIONS) {
        expect(hits.some((h) => h.file === file && h.fn === fn)).toBe(true);
      }
    }
  });
});
