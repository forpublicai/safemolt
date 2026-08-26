/**
 * M11-2 P1.6 gate — the mixed-actor route test named in `ai/PLAN_M11_2.md` line 245.
 *
 * `classes/[id]/sessions/[sessionId]/messages/route.ts` is the one route with two authenticated
 * actors in one handler: a human professor (operator-owned, `@/lib/class-ops`, history-silent) and
 * an agent (action-owned, `@/lib/actions/classes`, emits `class.session_message`). Per
 * `ai/validation/m11-inventory.md` §10 tail, it gets NO file-level exemption — it must import no
 * mutating store export, and its agent branch must have no route to the professor's operator writer.
 */
import fs from "node:fs";
import path from "node:path";
import ts from "typescript";
import { MUTATING_STORE_EXPORTS } from "@/lib/store/export-manifest";
import { excludedFiles } from "../../../scripts/gen-eslint-boundary";

const ROUTE_REL_PATH = "src/app/api/v1/classes/[id]/sessions/[sessionId]/messages/route.ts";

describe("P1.6 mixed-actor route gate — class session messages", () => {
  const absPath = path.join(process.cwd(), ROUTE_REL_PATH);
  const source = fs.readFileSync(absPath, "utf8");

  it("imports no mutating store export from @/lib/store", () => {
    const sf = ts.createSourceFile(absPath, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
    const mutatingSet = new Set(MUTATING_STORE_EXPORTS);
    const found: string[] = [];
    ts.forEachChild(sf, (node) => {
      if (
        ts.isImportDeclaration(node) &&
        ts.isStringLiteral(node.moduleSpecifier) &&
        node.moduleSpecifier.text === "@/lib/store" &&
        node.importClause?.namedBindings &&
        ts.isNamedImports(node.importClause.namedBindings)
      ) {
        for (const el of node.importClause.namedBindings.elements) {
          const original = el.propertyName?.text ?? el.name.text;
          if (mutatingSet.has(original)) found.push(original);
        }
      }
    });
    expect(found).toEqual([]);
  });

  it("only the professor-auth branch can reach addOperatorClassSessionMessage — the agent branch cannot", () => {
    // Source-scan pattern, matching src/__tests__/lib/m11-2-u3f-core-characterization.test.ts: the
    // operator writer call must sit textually inside the professor-auth guard, strictly before the
    // agent's `requireAgent` gate and its `sendSessionMessage` action call begin.
    expect(source).toContain("addOperatorClassSessionMessage");
    expect(source).toContain("sendSessionMessage");

    const professorGuardIdx = source.indexOf("professor.id === cls.professorId");
    const operatorCallIdx = source.indexOf("addOperatorClassSessionMessage(");
    const requireAgentIdx = source.indexOf("requireAgent(request)");
    const actionCallIdx = source.indexOf("sendSessionMessage(");

    expect(professorGuardIdx).toBeGreaterThan(-1);
    expect(operatorCallIdx).toBeGreaterThan(-1);
    expect(requireAgentIdx).toBeGreaterThan(-1);
    expect(actionCallIdx).toBeGreaterThan(-1);

    expect(professorGuardIdx).toBeLessThan(operatorCallIdx);
    expect(operatorCallIdx).toBeLessThan(requireAgentIdx);
    expect(requireAgentIdx).toBeLessThan(actionCallIdx);

    // Nothing from the agent gate onward mentions the operator writer again.
    const tail = source.slice(requireAgentIdx);
    expect(tail).not.toContain("addOperatorClassSessionMessage");
  });

  it("appears on no P1.6 exemption list — not exempted, by design (m11-inventory.md §10 tail)", () => {
    const exempt = excludedFiles();
    expect(exempt).not.toContain(ROUTE_REL_PATH);
  });
});
