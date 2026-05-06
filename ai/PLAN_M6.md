# M6 plan: Remaining UI polish, usable search, and validation artifact cleanup

## Summary

M1 established the public monospace aesthetic. M5 brought the interior surfaces, route loading states, and Playground split into that same visual language. The current pending M5 follow-up fixes major review findings, but there are still visible loose ends that should be handled as a small, focused milestone before starting another architecture-heavy pass.

M6 ships five concrete deliverables:

1. Make `/search` a usable public UI instead of a text-only placeholder.
2. Finish the remaining non-functional bracket cleanup while preserving functional identifiers like `[u/name]`, `[g/name]`, `[SIP-*]`, status tags, timestamps, and activity tags.
3. Fix or replace mobile-hostile table layouts that still rely on horizontal scrolling, starting with the About timeline.
4. Perform a real dashboard visual audit for the authenticated-only pages that M5 could not inspect, then patch any obvious layout or copy polish issues.
5. Clean the validation artifact workflow so stale screenshots/logs in `ai/` do not get staged as misleading evidence.

Out of scope:

- No new visual design system extraction.
- No new dependencies in `package.json`.
- No changes to public API contracts.
- No redesign of dashboard information architecture.
- No broad performance milestone; only measure the UI routes touched by M6.

M6 assumes the current staged M5 follow-up lands first. If it has not landed, execute that staged work before starting M6 so the search/bracket/dashboard audit starts from the cleaned baseline.

## HOW TO EXECUTE A MILESTONE

[Please include what follows verbatim when you write a PLAN_M{n}.md file. It will be used to guide anyone who executes on your plan.]

If the user asks you to execute on a plan, these are the steps to take.

1. Implement the plan
   - You should check your work with AI autonomous validation and testing.
   - The hope is that implementation can be done with a minimum of user interaction, preferably none at all.
   - Once it is complete, fill in the "Validation" section to the bottom of the plan showing how you have validated it and what were the results.
   - You may discover better engineering work while implementing; capture it in this plan instead of hiding it in the diff.
2. Perform your testing and validation
   - Update the "AI VALIDATION RESULTS" section of your PLAN_M{n}.md file
3. Review your own code. Also, ask Claude to review your work
   - You will need to provide it contect: your plan document PLAN_M{n}.md, and tell it which files or functions you've worked on. Ask it also to review your validation steps.
   - If Claude found no blockers or problems with your work, you may proceed. Do static checking (formatting, eslint, typechecking). If you need any fixes, static check again to make sure it's clean.
   - If you couldn't get Claude to run for whatever reason, the user wants you to abort and report what's wrong.
   - Keep iterating with Claude until you no longer make changes (either because you've taken on Claude's feedback from past rounds, or because your plan no successfully defends its positions so Claude accepts them). However, if you take more than 10 rounds, then something is wrong, so stop and let the user know.
   - We aren't looking for "blocker vs non-blocker" decisions. Instead for every suggestion from Claude you must evaluate "will this improve my code? if so then modify your code, and if not then pre-emptively defend (in code comments) why not". And if you made modifications or comments, then circle back with Claude again.
   - Do NOT reference previous rounds when you invoke it: Claude does best if starting from scratch, so it can re-examine the whole ask from fundamentals. Note that each time you invoke Claude it has no memory of previous invocations, which is good and will help this goal! Also, avoid asking it something like "please review the updated files" since (1) you should not reference previous rounds implicitly or explicitly, (2) it has no understanding of what the updates were; it only knows about the current state of files+repo on disk.
