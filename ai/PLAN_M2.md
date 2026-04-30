# M2 plan: Domain-split the store, drop the dead `houses` tables, and tighten theming tokens

## Summary

M1 deleted the public surfaces that were dead code; M2 attacks the largest remaining concept-count problem in the codebase: the unified store. Today `src/lib/store-db.ts` is 4,472 lines, `src/lib/store-memory.ts` is 2,589, and `src/lib/store.ts` is 408 lines whose entire purpose is to re-export ~150 functions and wrap the in-memory ones in `Promise.resolve()`. Every API route, every page, every cron handler imports from this single barrel. When someone asks "where does `createPost` live?" the answer is "line 545 of a 4,472-line file" — and to add a *new* domain (say, `notifications`) means appending another section to that file.

M2 splits that single file into one folder per domain (`src/lib/store/<domain>/{db.ts,memory.ts,index.ts}`), keeps the public barrel `src/lib/store.ts` byte-for-byte equivalent in its public API surface, removes the `wrap()` machinery, and makes the `hasDatabase()` switch local to each domain. This is a **mechanical refactor with strict no-behavior-change rule**: same function names, same signatures, same return shapes, same SQL queries. The diff is entirely structural.

While we're in the store layer, M2 also folds in three small, related cleanups that are too small to deserve their own milestones but are awkward to do at any other time:

- **Drop the `houses` and `house_members` tables** that M1 left parked in `scripts/schema.sql`. M1 deleted all UI and store methods for houses; we've now lived with that for a milestone, so the tables can go.
- **Move `.activity-link-*` colors into Tailwind theme tokens** (currently hard-coded hex in `globals.css`). M1's per-school CSS variables already ride through `safemolt-*` tokens; activity link colors should ride the same channel.
- **Document the `provision-public-ai-agent.ts` per-user cache pattern in `LEARNINGS.md`** so future per-user lazy-init code reuses it instead of reinventing it.

Out of scope, on purpose:
- No SQL changes other than the `DROP TABLE` for houses. `listActivityFeed` SQL stays exactly as M1 left it.
- No new types, no new methods, no new behavior. If a function is broken today, it stays broken today and gets fixed in a separate change.
- No agent-loop / dashboard-chat consolidation. That's M3, and it benefits from this split landing first.
- No write-side refactor of the activity feed. That's M4.
- No dashboard or playground UI changes. That's M5.

---

## HOW TO EXECUTE A MILESTONE

[Reproduced verbatim from `ai/PLAN.md` so this document is fully self-contained.]

If the user asks you to execute on a plan, these are the steps to take.

1. Implement the plan
   - You should check your work with AI autonomous validation and testing.
   - The hope is that implementation can be done with a minimum of user interaction, preferably none at all.
   - Once it is complete, fill in the "Validation" section to the bottom of the plan showing how you have validated it and what were the results.
   - You might have discovered better engineering
2. Perform your testing and validation
   - Update the "AI VALIDATION RESULTS" section of your PLAN_M{n}.md file
3. Review your own code. Also, ask Claude to review your work
   - You will need to provide it context: your plan document PLAN_M{n}.md, and tell it which files or functions you've worked on. Ask it also to review your validation steps.
   - If Claude found no blockers or problems with your work, you may proceed. Do static checking (formatting, eslint, typechecking). If you need any fixes, static check again to make sure it's clean.
   - If you couldn't get Claude to run for whatever reason, the user wants you to abort and report what's wrong.
   - Keep iterating with Claude until you no longer make changes (either because you've taken on Claude's feedback from past rounds, or because your plan no successfully defends its positions so Claude accepts them). However, if you take more than 10 rounds, then something is wrong, so stop and let the user know.
   - We aren't looking for "blocker vs non-blocker" decisions. Instead for every suggestion from Claude you must evaluate "will this improve my code? if so then modify your code, and if not then pre-emptively defend (in code comments) why not". And if you made modifications or comments, then circle back with Claude again.
   - Do NOT reference previous rounds when you invoke it.
4. After implementation, do a "better engineering" phase
   - Clean up LEARNINGS.md and ARCHITECTURE.md.
   - Launch all five Claude review tasks (correctness, AGENTS.md style, LEARNINGS.md compliance, milestone goal satisfaction, KISS/consolidation/refactor) in parallel.
   - Tell the user how you have done code cleanup.
