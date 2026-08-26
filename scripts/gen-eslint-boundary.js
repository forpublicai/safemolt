#!/usr/bin/env node
/**
 * M11-2 P1.6 — generates the store-boundary ESLint `no-restricted-imports` block from
 * `src/lib/store/export-manifest.ts` (the canonical MUTATING_STORE_EXPORTS list) and the permanent
 * exemption lists (`ai/validation/m11-inventory.md` §10a + §10b, copied verbatim below), and splices
 * it into `.eslintrc.json` between two marker comments. Run with `npm run gen:boundary`.
 *
 * Why a regex over export-manifest.ts instead of `require`ing it: `scripts/` has no build step, so
 * this plain CommonJS script cannot import a `.ts` file directly. The regex extracts the
 * `MUTATING_STORE_EXPORTS` string-literal array; `src/__tests__/lib/boundary-generated-block.test.ts`
 * runs the SAME extraction (by requiring this file) inside Jest's TS pipeline and asserts the
 * checked-in `.eslintrc.json` block matches what it renders right now, so drift between the manifest
 * and the config fails CI.
 *
 * Why marker comments in a `.json` file: ESLint's own config loader strips comments from
 * `.eslintrc.json` before parsing (documented ESLint behavior), so `// ...` lines here are legal and
 * ESLint ignores them — they exist only so this script (and the drift test) can find the generated
 * region with a plain string search instead of a full JSON round-trip, which would reformat or lose
 * comments anywhere else a human later adds them.
 */

const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const MANIFEST_PATH = path.join(ROOT, "src/lib/store/export-manifest.ts");
const ESLINTRC_PATH = path.join(ROOT, ".eslintrc.json");

const START_MARKER =
  "// GENERATED:BOUNDARY:START (scripts/gen-eslint-boundary.js — do not hand-edit; run `npm run gen:boundary`)";
const END_MARKER = "// GENERATED:BOUNDARY:END";

/**
 * The internal-route allowlist, `ai/validation/m11-inventory.md` §10a, verbatim (the read-only
 * agents/[id] internal route is included there "for completeness" and kept here for the same
 * reason — a route on this list can never trip the rule either way, since it imports no mutating
 * export, but excluding it keeps this script's list a literal transcription of §10a).
 */
const INTERNAL_ALLOWLIST = [
  "src/app/api/v1/internal/agent-loop/route.ts",
  "src/app/api/v1/internal/playground-deadlines/route.ts",
  "src/app/api/v1/internal/memory-ingest/route.ts",
  "src/app/api/v1/internal/certification-judging/route.ts",
  "src/app/api/v1/internal/school-events/route.ts",
  "src/app/api/v1/internal/agent-metadata/route.ts",
  "src/app/api/v1/internal/agents/[id]/route.ts",
  "src/app/api/v1/playground/cron/trigger/route.ts",
  // Not in ai/validation/m11-inventory.md §10a/§1c as generated (tree state 2026-08-03) — found by
  // u5 Lane A when `npm run lint` fired on it: a `requireCronAuth`-gated internal/* route driving
  // the event-drain consumer runtime, same shape as every other route on this list. Added here and
  // noted in the inventory's §10a by u5 Lane A (see the report).
  "src/app/api/v1/internal/events-drain/route.ts",
];

/**
 * The out-of-scope surface families, `ai/validation/m11-inventory.md` §10b, verbatim — every route
 * file named under each family in that table, mutating or not. `school-federation` was added to
 * this section by u5 Lane A, resolving one of §10's two OPEN items (see the u5 Lane A report): the
 * three service-secret routes mutate through non-store modules today and name no mutating store
 * export, so the rule does not currently fire on them either way, but the Surface bound requires an
 * explicit classification rather than a silent pass-through, and they fit no other named family.
 */
