/**
 * M11-2 P1.6 — manifest-completeness test.
 *
 * Enumerates every VALUE export the store facade (`src/lib/store.ts`) actually re-exports, by
 * parsing `store.ts`'s own `export * from "./store/<domain>"` specifiers and then each domain's
 * `index.ts` with the TypeScript compiler API (not a hand-maintained file list, so a new domain
 * folder is picked up automatically). Every export must be classified EITHER as mutating
 * (`MUTATING_STORE_EXPORTS`, `src/lib/store/export-manifest.ts`) OR as a read (its name starts with
 * one of `READ_EXPORT_PREFIXES`, same file) — never neither, never both.
 *
 * A new store export added by another lane this wave trips this test AT THE MERGE BOUNDARY, by
 * design (see the manifest file's header and the u5 Lane A spec): the failure names the export and
 * says where to classify it, so the boundary's coverage cannot silently drift.
 */
import fs from "node:fs";
import path from "node:path";
import ts from "typescript";
import { MUTATING_STORE_EXPORTS, READ_EXPORT_PREFIXES } from "@/lib/store/export-manifest";

const ROOT = process.cwd();

/** Value (non-type) export names a TS source file declares or re-exports by name. */
function extractValueExportNames(filePath: string): string[] {
  const src = fs.readFileSync(filePath, "utf8");
  const sf = ts.createSourceFile(filePath, src, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const names: string[] = [];

  function visit(node: ts.Node) {
    if (
      ts.isVariableStatement(node) &&
      node.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword)
    ) {
      for (const decl of node.declarationList.declarations) {
        if (ts.isIdentifier(decl.name)) names.push(decl.name.text);
      }
    } else if (
      ts.isFunctionDeclaration(node) &&
      node.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword)
    ) {
      if (node.name) names.push(node.name.text);
    } else if (ts.isExportDeclaration(node)) {
      if (node.exportClause && ts.isNamedExports(node.exportClause)) {
        for (const el of node.exportClause.elements) {
          const isType = node.isTypeOnly || el.isTypeOnly;
          if (!isType) names.push(el.name.text);
        }
      }
    }
  }
  ts.forEachChild(sf, visit);
  return names;
}

/** The domain barrel modules `src/lib/store.ts` re-exports via `export * from "./store/<domain>"`. */
function listStoreFacadeDomainDirs(): string[] {
  const storeTsPath = path.join(ROOT, "src/lib/store.ts");
  const src = fs.readFileSync(storeTsPath, "utf8");
  const sf = ts.createSourceFile(storeTsPath, src, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const dirs: string[] = [];
  ts.forEachChild(sf, (node) => {
    if (ts.isExportDeclaration(node) && !node.exportClause && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
      // `export * from "./store/<domain>"` — no export clause means a wildcard re-export.
      const spec = node.moduleSpecifier.text;
      const m = spec.match(/^\.\/store\/(.+)$/);
      if (m) dirs.push(m[1]);
    }
  });
  return dirs;
}

function canonicalStoreExports(): string[] {
  const dirs = listStoreFacadeDomainDirs();
  const all = new Set<string>();
  for (const dir of dirs) {
    const indexPath = path.join(ROOT, "src/lib/store", dir, "index.ts");
    expect(fs.existsSync(indexPath)).toBe(true);
    for (const name of extractValueExportNames(indexPath)) all.add(name);
  }
  return [...all];
}

describe("P1.6 store-export manifest completeness", () => {
  it("classifies every store-facade value export as mutating or as a read", () => {
    const canonical = canonicalStoreExports();
    expect(canonical.length).toBeGreaterThan(0);

    const mutatingSet = new Set(MUTATING_STORE_EXPORTS);
    const unclassified = canonical.filter(
      (name) => !mutatingSet.has(name) && !READ_EXPORT_PREFIXES.some((p) => name.startsWith(p))
    );

    if (unclassified.length > 0) {
      throw new Error(
        `The store facade exports ${unclassified.length} name(s) not classified in ` +
          `src/lib/store/export-manifest.ts: ${unclassified.join(", ")}. ` +
          `Add each to export-manifest.ts (mutating) or the read-prefix list, then \`npm run gen:boundary\`.`
      );
    }
  });

  it("has no stale manifest entries (a name no longer exported by the store facade)", () => {
    const canonical = new Set(canonicalStoreExports());
    const stale = MUTATING_STORE_EXPORTS.filter((name) => !canonical.has(name));
    expect(stale).toEqual([]);
  });

  it("has no duplicate entries in MUTATING_STORE_EXPORTS", () => {
    const seen = new Set(MUTATING_STORE_EXPORTS);
    expect(seen.size).toBe(MUTATING_STORE_EXPORTS.length);
  });
});