4. After implementation, do a "better engineering" phase
   - Clean up LEARNINGS.md and ARCHITECTURE.md. If any information there is just restating information from other files then delete it. If it would belong better elsewhere, move it. Please be careful to follow the "learnings decision tree" -- LEARNINGS.md for durable engineering wisdom, ARCHITECTURE.md for things that will apply to CodexAgent.ts in its finished state, PLAN_M{n}.md for milestone-specific notes
   - You will have several Claude review tasks to do, below. You must launch all the following Claude review tasks in parallel, since they each take some time: prepare all their inputs, then execute them all in parallel. You should start addressing the first findings as soon as you get them, rather than waiting for all to be consolidated. You can be doing your own review while you wait for Claude.
   - (1) Review the code for correctness. Also ask Claude to evaluate this.
   - (2) Validate whether work obeys the codebase style guidelines in AGENTS.md. Also ask Claude to evaluate this. The user is INSISTENT that they must be obeyed.
   - (3) Validate whether the work obeys each learning you gathered in LEARNINGS.md. Also ask Claude to evaluate this. (A separate instance of Claude; it can't do too much in one go).
   - (4) Validate whether the work has satisfied the milestone's goals. Also ask Claude to evaluate this.
   - (5) Check if there is KISS, or consolidation, or refactoring that would improve quality of codebase. Also ask Claude the same question.
   - If you make changes, they'll need a pass of static checking (formatting, eslint, typechecking), and again to make sure it's clean.
   - You might decide to do better engineering yourself. If not, write notes about whats needed in the "BETTER ENGINEERING INSIGHTS" section of the plan.
   - Tell the user how you have done code cleanup. The user is passionate about clean code and will be delighted to hear how you have improved it.
5. Upon completion, ask for user review. Tell the user what to test, what commands to use, what gestures to try out, what to look for

### M6 process compatibility notes

- The current repo has `ai/DESIGN.md` and active agent instructions, but may not have a checked-in root `AGENTS.md`. When the execution checklist references `AGENTS.md`, validate against the active agent instructions plus `ai/DESIGN.md`. Do not stop solely because a root `AGENTS.md` file is absent.
- The current repo has root `LEARNINGS.md` for durable engineering wisdom. Use that file for the LEARNINGS-specific validation sub-step. Do not create `ai/LEARNINGS.md`; if execution discovers new durable engineering wisdom, add it to root `LEARNINGS.md`.
- Commands in this plan include both PowerShell and bash forms where shell syntax matters.

## Locked user decisions

1. **Preserve the mono product aesthetic.** Use the existing primitives from `ai/DESIGN.md`: `mono-page`, `mono-page-wide`, `mono-block`, `mono-row`, `mono-muted`, `dialog-box`, `pill`, `btn-primary`, and `btn-secondary`.

2. **Keep functional bracket labels.** Handles (`[u/name]`, `[g/name]`), SIP identifiers, timestamps, status pills, activity kind tags, and loading system text may remain bracketed. Decorative section headings should not.

3. **Make `/search` useful without changing `/api/v1/search`.** The existing API route stays agent-key protected. The page gets its own public server-rendered search read path using existing store functions.

4. **No new runtime dependencies.** If visual validation uses Playwright, use the executor environment or `npx` tooling only; do not add Playwright to `package.json`.

5. **Treat stale validation artifacts as untrusted.** Old screenshots/logs under `ai/` are not evidence for M6. Either regenerate them for M6 or leave them untracked.

6. **Dashboard audit is polish, not product redesign.** The route list, auth model, and dashboard feature layout stay the same.

### Executor questions deferred to user signoff

- **Q1.** Should public `/search` include agents and groups as well as posts/comments? Recommendation: yes, because the page metadata already says "agents, posts, and groups." Implement a single search form with a type select: `All`, `Posts`, `Comments`, `Agents`, `Groups`.
- **Q2.** Should the About timeline table become stacked cards on mobile or remain a horizontally scrollable table? Recommendation: stacked mobile rows plus the table on wider screens. Horizontal scroll technically works, but it feels rough on a mostly text-first site.
- **Q3.** Should old `ai/m5-screenshots` be deleted or simply left untracked? Recommendation: leave historical files on disk if useful locally, but do not stage them. M6 writes fresh validation notes/screenshots under `ai/m6-validation/` only if the executor actually captures them.

If the user does not answer before execution begins, proceed with the recommended option for each question.

## PLAN

### Phase 0 - Baseline and artifact hygiene

Phases 0, 1, 2, 3, and 5 should run in that order. Phase 4 can run in parallel with Phases 1-3 once Phase 0 is clean, because the dashboard visual audit is independent of the search and About-page changes.

1. Confirm the pending M5 follow-up is either merged or intentionally included in the execution branch:
   - `src/app/api/v1/admin/sync-classes/route.ts`
   - `src/components/dashboard/DashboardSidebarNav.tsx`
   - bracket-heading fixes in `src/components/playground/*` and `src/components/dashboard/*`
   - forced class sync and multi-school cache invalidation in `src/lib/schools/class-loader.ts`

2. Confirm `ai/` artifacts are not staged:
   - `git diff --cached --name-only | Select-String '^ai/'` must return nothing.
   - Bash equivalent: `git diff --cached --name-only | grep '^ai/'`.
   - If it returns files, run `git restore --staged -- ai` and document that the files remain untracked.

3. Create a small validation folder only if screenshots or notes are generated during M6:
   - `ai/m6-validation/README.md`
   - `ai/m6-validation/screenshots/*.png`
   - These are optional artifacts. Do not create them just to create them.

### Phase 1 - Make `/search` a real UI

#### 1.1 Add a public search helper

Add `src/lib/public-search.ts`.

Exports:

```ts
export type PublicSearchType = "all" | "posts" | "comments" | "agents" | "groups";

export interface PublicSearchResult {
  id: string;
  type: "post" | "comment" | "agent" | "group";
  title: string;
  href: string;
  excerpt?: string;
  meta: string;
}

export async function searchPublicSafeMolt(
  q: string,
  options?: { type?: PublicSearchType; limit?: number }
): Promise<PublicSearchResult[]>;
```

Implementation rules:

- Trim query to 100 characters for display and search.
- Return `[]` for empty queries.
- Cap `limit` at 30.
- Use existing store methods only:
  - `searchPosts(q, { type: "posts" | "comments" | "all", limit })` for post/comment results.
  - `listAgents()` filtered in process for public agent names, display names, and descriptions.
  - `listGroups()` filtered in process for group names, display names, and descriptions.
- Note: `src/lib/store-types.ts` still declares a simplified `searchPosts(query)` signature. The barrel export from `@/lib/store` resolves to the actual `store/posts/{db,memory}.ts` implementations, which support `(q, { type?, limit? })` and return a discriminated union for posts/comments. M6 imports from `@/lib/store` directly. Do not update the interface in M6; that is a store-types cleanup for a future milestone.
- Each `searchPosts` result item is `{ type: "post"; post } | { type: "comment"; comment; post }`. Destructure by `item.type` before mapping into `PublicSearchResult`.
- When `type` is `"agents"` or `"groups"`, skip `searchPosts` entirely and only filter `listAgents()` or `listGroups()`.
- Do not call `/api/v1/search`; it is authenticated by design.
- Sort exact name/title matches first, then prefix matches, then substring matches. Keep the scoring helper private to the file.
- Result hrefs:
  - post: `/post/${post.id}`
  - comment: `/post/${post.id}#comment-${comment.id}` only if comment anchors already exist; otherwise `/post/${post.id}`
  - agent: `/u/${agent.name}`
  - group: `/g/${group.name}`
- Result title/excerpt mapping:
  - post: `title = post.title`; `excerpt = post.content`.
  - comment: `title = truncated comment.content`; `excerpt = parent post title`.
  - agent: `title = agent.displayName || agent.name`; `excerpt = agent.description`.
  - group: `title = group.displayName || group.name`; `excerpt = group.description`.

The db store already caps `listAgents()` at 500, while memory implementations can be unbounded. Cap `listAgents()` results to the first 500 entries before filtering so the helper is store-agnostic. Do not change store function signatures in M6.

#### 1.2 Replace the placeholder page

Update `src/app/search/page.tsx`:

- Keep it a server component.
- Keep the current async `searchParams` shape and read it with `await searchParams`.
- Render a real `<form role="search" method="get">`.
- Fields:
  - `<input name="q">` with current query as `defaultValue`.
  - `<select name="type">` with `all`, `posts`, `comments`, `agents`, `groups`.
  - Submit button using `btn-primary`.
- Use a `mono-row` result list.
- Empty states:
  - No query: one terse line, "Search public agents, groups, posts, and comments."
  - Query with no results: `No results for "<query>".`
  - Query too short after trimming: treat as no query.
- Preserve the API docs hint, but move it below results as muted copy:
  - "Agent-key API search remains available at `GET /api/v1/search?q=...`."
- Add `export const dynamic = "force-dynamic"` only if build validation shows the page tries to prerender through a database read. Prefer data-level caching if needed.

#### 1.3 Tests for search

Add tests:

- `src/__tests__/lib/public-search.test.ts`
  - Empty query returns `[]`.
  - Type filtering works.
  - Exact/prefix matches sort ahead of substring matches.
  - Post/comment hrefs are stable.
- `src/__tests__/app/search-page.test.tsx`
  - Renders a search input.
  - Preserves query/type in controls.
  - Renders empty state when no results.

If route-level server component testing is awkward, keep the helper tests and add one lightweight snapshot for the form component after extracting a small `SearchForm` component.

### Phase 2 - Finish non-functional bracket cleanup

Run:

```powershell
git grep -n -E "<h[123][^>]*>\\[|<h[123][^>]*>.*\\[[A-Za-z]" -- src/app src/components
```

Review every match manually.

Expected keepers:

- `src/app/u/[name]/page.tsx`: `[u/{agent.name}]` is a functional handle.
- `src/app/g/[name]/page.tsx`: `[g/{group.name}]` is a functional group handle.
- `src/app/evaluations/[sip]/EvaluationPageClient.tsx`: `[SIP-*]` is a functional identifier if rendered with the evaluation name.

Expected fixers:

- `src/components/playground/SystemCard.tsx`
  - Remove the `[{emoji}]` bracket wrapping from the `<h3>` so the heading reads either `{emoji} {title}` or just `{title}`.
  - The tags line is already in muted metadata and can keep its brackets because the tags function as metadata labels.
- `src/app/u/[name]/loading.tsx`
  - Change the H1 to `Agent profile`.
  - Keep placeholder rows bracketed if they are system loading text.

Also run a broader section-label search:

```powershell
git grep -n -E "agent-dashboard-label|\\[[A-Za-z][A-Za-z ]+\\]" -- src/app src/components
```

Do not blindly remove brackets. The executor must classify each occurrence as functional or decorative in the validation results.

### Phase 3 - Fix mobile-hostile tables and dense rows

#### 3.1 About timeline

Update `src/app/about/page.tsx` timeline section:

- Keep the desktop table for `sm` and wider viewports.
- Add a mobile-only stacked list for narrow viewports.
- Use one shared `timelineRows` array so the data is not duplicated manually.

Shape:

```ts
const timelineRows = [
  { when: "...", event: "...", why: "...", rowKey: "jan-28" },
];
```

Render:

- Mobile: `<div className="sm:hidden">` with one `mono-row` per item.
- Desktop: `<div className="hidden overflow-x-auto sm:block">` with the existing table.
- Both mobile and desktop views must preserve the reactions column by rendering `<TimelineReactionCell rowKey={row.rowKey} initial={cell(r, row.rowKey)} />` for each row.

This avoids horizontal scroll on mobile while preserving dense scanability on desktop.

#### 3.2 Other tables

Audit the grep output from Phase 0:

- `src/app/evaluations/[sip]/EvaluationPageClient.tsx`
- `src/components/dashboard/AdmissionsStaffClient.tsx`
- `src/components/dashboard/ProfessorClassManager.tsx`

For M6, only fix tables that are visibly broken on mobile or use rounded/card styling that clashes with the current direction. Do not rewrite every table.

Decision rule:

- If it is a true data table for staff workflows, keep the table but ensure the scroll container has plain `border border-safemolt-border`, not rounded visual chrome.
- If it is a small informational timeline or three-column content list, render stacked mobile rows.

### Phase 4 - Authenticated dashboard visual audit

M5 could not visually inspect several dashboard pages because auth was unavailable. M6 makes this explicit and validates what can be validated locally.

Routes to inspect:

- `/dashboard`
- `/dashboard/admissions`
- `/dashboard/admissions/staff`
- `/dashboard/settings`
- `/dashboard/connectors`
- `/dashboard/teaching`
- `/dashboard/agents/[agentId]` for a linked agent

Execution options, in order:

1. Use an existing authenticated local browser profile if available in the local dev environment.
2. If not available, run component-level render tests for the heavy dashboard components with representative props.
3. If a route cannot be inspected because auth/data is unavailable, record that as a validation gap in `AI VALIDATION RESULTS` and do not pretend it was visually validated.

Patch only obvious UI issues:

- Text overflow inside buttons, nav rows, and headers.
- Rounded card/table chrome that contradicts the mono primitives.
- Bracketed decorative headings.
- Nested cards where a `mono-block` or bare layout is sufficient.
- Missing focus-visible affordances on custom controls.

Do not change auth, provisioning, or dashboard product flows in M6.

### Phase 5 - Validation artifact cleanup

1. Remove stale claims from generated docs if M6 changes contradict them. In particular, any newly generated validation note must not point at `ai/m5-screenshots/*` as current evidence.
2. If screenshots are regenerated, name them by route and viewport:
   - `ai/m6-validation/screenshots/search-desktop.png`
   - `ai/m6-validation/screenshots/search-mobile.png`
   - `ai/m6-validation/screenshots/about-mobile.png`
   - Optional dashboard screenshots only if authenticated preview was actually available.
3. Keep screenshots/logs unstaged unless the user explicitly wants validation artifacts committed.
4. Before final handoff, run:

```powershell
git diff --cached --name-only | Select-String "^ai/"
```

Bash equivalent:

```bash
git diff --cached --name-only | grep '^ai/'
```

It should return nothing unless the user explicitly asked to commit plan/validation docs.

## BETTER ENGINEERING INSIGHTS + BACKLOG ADDITIONS

1. **`ai/PLAN.md` still contains Codex app-server and CodexAgent planning instructions that do not apply to SafeMolt.** M6 does not edit the meta-process file, but a future documentation cleanup should split "SafeMolt milestone process" from older Codex-agent process language.

2. **Root `LEARNINGS.md` is the durable engineering-wisdom file.** `ai/PLAN.md` refers to `LEARNINGS.md`; in this repo that means the root file, not `ai/LEARNINGS.md`. M6 should use the root file for validation and only update it for insights that remain true after renaming modules and shipping new features.

3. **Search currently has two audiences: public humans and authenticated agents.** M6 keeps `/api/v1/search` protected and creates a page-local public search helper. If public search grows, promote the helper to a first-class public API only with a rate-limit and cache plan.

4. **Tables need an explicit responsive policy.** M6 creates the rule: content timelines become stacked mobile rows; staff data grids can remain horizontally scrollable when the table shape is central to the workflow.

5. **Visual validation artifacts should be evidence, not memorabilia.** Old screenshots are useful locally but dangerous when staged after the UI changes. Future milestones should keep validation artifacts under milestone-specific folders and stage them only by explicit product decision.

## AI VALIDATION PLAN (how will the Executor of this plan know when it is done?)

Static checks:

1. `npm run lint`
2. `npx tsc --noEmit`
3. `npm test -- --runInBand`
4. `git diff --check`
5. `git diff --cached --check` if staging is part of the execution

Focused tests:

6. New public search helper tests pass.
7. Search page render/form tests pass.
   - Tests should import the new public search helper, not call `searchPosts` through the legacy `store-types.ts` interface.
8. Loading skeleton snapshots update only if skeleton text changed.

UI searches:

9. `git grep -n -E "<h[123][^>]*>\\[|<h[123][^>]*>.*\\[[A-Za-z]" -- src/app src/components` returns only functional identifier headings, and each remaining occurrence is listed in validation results with "keep" rationale.
10. `git grep -n "rounded" -- src/app/search src/app/about src/components/dashboard src/components/playground` is reviewed for newly touched files so M6 does not introduce rounded chrome.

Visual validation:

11. Browser-preview `/search` at desktop and mobile. Confirm the input, type select, button, empty state, and result rows do not overlap or resize unexpectedly.
12. Browser-preview `/about` at 375px width. Confirm the timeline is readable without horizontal scrolling.
13. Browser-preview `/playground` at desktop if touched by bracket cleanup. Confirm the SystemCard section still reads clearly.
14. Authenticated dashboard routes are visually inspected if auth is available. If not, record the gap plainly.

Performance sanity:

15. Run a local timing smoke for touched public routes:

```powershell
npm run perf:smoke -- http://localhost:3000 /search /search?q=test /about
```

If no dev or production server is running, start one for the validation phase and record the URL used.

If `perf:smoke` fails because the environment cannot run the server or the smoke script, record the failure reason and continue. This timing smoke is a sanity check, not the release gate.

Artifact hygiene:

16. `git diff --cached --name-only | Select-String "^ai/"` returns nothing unless the user explicitly asked to stage plan/validation artifacts.

Bash equivalent for step 16:

```bash
git diff --cached --name-only | grep '^ai/'
```

## AI VALIDATION RESULTS (how did the Executor show that it was done?)

Implemented M6 on top of the already staged M5 follow-up baseline. `git diff --cached --name-only | Select-String "^ai/"` returned nothing at the start and again before handoff; M6 validation artifacts were written under `ai/m6-validation/` and left unstaged.

Code changes:

- Added `src/lib/public-search.ts` with public server-side search over posts, comments, agents, and groups using only `@/lib/store`.
- Replaced `/search` with a server-rendered form, type filter, result rows, and empty states; kept `/api/v1/search` unchanged and authenticated.
- Added `src/app/search/SearchForm.tsx`, public search helper tests, and search-page render tests.
- Converted the About timeline to shared `timelineRows` data with stacked mobile rows and the existing table on `sm` and wider screens.
- Removed decorative bracket headings from `SystemCard` and the agent-profile loading H1 while preserving functional `[SIP-*]`, `[g/name]`, `[u/name]`, metadata tags, and loading placeholders.
- Tightened staff/evaluation table chrome: plain bordered scroll containers, min-width data tables where appropriate, and no rounded chrome in M6-touched dashboard files.
- Cleaned a nested `dialog-box` pattern in the evaluation session modal, labeled the results action column, and made touched dashboard effects dependency-clean.

Static and unit validation:

- `npm run lint` passed.
- `npx tsc --noEmit` passed.
- `npm test -- --runInBand` passed: 41 suites, 207 tests, 13 snapshots.
- `npm run build` passed against `.env.local` / Neon. Build output classified `/search` as dynamic (`ƒ /search`), so no explicit `export const dynamic = "force-dynamic"` was needed.
- `git diff --check` passed. Git reported CRLF normalization warnings only.

Focused validation:

- `npm test -- --runInBand src/__tests__/lib/public-search.test.ts src/__tests__/app/search-page.test.tsx` passed: 12 tests.
- Public search tests cover empty queries, 100-character query trimming, type filtering, exact/prefix/substring ranking, cross-type ranking across posts/groups/agents, stable post/comment hrefs, group-only search, and bounded group scanning.
- Search page tests cover the form, preserved query/type controls, empty state, and rendered result rows.
- Loading skeleton snapshot updated only for the intentional `Agent profile` H1 change.

UI searches:

- `git grep -n -E "<h[123][^>]*>\\[|<h[123][^>]*>.*\\[[A-Za-z]" -- src/app src/components` returns only functional heading identifiers:
  - `src/app/evaluations/[sip]/EvaluationPageClient.tsx` keeps `[SIP-*]`.
  - `src/app/g/[name]/page.tsx` keeps `[g/name]`.
  - `src/app/u/[name]/page.tsx` keeps `[u/name]`.
- The broader bracket search was reviewed. Kept bracketed loading/status/activity metadata such as playground status tags, class status tags, result states, API path literals, and console labels. Removed the two M6 decorative heading cases.
- `rounded` was reviewed in touched areas. No rounded chrome remains in the M6-touched files; remaining dashboard rounded hits are pre-existing untouched controls/modals or semantic toggles outside M6 scope.

Visual and route validation:

- Started a local dev server at `http://127.0.0.1:3000` and captured fresh M6 screenshots under `ai/m6-validation/screenshots/`.
- `/search` desktop: form, type select, button, empty state, API hint, and Home row rendered without overlap.
- `/search?q=test` at 375px: controls stacked cleanly and result rows remained readable.
- `/about` at 375px: timeline rendered as stacked entries with reaction cells and no mobile table scroll.
- `/playground` desktop: SystemCard headings read without decorative emoji brackets; tag metadata brackets remain.
- `/dashboard` without a signed-in local browser profile redirects to login; authenticated dashboard routes could not be visually inspected. This is recorded as an M6 validation gap. Code/component-level polish was still applied to the touched dashboard/staff data-table surfaces.

Performance sanity:

- `npm run perf:smoke -- http://127.0.0.1:3000 /search /search?q=test /about` passed:
  - `/search` avg `40.3ms`, min `30.8ms`, max `47.0ms`, bytes `16813`.
  - `/search?q=test` avg `488.5ms`, min `454.4ms`, max `571.3ms`, bytes `49553`.
  - `/about` avg `172.5ms`, min `140.0ms`, max `256.1ms`, bytes `38047`.

Review and cleanup:

- Claude initial review loop completed with no blockers after four read-only review rounds. Actionable suggestions taken: removed remaining rounded chrome in the touched staff component, added cross-type and scan-cap search tests, cleaned hook dependencies, labeled an action column, capped group scanning, aligned table header chrome, reused public search normalizers, and removed nested modal `dialog-box` usage.
- Five parallel better-engineering reviews were run for correctness, style/design compliance, LEARNINGS compliance, milestone goals, and KISS/refactoring. Actionable findings were addressed. No root `LEARNINGS.md` or `ARCHITECTURE.md` updates were needed; new notes were milestone-specific and kept here.
- A final extra Claude re-review was rerun after the quota reset and completed successfully. Claude reported no blockers and no additional code or documentation changes needed; the review log is `ai/m6-validation/claude-final-review-after-quota.txt`.

## USER VALIDATION SUGGESTIONS

1. Open `/search`. You should see a real search input, a type selector, and a Search button immediately.
2. Search for an agent name, a group name, and a word that appears in a post. Results should appear as compact rows with clear type metadata and links.
3. Open `/search` on a phone-width viewport. The form controls should stack or wrap cleanly without text overflow.
4. Open `/about` on a phone-width viewport. The timeline should read as stacked entries, not a tiny table that demands sideways scrolling.
5. Open `/playground`. The "Under the hood" cards should no longer use bracketed headings for decorative markers.
6. Sign in and walk `/dashboard`, `/dashboard/settings`, `/dashboard/connectors`, `/dashboard/teaching`, and one agent workspace. Look for clipped labels, nested cards, or headings that still look like old bracket placeholders.
7. Check the pending diff before commit. It should contain source/test changes, not stale `ai/m5-screenshots` or old log files.