const OUT_OF_SCOPE_FAMILIES = [
  // companies/*
  "src/app/api/v1/companies/route.ts",
  "src/app/api/v1/companies/[id]/route.ts",
  "src/app/api/v1/companies/[id]/dissolve/route.ts",
  "src/app/api/v1/companies/[id]/team/route.ts",
  "src/app/api/v1/companies/[id]/updates/route.ts",
  "src/app/api/v1/companies/[id]/evaluations/route.ts",
  "src/app/api/v1/companies/[id]/evaluations/record/route.ts",
  "src/app/api/v1/companies/leaderboard/route.ts",
  // working-papers/*
  "src/app/api/v1/working-papers/route.ts",
  "src/app/api/v1/working-papers/[slug]/route.ts",
  "src/app/api/v1/working-papers/[slug]/publish/route.ts",
  // demo-days/*
  "src/app/api/v1/demo-days/route.ts",
  "src/app/api/v1/demo-days/[id]/route.ts",
  "src/app/api/v1/demo-days/[id]/pitches/route.ts",
  "src/app/api/v1/demo-days/[id]/pitches/[pitchId]/applaud/route.ts",
  // fellowship/*
  "src/app/api/v1/fellowship/apply/route.ts",
  "src/app/api/v1/fellowship/applications/route.ts",
  "src/app/api/v1/fellowship/applications/[id]/route.ts",
  // updates/* (GET-only today — no mutating route — listed for completeness)
  "src/app/api/v1/updates/route.ts",
  // announcements admin mutations (GET is public read; POST/DELETE are ADMIN_SECRET)
  "src/app/api/v1/announcements/route.ts",
  // professors/*
  "src/app/api/v1/professors/register/route.ts",
  // exclusively-professor classes/* mutation routes
  "src/app/api/v1/classes/route.ts",
  "src/app/api/v1/classes/[id]/route.ts",
  "src/app/api/v1/classes/[id]/assistants/route.ts",
  "src/app/api/v1/classes/[id]/evaluations/route.ts",
  "src/app/api/v1/classes/[id]/evaluations/[evalId]/route.ts",
  "src/app/api/v1/classes/[id]/evaluations/[evalId]/grade/route.ts",
  "src/app/api/v1/classes/[id]/sessions/route.ts",
  "src/app/api/v1/classes/[id]/sessions/[sessionId]/route.ts",
  // admin/*
  "src/app/api/v1/admin/sync-classes/route.ts",
  // about-timeline reactions (P6.2 deferred surface)
  "src/app/api/v1/about/timeline/reactions/route.ts",
  // school-federation (resolves one of §10's two OPEN items — see comment above)
  "src/app/api/v1/schools/[id]/classes/sync/route.ts",
  "src/app/api/v1/schools/[id]/groups/provision/route.ts",
  "src/app/api/v1/schools/[id]/playground/games/sync/route.ts",
];

/**
 * Extract a top-level `export const NAME: <type> = [ "a", "b", ... ];` string-literal array from
 * TypeScript source, by regex. Deliberately does not handle arbitrary expressions — the manifest
 * file's header says to keep one quoted, comma-terminated string literal per line for exactly this
 * reason.
 */
function extractStringArray(source, constName) {
  const re = new RegExp(`export const ${constName}\\b[^=]*=\\s*\\[([\\s\\S]*?)\\];`, "m");
  const m = source.match(re);
  if (!m) {
    throw new Error(`gen-eslint-boundary: could not find "export const ${constName}" in ${MANIFEST_PATH}`);
  }
  const body = m[1];
  const items = [];
  const itemRe = /"((?:[^"\\]|\\.)*)"/g;
  let im;
  while ((im = itemRe.exec(body))) {
    items.push(im[1]);
  }
  if (items.length === 0) {
    throw new Error(`gen-eslint-boundary: ${constName} parsed to zero entries — check export-manifest.ts formatting`);
  }
  return items;
}

function loadMutatingStoreExports() {
  const src = fs.readFileSync(MANIFEST_PATH, "utf8");
  return extractStringArray(src, "MUTATING_STORE_EXPORTS");
}

/** The literal route-file paths, exactly as ai/validation/m11-inventory.md §10a/§10b spell them —
 * used for plain string-equality checks (the AST test's file filter, the mixed-actor test's
 * "appears on no exemption list" assertion). Do NOT feed these to a glob matcher unescaped; see
 * `excludedFilesAsGlobPatterns` for why. */
function excludedFiles() {
  return [...INTERNAL_ALLOWLIST, ...OUT_OF_SCOPE_FAMILIES];
}

/**
 * ESLint's `overrides[].excludedFiles` matches each entry as a minimatch GLOB PATTERN, and Next.js
 * dynamic route folders are literally named `[id]`, `[slug]`, etc. — minimatch reads an unescaped
 * `[...]` as a character class (one of the enclosed characters), not a literal bracket pair, so an
 * excludedFiles entry like `"…/working-papers/[slug]/publish/route.ts"` never matches the file it
 * names. (Caught by this script's own `npm run lint` run: `working-papers/[slug]/publish/route.ts`
 * — on the exemption list — still errored on `publishAoWorkingPaper` until this escaping was added.)
 * Escape every `[`/`]` with a backslash so minimatch treats them as literal characters.
 */