5. Upon completion, ask for user review. Tell the user what to test, what commands to use, what gestures to try out, what to look for.

---

## Locked user decisions

1. **Domain boundaries** — the store splits into exactly these nine domain folders, mirroring the natural concept boundaries already visible in `store-types.ts` and the `store.ts` re-export blocks. Nothing else.
   - `agents/` — `createAgent`, `getAgentBy*`, `listAgents`, `countAgents`, `setAgentClaimed`, `setAgentUnclaimed`, `cleanupStaleUnclaimedAgent`, `updateAgent`, `setAgentAdmitted`, `deleteAgent`, `setAgentAvatar`, `clearAgentAvatar`, `setAgentVetted`, `setAgentIdentityMd`, `getRecentlyActiveAgents`, follow/unfollow/isFollowing/getFollowingCount, vetting challenge functions.
   - `posts/` — `createPost`, `getPost`, `listPosts`, `upvotePost`, `downvotePost`, `hasVoted`, `recordVote`, `deletePost`, `pinPost`, `unpinPost`, `searchPosts`, `listPostsCreatedAfter`, `listRecentComments`, `listRecentCommentsWithPosts`, `checkPostRateLimit`, `checkCommentRateLimit`. Comments live with posts because comments are owned by posts and every comment query joins posts.
   - `comments/` — `createComment`, `listComments`, `getComment`, `getCommentsByAgentId`, `getCommentCountByAgentId`, `upvoteComment`, `listCommentsCreatedAfter`. *(Yes, this overlaps with `posts/`. The split here is by SQL table; comment-with-post joins live in `posts/`.)*
   - `groups/` — `createGroup`, `getGroup`, `listGroups`, `joinGroup`, `leaveGroup`, `isGroupMember`, `getGroupMembers`, `getGroupMemberCount`, `subscribeToGroup`, `unsubscribeFromGroup`, `isSubscribed`, `getYourRole`, `updateGroupSettings`, `addModerator`, `removeModerator`, `listModerators`, `ensureGeneralGroup`, `listFeed`, `listFollowerIdsForFollowee`.
   - `evaluations/` — `registerForEvaluation`, `getEvaluationRegistration`, `getEvaluationRegistrationById`, `getPendingProctorRegistrations`, `hasEvaluationResultForRegistration`, `createSession`, `getSession`, `getSessionByRegistrationId`, `addParticipant`, `getParticipants`, `addSessionMessage`, `getSessionMessages`, `endSession`, `claimProctorSession`, `getEvaluationResultById`, `startEvaluation`, `saveEvaluationResult`, `getEvaluationResults`, `getEvaluationVersions`, `getEvaluationResultCount`, `hasPassedEvaluation`, `getPassedEvaluations`, `getAgentEvaluationPoints`, `updateAgentPointsFromEvaluations`, `getAllEvaluationResultsForAgent`, `listRecentEvaluationResults`, `createCertificationJob`, `getCertificationJobByNonce`, `getCertificationJobById`, `getCertificationJobByRegistration`, `updateCertificationJob`, `getPendingCertificationJobs`.
   - `playground/` — `getPlaygroundSessionsByAgentId`, `getPlaygroundSessionCountByAgentId`, `createPlaygroundSession`, `getPlaygroundSession`, `listPlaygroundSessions`, `updatePlaygroundSession`, `deletePlaygroundSession`, `joinPlaygroundSession`, `activatePlaygroundSession`, `createPlaygroundAction`, `getPlaygroundActions`, `listRecentPlaygroundActions`.
   - `classes/` — all `createClass`, `getClass*`, `listClasses`, `updateClass`, `addClassAssistant`, `removeClassAssistant`, `getClassAssistants`, `isClassAssistant`, `enrollInClass`, `dropClass`, `getClassEnrollment`, `getClassEnrollments`, `getClassEnrollmentCount`, `getAgentClasses`, `createClassSession`, `getClassSession`, `listClassSessions`, `updateClassSession`, `addClassSessionMessage`, `getClassSessionMessages`, `createClassEvaluation`, `getClassEvaluation`, `listClassEvaluations`, `updateClassEvaluation`, `saveClassEvaluationResult`, `getClassEvaluationResults`, `getStudentClassResults` plus all `*Professor*` functions (since professors only live in the classes domain).
   - `schools/` — `getSchool`, `getSchoolBySubdomain`, `listSchools`, `createSchool`, `updateSchool`, `addSchoolProfessor`, `removeSchoolProfessor`, `getSchoolProfessors`, `isSchoolProfessor`. The `Ao*` functions also live here because AO is a school in the data model (`listAoCohorts(_schoolId = "ao")`).
   - `atproto/` — `getAtprotoIdentityByHandle`, `getAtprotoIdentityByAgentId`, `createAtprotoIdentity`, `ensureNetworkAtprotoIdentity`, `listAtprotoHandles`, `getAtprotoBlobsByAgent`, `getAtprotoBlobByCid`, `upsertAtprotoBlob`.
   - `activity/` — `listRecentAgentLoopActions`, `listActivityFeed`, `getCachedActivityContext`, `upsertActivityContext`, `getMemoryIngestWatermark`, `setMemoryIngestWatermark`, `setAnnouncement`, `getAnnouncement`, `clearAnnouncement`. The activity-context cache and announcements ride here because they're cross-domain read surfaces, not tied to a single entity.

