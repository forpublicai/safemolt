/**
 * M11-2 P1.6 — drift test for the generated ESLint boundary block.
 *
 * `scripts/gen-eslint-boundary.js` renders the `no-restricted-imports` override from
 * `src/lib/store/export-manifest.ts` (the mutating-export manifest) and the permanent exemption
 * lists it carries verbatim from `ai/validation/m11-inventory.md` §10a/§10b. This test regenerates
 * that block IN MEMORY (no file write) and asserts it matches, byte for byte, the block committed
 * inside `.eslintrc.json` between the `GENERATED:BOUNDARY:START`/`END` markers. A manifest edit that
 * was not followed by `npm run gen:boundary` fails here instead of silently shipping a stale rule.
 */
import fs from "node:fs";
import path from "node:path";
import {
  renderBoundaryBlock,
  START_MARKER,
  END_MARKER,
} from "../../../scripts/gen-eslint-boundary";

describe("P1.6 boundary generated block", () => {
  it("matches what scripts/gen-eslint-boundary.js renders right now", () => {
    const eslintrcPath = path.join(process.cwd(), ".eslintrc.json");
    const raw = fs.readFileSync(eslintrcPath, "utf8");

    const startIdx = raw.indexOf(START_MARKER);
    const endIdx = raw.indexOf(END_MARKER);
    expect(startIdx).toBeGreaterThan(-1);
    expect(endIdx).toBeGreaterThan(-1);

    const committed = raw.slice(startIdx, endIdx + END_MARKER.length);
    const expected = renderBoundaryBlock();

    expect(committed).toBe(expected);
  });

  it("keeps .eslintrc.json valid JSON once ESLint's comment-stripping loader runs", () => {
    const eslintrcPath = path.join(process.cwd(), ".eslintrc.json");
    const raw = fs.readFileSync(eslintrcPath, "utf8");
    // Mirrors what ESLint's own config loader does for .eslintrc.json (JSON-with-comments); a
    // plain JSON.parse on the raw text would fail on the `//` marker lines even though ESLint
    // itself accepts them.
    const stripped = raw.replace(/\/\/.*$/gm, "");
    expect(() => JSON.parse(stripped)).not.toThrow();
  });
});