function escapeGlobBrackets(p) {
  return p.replace(/[[\]]/g, "\\$&");
}

function excludedFilesAsGlobPatterns() {
  return excludedFiles().map(escapeGlobBrackets);
}

/** Render the generated block's exact text, markers included, indented to sit in "overrides": [ ]. */
function renderBoundaryBlock() {
  const importNames = loadMutatingStoreExports();
  const override = {
    files: ["src/app/api/v1/**", "src/lib/agent-tools/**"],
    excludedFiles: excludedFilesAsGlobPatterns(),
    rules: {
      "no-restricted-imports": [
        "error",
        {
          paths: [
            {
              name: "@/lib/store",
              importNames,
              message:
                "M11-2 P1.6 store boundary: this store export is a write. Call the matching action in src/lib/actions/* instead of importing it here. See ai/PLAN_M11_2.md P1.5/P1.6 and ai/validation/m11-inventory.md §10.",
            },
          ],
        },
      ],
    },
  };
  const body = JSON.stringify(override, null, 2)
    .split("\n")
    .map((line) => "    " + line)
    .join("\n");
  // Deliberately no leading indent before START_MARKER: both `spliceIntoConfig` (which supplies
  // the indent at insertion time) and the drift test (which slices from `indexOf(START_MARKER)`)
  // key off this string starting exactly at the marker, so surrounding whitespace in the checked-in
  // file never causes a false drift failure or a false match.
  return `${START_MARKER}\n${body}\n    ${END_MARKER}`;
}

/** Find the matching `]` for the `[` at `openIdx`, respecting (simple) JSON string literals. */
function findMatchingBracket(text, openIdx) {
  let depth = 0;
  let inString = false;
  for (let i = openIdx; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (ch === "\\") {
        i++; // skip escaped char
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }
    if (ch === '"') {
      inString = true;
    } else if (ch === "[") {
      depth++;
    } else if (ch === "]") {
      depth--;
      if (depth === 0) return i;
    }
  }
  throw new Error("gen-eslint-boundary: unbalanced brackets while scanning .eslintrc.json");
}

/** Splice the generated block into the raw `.eslintrc.json` text and return the new text. */
function spliceIntoConfig(raw, block) {
  const startIdx = raw.indexOf(START_MARKER);
  const endIdx = raw.indexOf(END_MARKER);
  if (startIdx !== -1 && endIdx !== -1) {
    const before = raw.slice(0, startIdx);
    const after = raw.slice(endIdx + END_MARKER.length);
    return before + block + after;
  }
  if (startIdx !== -1 || endIdx !== -1) {
    throw new Error("gen-eslint-boundary: found one boundary marker but not the other — .eslintrc.json is corrupt");
  }
  // First run: insert as the last element of the "overrides" array.
  const overridesKey = '"overrides"';
  const keyIdx = raw.indexOf(overridesKey);
  if (keyIdx === -1) throw new Error('gen-eslint-boundary: no "overrides" array found in .eslintrc.json');
  const openBracketIdx = raw.indexOf("[", keyIdx);
  if (openBracketIdx === -1) throw new Error('gen-eslint-boundary: "overrides" is not an array in .eslintrc.json');
  const closeBracketIdx = findMatchingBracket(raw, openBracketIdx);
  const arrayInner = raw.slice(openBracketIdx + 1, closeBracketIdx);
  const hasExistingElement = /\S/.test(arrayInner);
  const indentedBlock = "    " + block;
  const insertion = hasExistingElement ? `,\n${indentedBlock}\n  ` : `\n${indentedBlock}\n  `;
  return raw.slice(0, closeBracketIdx) + insertion + raw.slice(closeBracketIdx);
}

function applyToEslintConfig() {
  const block = renderBoundaryBlock();
  const raw = fs.readFileSync(ESLINTRC_PATH, "utf8");
  const next = spliceIntoConfig(raw, block);
  fs.writeFileSync(ESLINTRC_PATH, next);
  return next;
}

module.exports = {
  START_MARKER,
  END_MARKER,
  INTERNAL_ALLOWLIST,
  OUT_OF_SCOPE_FAMILIES,
  extractStringArray,
  loadMutatingStoreExports,
  excludedFiles,
  escapeGlobBrackets,
  excludedFilesAsGlobPatterns,
  renderBoundaryBlock,
  spliceIntoConfig,
  applyToEslintConfig,
};

if (require.main === module) {
  applyToEslintConfig();
  // eslint-disable-next-line no-console
  console.log("gen-eslint-boundary: wrote the generated block into .eslintrc.json");
}
