/**
 * M11-2 P1.6 — AST-level discipline test for the store boundary.
 *
 * ESLint's `no-restricted-imports` (the generated block in `.eslintrc.json`) is the primary gate,
 * but its `importNames` matching has known blind spots for two evasions: a namespace import
 * (`import * as store from "@/lib/store"`) names no specifier for the rule to match against, and an
 * aliased named import is only as safe as the rule's alias resolution. This test walks the same file
 * set with the TypeScript compiler API and independently fails a file that:
 *   - namespace-imports the store (`import * as X from "@/lib/store"`),
 *   - aliases a mutating manifest export (`import { createPost as x } from "@/lib/store"`),
 *   - `require("@/lib/store")`s it, or
 *   - dynamically `import("@/lib/store")`s it.
 *
 * It is deliberately a single walk over one file set with one visitor — no plugin architecture, per
 * the u5 Lane A spec's KISS rule.
 */
import fs from "node:fs";
import path from "node:path";
import ts from "typescript";
import { MUTATING_STORE_EXPORTS } from "@/lib/store/export-manifest";
import { excludedFiles } from "../../../scripts/gen-eslint-boundary";

const ROOT = process.cwd();
const SCAN_DIRS = ["src/app/api/v1", "src/lib/agent-tools"];
const STORE_SPECIFIER = "@/lib/store";

function walk(dir: string, out: string[]): void {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walk(full, out);
    } else if (entry.isFile() && (entry.name.endsWith(".ts") || entry.name.endsWith(".tsx"))) {
      out.push(full);
    }
  }
}

function inScopeFiles(): string[] {
  const exempt = new Set(excludedFiles());
  const all: string[] = [];
  for (const dir of SCAN_DIRS) walk(path.join(ROOT, dir), all);
  return all
    .map((abs) => path.relative(ROOT, abs).split(path.sep).join("/"))
    .filter((rel) => !exempt.has(rel));
}

interface Violation {
  file: string;
  line: number;
  kind: string;
  detail: string;
}

function scanFile(relPath: string): Violation[] {
  const absPath = path.join(ROOT, relPath);
  const src = fs.readFileSync(absPath, "utf8");
  const sf = ts.createSourceFile(absPath, src, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const violations: Violation[] = [];
  const mutatingSet = new Set(MUTATING_STORE_EXPORTS);

  function lineOf(node: ts.Node): number {
    return sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;
  }

  function visit(node: ts.Node) {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      if (node.moduleSpecifier.text === STORE_SPECIFIER && node.importClause) {
        const bindings = node.importClause.namedBindings;
        if (bindings && ts.isNamespaceImport(bindings)) {
          violations.push({
            file: relPath,
            line: lineOf(node),
            kind: "namespace-import",
            detail: `import * as ${bindings.name.text} from "${STORE_SPECIFIER}"`,
          });
        } else if (bindings && ts.isNamedImports(bindings)) {
          for (const el of bindings.elements) {
            if (el.propertyName) {
              const original = el.propertyName.text;
              if (mutatingSet.has(original)) {
                violations.push({
                  file: relPath,
                  line: lineOf(el),
                  kind: "aliased-mutating-import",
                  detail: `import { ${original} as ${el.name.text} } from "${STORE_SPECIFIER}"`,
                });
              }
            }
          }
        }
      }
    } else if (ts.isCallExpression(node)) {
      // `require("@/lib/store")`
      if (
        ts.isIdentifier(node.expression) &&
        node.expression.text === "require" &&
        node.arguments.length === 1 &&
        ts.isStringLiteral(node.arguments[0]) &&
        node.arguments[0].text === STORE_SPECIFIER
      ) {
        violations.push({
          file: relPath,
          line: lineOf(node),
          kind: "require-call",
          detail: `require("${STORE_SPECIFIER}")`,
        });
      }
      // dynamic `import("@/lib/store")`
      if (
        node.expression.kind === ts.SyntaxKind.ImportKeyword &&
        node.arguments.length >= 1 &&
        ts.isStringLiteral(node.arguments[0]) &&
        node.arguments[0].text === STORE_SPECIFIER
      ) {
        violations.push({
          file: relPath,
          line: lineOf(node),
          kind: "dynamic-import",
          detail: `import("${STORE_SPECIFIER}")`,
        });
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(sf);
  return violations;
}

describe("P1.6 boundary AST discipline", () => {
  const files = inScopeFiles();

  it("found a non-trivial in-scope file set to scan", () => {
    expect(files.length).toBeGreaterThan(50);
  });

  it("has no namespace import, aliased-mutating import, require(), or dynamic import of @/lib/store", () => {
    const violations = files.flatMap(scanFile);
    if (violations.length > 0) {
      const lines = violations.map((v) => `  ${v.file}:${v.line} [${v.kind}] ${v.detail}`).join("\n");
      throw new Error(`P1.6 boundary AST discipline violations:\n${lines}`);
    }
  });
});