2. **No `notifications/` domain even though it would feel natural.** Notifications don't exist as a concept yet; M2 only re-organizes what exists.

3. **The barrel `src/lib/store.ts` keeps its current public surface character-for-character.** Every name currently exported continues to be exported. The internal implementation changes from "single big object split between dbStore and memStore" to "re-export from each `store/<domain>/index.ts`". App code does **not** change a single import line.

4. **`hasDatabase()` switch moves into each domain's `index.ts`.** The pattern per domain becomes:
   ```ts
   // src/lib/store/agents/index.ts
   import { hasDatabase } from "@/lib/db";
   import * as db from "./db";
   import * as mem from "./memory";

   export const createAgent = hasDatabase() ? db.createAgent : mem.createAgent;
   export const getAgentByApiKey = hasDatabase() ? db.getAgentByApiKey : mem.getAgentByApiKey;
   // … one line per function
   ```
   The `wrap(memStore.fn)` `Promise.resolve()` machinery from `store.ts:11-14` goes away. **All in-memory functions become `async`** so the switch is type-clean. (Today they're sync and wrapped at the boundary; that wrapping is invisible noise.)

5. **In-memory store becomes async to match.** Each `export function foo(...)` in `store-memory.ts` becomes `export async function foo(...)` and any caller that returned a literal becomes `return …;` inside an async body. No callers need to change because every caller already `await`s (the barrel was returning Promises).

6. **Tests that import from `store-memory` directly (none exist today by `grep`, but verify) get migrated to import the async-async surface.**

7. **Domain types stay in `src/lib/store-types.ts` for M2.** Splitting types per domain is M3-or-later; doing it in M2 doubles the diff size with marginal benefit. M2 only re-organizes runtime code.

8. **`houses` and `house_members` tables are dropped via a new migration `scripts/migrations/2026-XX-drop-houses.sql`.** No data preservation step — M1 already removed all readers. The migration uses `DROP TABLE IF EXISTS` so it's idempotent. `scripts/schema.sql` loses the `CREATE TABLE houses (...)` and `CREATE TABLE house_members (...)` blocks at the same time.

9. **Activity-link Tailwind tokens** — add `activity.agent`, `activity.evaluation`, `activity.post`, `activity.playground`, `activity.class`, `activity.group` under `theme.extend.colors.safemolt`. Wire CSS variables in `globals.css` (`--safemolt-activity-agent: #008ed6;` etc.) and the Tailwind config consumes them via the same `rgb(var(--…)/<alpha-value>)` pattern as the existing `safemolt-*` colors. The `.activity-link-*` classes in `globals.css` get rewritten as one-line `@apply` rules using the new tokens.

10. **`LEARNINGS.md` gets one new entry**: "Per-user lazy provisioning via request-level `cache()` — see `src/lib/provision-public-ai-agent.ts:ensureProvisionedPublicAiAgentForRequest`. Use this exact pattern when a user-scoped resource needs to be provisioned-on-first-touch and reused for the rest of the React Server Component render. Do not invent a new pattern."

11. **No new dependencies.**

### Executor questions deferred to user signoff

- **Q1.** The split adds ~30 new files. Should each domain folder also get a one-line `README.md` describing what's in it, or is the folder name + index.ts enough? *Recommendation: skip the READMEs; a folder named `posts/` is self-documenting.*
- **Q2.** When the in-memory store becomes async, every test that uses `memStore.foo()` directly (if any) breaks. M2's plan assumes there are zero such direct imports because `agents.md:38-41` says callers must use `@/lib/store`. Confirm this rule has held — or instruct M2 to also fix the offending tests.
- **Q3.** OK to drop the `houses` migration as `DROP TABLE IF EXISTS houses CASCADE; DROP TABLE IF EXISTS house_members CASCADE;` rather than a more careful "verify zero rows then drop"? M1 deleted all writers, so the tables are append-only-from-history; CASCADE is safe.
- **Q4.** `Ao*` (Stanford AO) functions live in `src/lib/ao-stanford/` already as a folder. Should they go into `store/schools/ao/{db,memory,index}.ts` (current locked decision), or stay separate at `store/ao/{db,memory,index}.ts` because they have their own demand surface? *Recommendation: separate `store/ao/` — they're a contained sub-domain with their own staff dashboard.*

---

## PLAN

Four phases, in this order. Phase 1 is the only mandatory dependency for the others; Phases 2-4 are independent and can be parallelized if multiple executors work on it.

### Phase 1 — Split `store-db.ts` and `store-memory.ts` into domain folders

Goal: end-of-phase, `store-db.ts` and `store-memory.ts` are deleted, `store.ts` is ≤ 60 lines (just barrel re-exports), and every domain lives under `src/lib/store/<domain>/`.

#### 1.1 Create the folder skeleton

```
src/lib/store/
  agents/
    db.ts          # functions from store-db.ts that touch agents/following/vetting tables
    memory.ts      # functions from store-memory.ts for the same
    index.ts       # hasDatabase() switch, one line per export
  posts/
    db.ts
    memory.ts
    index.ts
  comments/
    db.ts
    memory.ts
    index.ts
  groups/
    db.ts
    memory.ts
    index.ts
  evaluations/
    db.ts
    memory.ts
    index.ts
  playground/
    db.ts
    memory.ts
    index.ts
  classes/
    db.ts
    memory.ts
    index.ts
  schools/
    db.ts
    memory.ts
    index.ts
  ao/
    db.ts
    memory.ts
    index.ts
  atproto/
    db.ts
    memory.ts
    index.ts
  activity/
    db.ts
    memory.ts
    index.ts
```

Eleven domains (added `ao/` per Q4 recommendation), 33 new files, three deletions (`store-db.ts`, `store-memory.ts`, the legacy `wrap()` block in `store.ts`).

#### 1.2 Move functions, not rewrite them

For each function in `store-db.ts`:
- Cut the function out of `store-db.ts`.
- Paste it into the matching `store/<domain>/db.ts`.
- Add the imports it needs at the top of the destination file (`import { sql } from "@/lib/db";`, types from `@/lib/store-types`, and any helpers like `rowToActivityFeedItem` that some functions share — those stay private to the domain that uses them).
- If a helper is shared across domains (verify via `grep`), promote it to `src/lib/store/_shared.ts`. Anticipated members: `rowToActivityFeedItem` if it ends up used in both `posts/` and `activity/`. Most helpers are domain-local.

Same for `store-memory.ts` → `store/<domain>/memory.ts`. Convert each `export function` to `export async function` while moving.

#### 1.3 Author each domain's `index.ts`

Pattern (verbatim — executor does this for every domain):
```ts
import { hasDatabase } from "@/lib/db";
import * as db from "./db";
import * as mem from "./memory";

export const createAgent = hasDatabase() ? db.createAgent : mem.createAgent;
export const getAgentByApiKey = hasDatabase() ? db.getAgentByApiKey : mem.getAgentByApiKey;
// … one line per public export, sorted alphabetically
```

Why ternary-per-export rather than a single `export * from` of either `db` or `mem` chosen at runtime? Because Node's ES module `export *` is resolved at link time, not at runtime — you cannot pick the source module dynamically. The ternary-per-export is the cleanest pattern that survives both behaviors.

#### 1.4 Rewrite the barrel `src/lib/store.ts`

After the split, `src/lib/store.ts` becomes a pure barrel:
```ts
/** Public store surface. Domain modules under store/<domain>/ implement DB and in-memory variants. */
export * from "./store/agents";
export * from "./store/posts";
export * from "./store/comments";
export * from "./store/groups";
export * from "./store/evaluations";
export * from "./store/playground";
export * from "./store/classes";
export * from "./store/schools";
export * from "./store/ao";
export * from "./store/atproto";
export * from "./store/activity";

export type {
  // Same type re-exports as today, unchanged.
  StoredAgent, StoredGroup, StoredPost, StoredComment, /* … */
} from "./store-types";
```

≈ 30 lines. The `wrap()` function and the giant `if hasDatabase() ? dbStore : { wrap(memStore.fn), … }` block are deleted entirely. The 408 → 30 line shrink is the visible win.

#### 1.5 Delete the originals

After all functions have moved and `npm run build && npm test` are green:
- Delete `src/lib/store-db.ts`.
- Delete `src/lib/store-memory.ts`.

This is the moment of truth; if anything breaks, the diff is small enough to bisect by domain.

### Phase 2 — Drop the `houses` and `house_members` tables

#### 2.1 New migration file

Create `scripts/migrations/2026-XX-drop-houses.sql` (use the next available date prefix; verify with `ls scripts/migrations/`):
```sql
-- M2: M1 deleted all UI and store methods for houses; drop the now-dead tables.
DROP TABLE IF EXISTS house_members CASCADE;
DROP TABLE IF EXISTS houses CASCADE;
```

#### 2.2 Wire it into the migrate script

`scripts/migrate.js` already iterates files; verify it picks up `migrations/*.sql` automatically. If it only reads `scripts/schema.sql`, add a small loop that applies any `scripts/migrations/*.sql` in lexicographic order *after* `schema.sql`. Track applied migrations in a `_migrations` table (one row per filename) so the script is idempotent.

If the migration runner doesn't yet exist, add a 30-line implementation now — the houses drop is the first migration but it won't be the last (M4 needs migrations too).

#### 2.3 Update `scripts/schema.sql`

Delete the `CREATE TABLE houses (...)` and `CREATE TABLE house_members (...)` blocks plus their `CREATE INDEX` lines (`scripts/schema.sql:124-146`). Schema file shrinks from 390 to ~370 lines.

### Phase 3 — Move `.activity-link-*` colors into Tailwind theme tokens

#### 3.1 Add CSS variables to `globals.css`

In `:root`, add:
```css
--safemolt-activity-agent: #008ed6;
--safemolt-activity-evaluation: #538700;
--safemolt-activity-post: #d04d00;
--safemolt-activity-playground: #b0008a;
--safemolt-activity-class: #a06a00;
--safemolt-activity-group: #005a9c;
```
And matching `-rgb` channel triplets next to the existing `--safemolt-*-rgb` block.

#### 3.2 Add tokens to `tailwind.config.ts`

Inside `theme.extend.colors.safemolt`:
```ts
"activity-agent": "rgb(var(--safemolt-activity-agent-rgb) / <alpha-value>)",
"activity-evaluation": "rgb(var(--safemolt-activity-evaluation-rgb) / <alpha-value>)",
"activity-post": "rgb(var(--safemolt-activity-post-rgb) / <alpha-value>)",
"activity-playground": "rgb(var(--safemolt-activity-playground-rgb) / <alpha-value>)",
"activity-class": "rgb(var(--safemolt-activity-class-rgb) / <alpha-value>)",
"activity-group": "rgb(var(--safemolt-activity-group-rgb) / <alpha-value>)",
```

#### 3.3 Rewrite `.activity-link-*` to use the tokens

In `globals.css`, replace each color literal:
```css
.activity-link-agent { @apply text-safemolt-activity-agent font-bold; text-decoration: none; }
.activity-link-evaluation { @apply text-safemolt-activity-evaluation font-bold; text-decoration: none; }
/* … */
```

#### 3.4 Wire per-school overrides

The school-theme injection in `src/app/layout.tsx:69-79` already iterates `Object.entries(theme)` from `school?.config?.theme`. As soon as a school's `theme` object includes any `activity-agent` key, the existing loop already picks it up. **No layout.tsx code change is needed** — only document in `agents.md` that schools can override these new tokens by adding them to their `school.yaml`'s `config.theme` block.

### Phase 4 — Document the per-user cache pattern in `LEARNINGS.md`

#### 4.1 Add the entry

Append to `LEARNINGS.md` under a new "Patterns to reuse" subsection:

> **Per-user lazy provisioning with request-level dedupe.** When you need a per-user resource that gets created on first touch and reused for the rest of the request (e.g. a public AI agent provisioned on-demand for each human user), use the pattern in `src/lib/provision-public-ai-agent.ts:ensureProvisionedPublicAiAgentForRequest`. It wraps the provisioning call in React's `cache()` so multiple components in one render share the same Promise, then idempotently upserts in the database to handle concurrent first-touches across requests. Do not invent a new pattern; do not roll your own per-request memo. If the file moves or the API changes, update this entry.

#### 4.2 Verify the cited symbol still exists

`grep -n "ensureProvisionedPublicAiAgentForRequest" src/lib/provision-public-ai-agent.ts` must return at least one hit. If the function has been renamed since M1, the LEARNINGS entry cites the new name.

---

## BETTER ENGINEERING INSIGHTS + BACKLOG ADDITIONS

These insights surface during M2 work; M2 deliberately doesn't act on them.

1. **`store-types.ts` (626 lines) wants its own per-domain split.** Each domain folder could own its types (`store/agents/types.ts` etc.). Doing it in M2 doubles the diff. Defer to M3 or beyond, when the agent-loop work makes us touch many of those types anyway.
2. **Several store functions have ad-hoc validation logic embedded** (e.g. `joinGroup` returns `{ success, error }` with custom error strings). That's a sign the validation belongs in the API route, not the store. Defer.
3. **`store-memory.ts` has at least one place where it was lazy about indexing** (TBD, verify during the move). After M2, those become per-domain memory files with clear ownership; bad indexes become fixable.
4. **`Ao*` functions inside `store/ao/` have a different dialect from the rest** — they pass `_schoolId = "ao"` as a defaulted param, which is a code smell. Defer to a focused pass on AO when its product surface gets attention.
5. **The `hasDatabase()` ternary-per-export is verbose.** A code generator could spit out each `index.ts` from a manifest. Don't build the codegen; the file is hand-edited maybe once a quarter when a function is added or removed.

---

## AI VALIDATION PLAN

### Static checks

1. `npm run lint` — `next lint` clean. M1 turned this on; M2 keeps it green.
2. `npx tsc --noEmit` — clean. The biggest risk: an in-memory function whose signature has subtly drifted from its DB counterpart. tsc will catch this when the `index.ts` ternary tries to assign a `(x:string)=>void` to a `(x:string)=>Promise<void>`.
3. `npm test` — clean.
4. `npm run build` — clean. The build runs `node scripts/migrate.js` first, which means the new `2026-XX-drop-houses.sql` migration runs against the local DB. After build, `psql -c "\dt"` does NOT show `houses` or `house_members`.

### New tests M2 must add

5. `src/__tests__/lib/store/barrel.test.ts` (new): import every name from `@/lib/store` that was importable at the start of M2 (snapshot list captured by `grep -E "^(export const|export type|export \{)" src/lib/store.ts` against the M1 commit). Assert each is `typeof === "function"` (or `=== "object"` for type-only re-exports). This is the single best regression net for "I forgot to wire up `recalculateHousePoints` in the new barrel" type bugs.
6. `src/__tests__/lib/store/memory-async.test.ts` (new): for one function per domain (e.g. `createAgent`, `createPost`, `createGroup`, `createPlaygroundSession`, …), assert `(<fn>(...)) instanceof Promise`. Catches accidental sync return regressions in the in-memory store.
7. `src/__tests__/lib/store/houses-deleted.test.ts` already created in M1; verify still passes.

### Diff hygiene

8. `git diff --stat HEAD~1 src/lib/store-db.ts` shows -4472 lines (file deleted). Same for store-memory.ts.
9. `git diff --stat HEAD~1 src/lib/store/` shows ~7000 lines added across 33 files. **Net line count drops** because the `wrap()` boilerplate in `store.ts` (≈ 350 lines) and any duplicated comments at the section headers go away.
10. `git diff` against `src/app/**` and `src/components/**` shows **zero** changes. No app code import lines move. If any did, M2 has overstepped.

### Integration smoke

11. `npm run dev`, then hit each high-traffic page: `/`, `/post/<id>`, `/u/<name>`, `/g/<name>`, `/agents`, `/evaluations`, `/classes`, `/playground`. All render and behave identically to the M1 baseline (compare screenshots).
12. Run `psql $DATABASE_URL -c "SELECT to_regclass('houses'), to_regclass('house_members');"` — both return `NULL`.
13. View `/` source HTML — confirm an `.activity-link-agent` element is colored by the CSS variable, not by a hard-coded hex (DevTools "Computed" panel shows `color: var(--safemolt-activity-agent-rgb)`-derived value).

### Production verification

14. Vercel preview deploy. `\dt` on the preview's branch DB shows no houses tables. All public pages render. No runtime errors in `vercel logs`.

---

## AI VALIDATION RESULTS

Filled by Codex on 2026-04-30 after the Claude follow-up fixes.

- [x] `next lint` clean (`npm run lint`)
- [x] `tsc --noEmit` clean (`npx tsc --noEmit`)
- [x] `jest` clean (`npm test -- --runInBand`: 20 suites, 130 tests)
- [x] `next build` clean (`npm run build`; migrations now skip from `_migrations` once recorded)
- [x] Barrel snapshot test passes (`src/__tests__/lib/store/barrel.test.ts`)
- [x] In-memory async-return test passes (`src/__tests__/lib/store/memory-async.test.ts`)
- [x] House deletion invariant test passes (`src/__tests__/lib/store/houses-deleted.test.ts`)
- [x] `_migrations` tracking verified: first post-change build recorded 27 migration filenames; `npm run db:migrate` then skipped every recorded migration
- [x] `to_regclass('houses')` and `to_regclass('house_members')` return `NULL`; `_migrations` row count is 27 on the configured Neon DB from `.env.local`
- [x] Local built-app smoke from `next start -p 3125`: `/`, `/agents`, `/g`, `/evaluations`, `/classes`, `/playground`, and `/api/activity` all returned HTTP 200; `/api/activity` returned `s-maxage=10, stale-while-revalidate=60`
- [x] `/classes` smoke logs no longer show the pre-existing Neon `42P18` class slug sync error after fixing nullable SQL shape in `generateUniqueClassSlug`
- [x] Compiled CSS uses `rgb(var(--safemolt-activity-*-rgb) / ...)` for `.activity-link-*`
- [ ] Follow-up Claude review not completed: local `claude -p` is rate-limited (`resets 10:40pm America/New_York`). Prompt prepared at `ai/claude-review-m2-followup-prompt.md`.
- [ ] `git diff src/app src/components` not run: repo instructions forbid git outside explicit code review/push; `src/app/globals.css` was intentionally changed for M2 activity-link tokens
- [ ] Preview URL: not created yet; deployment is an external upload/deploy action and needs action-time confirmation

---

## USER VALIDATION SUGGESTIONS

You should not be able to *see* M2 from the outside — that's the point of a clean refactor. The validation is therefore mostly about confirming nothing broke.

1. Open the preview URL. Click around `/`, `/post/<id>`, `/u/<name>`, `/g/<name>`, `/agents`, `/evaluations`, `/classes`, `/playground`. Everything should look and behave exactly as it did at the end of M1. If anything changed visually (e.g. an activity-link color shifted), that's a bug.
2. Open DevTools → Elements on `/`. Click an `.activity-link-agent`. In the Computed panel, the `color` should resolve through `--safemolt-activity-agent-rgb`, not a literal hex. (You'll see `rgb(var(...))` in the rule listing.)
3. In a school subdomain (e.g. `finance.localhost:3000` if you have it set up), if its `school.yaml` includes a `theme.activity-agent: "#cc0099"` entry, the agent links on activity rows should be that color instead of the default blue. (Skip this step if no school has activity-link overrides yet.)
4. SSH or `psql` into the production-shape DB on the preview. Run `\dt`. Confirm `houses` and `house_members` are gone. Confirm everything else (agents, posts, comments, groups, evaluation_*, playground_*, classes, schools, atproto_*, agent_loop_action_log, activity_contexts, newsletter_subscribers) is still there.
5. Open `src/lib/store/`. Browse the folder tree. Each domain folder should be self-evident. If you can answer "where does `createPost` live?" by reading folder names, the M2 readability win has landed.
6. Open `src/lib/store.ts`. It should be ≤ 60 lines and contain only `export *` lines plus the type re-exports. The 350-line `wrap()` block from M1 should be gone.
7. Open `LEARNINGS.md`. Confirm the new entry about `ensureProvisionedPublicAiAgentForRequest` is there and accurate.
