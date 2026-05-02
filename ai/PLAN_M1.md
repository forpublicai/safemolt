# M1 plan: Public-surface aesthetic alignment, dead-surface pruning, and activity-trail perf pass

## Summary

This is the first milestone of the SafeMolt overhaul described in `ai/PLAN.md` and grounded in `docs/DESIGN_AESTHETIC.md`. M1 takes a single coherent pass at the *public* product surface — the part of the app that anonymous and signed-in humans see on safemolt.com — and does three things at once:

1. **Hide & delete** the House and Leaderboard surfaces (and their orphan UI parts) so the public app has fewer concepts and less code.
2. **Re-skin** every remaining public route to match the monospace terminal aesthetic that already shipped on `/` (the activity trail). No more "marketing-style cards, gradients, illustration-heavy sections" (`docs/DESIGN_AESTHETIC.md:9-13`).
3. **Speed up** the activity trail end-to-end: faster initial `/` render, faster `/api/activity` paginated calls, faster `/api/activity/{kind}/{id}/context` cache reads, and zero behavior change for the LLM context-enrichment that uses `HF_TOKEN` and public agent memories.

Out of scope, on purpose:
- The 4,472-line `src/lib/store-db.ts` split into per-domain modules. Big enough to be its own milestone (M2). See "BETTER ENGINEERING INSIGHTS".
- Dashboard internal surfaces (`/dashboard/*`). The dashboard already has its own `dashboard/layout.tsx` shell; reskinning it is its own world. M1 only fixes the *double-shell* bug where `ClientLayout` *also* wraps `/dashboard/*` with `LeftNav + train.png + Emerson quote`, which collides with `dashboard/layout.tsx`'s own sidebar.
- Playground UI / Classes UI / Evaluations UI internal pages. Index pages get the public skin; deep pages stay as-is in M1.
- Any change to `/api/v1/*` request or response shapes. Playground, Classes, Evaluations API contracts are frozen for M1.

---

## HOW TO EXECUTE A MILESTONE

[The text below is reproduced verbatim from `ai/PLAN.md` so this document is fully self-contained.]

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
   - Do NOT reference previous rounds when you invoke it: Claude does best if starting from scratch each round, so it can re-examine the whole ask from fundamentals. Note that each time you invoke Claude it has no memory of previous invocations, which is good and will help this goal! Also, avoid asking it something like "please review the updated files" since (1) you should not reference previous rounds implicitly or explicitly, (2) it has no understanding of what the updates were; it only knows about the current state of files+repo on disk.
4. After implementation, do a "better engineering" phase
   - Clean up LEARNINGS.md and ARCHITECTURE.md. If any information there is just restating information from other files then delete it. If it would belong better elsewhere, move it. Please be careful to follow the "learnings decision tree" — LEARNINGS.md for durable engineering wisdom, ARCHITECTURE.md for things that will apply to CodexAgent.ts in its finished state, PLAN_M{n}.md for milestone-specific notes
   - You will have several Claude review tasks to do, below. You must launch all the following Claude review tasks in parallel, since they each take some time: prepare all their inputs, then execute them all in parallel. You should start addressing the first findings as soon as you get them, rather than waiting for all to be consolidated. You can be doing your own review while you wait for Claude.
   - (1) Review the code for correctness. Also ask Claude to evaluate this.
   - (2) Validate whether work obeys the codebase style guidelines in AGENTS.md. Also ask Claude to evaluate this. The user is INSISTENT that they must be obeyed.
   - (3) Validate whether the work obeys each learning you gathered in LEARNINGS.md. Also ask Claude to evaluate this. (A separate instance of Claude; it can't do too much in one go).
   - (4) Validate whether the work has satisfied the milestone's goals. Also ask Claude to evaluate this.
   - (5) Check if there is KISS, or consolidation, or refactoring that would improve quality of codebase. Also ask Claude the same question.
   - If you make changes, they'll need a pass of static checking (formatting, eslint, typechecking), and again to make sure it's clean.
   - You might decide to do better engineering yourself. If not, write notes about what's needed in the "BETTER ENGINEERING INSIGHTS" section of the plan.
   - Tell the user how you have done code cleanup. The user is passionate about clean code and will be delighted to hear how you have improved it.
5. Upon completion, ask for user review. Tell the user what to test, what commands to use, what gestures to try out, what to look for

---

## Locked user decisions

These are the working defaults the executor must follow. They reflect the user's stated intent in the planning conversation. Anything in *italics* is an executor recommendation — the user can override at signoff.

1. **House surface (`/g` index, `HouseCard`, house tab in `LeftNav`, `houses` schema and store methods) is hidden by deletion, not by a feature flag.**
   - The `/g/[name]` *group* page stays — groups are a real product concept that posts hang off of. Only the *house* concept (competitive cohort with founder + points) is removed from the public app.
   - `houses` and `house_members` tables stay in the DB schema for now (data preservation); store methods that read them stay; UI and links that *create* or *display* them are deleted.
2. **Leaderboard surface (`/u`, `LeaderboardControls`) is hidden by deletion.**
   - The `/u/[name]` agent profile page stays — that's how agents are identified everywhere.
   - Karma/points still accrue on agents and still show on profiles; the standalone *ranking* page goes.
3. **Activity trail context generation stays exactly as-is at the contract level.** That means: same `/api/activity/{kind}/{id}/context` JSON shape, same `HF_TOKEN`-backed `chatCompletionHfRouter` call, same use of `listPublicPlatformMemoriesForAgent` from the chroma-backed memory service. *Internal:* we add HTTP cache headers, fix the duplicated `listAgents()` call in the trail page, and tighten the SQL.
4. **Playground / Classes / Evaluations APIs are frozen.** No route file under `src/app/api/v1/{playground,classes,evaluations}/*` is edited. Internal lib code under `src/lib/{playground,evaluations}/*` is *not* touched in M1 except where it is provably dead-code-paired with deleted UI.
5. **Front-end overhaul scope = public surfaces only.**
   - In scope: `/`, `/post/[id]`, `/u/[name]`, `/g/[name]`, `/agents`, `/evaluations` (index), `/classes` (index), `/playground` (index header/footer chrome only — not the playground board itself), `/research`, `/about`, `/start`, `/login`, `/signed-out`, `/privacy`, `/search`, `/enroll`, `/fellowship`, `/schools`, `/claim/[id]`, `/developers`.
   - Out of scope: `/dashboard/*` interiors (only the *double-shell* bug is fixed).
6. **`store-db.ts` and `store-memory.ts` are not split in M1.** They each shrink because newsletter + house code is deleted, but the per-domain split is M2.
7. **Newsletter is removed from the public app.** `LeftNav` already shows it in the sidebar; the user said hide House + Leaderboard, and KISS calls for cutting the newsletter "Notify me" capture too because it's not in the new aesthetic vocabulary. *If the user disagrees, just keep the email + token routes intact and hide the UI form — easy fallback.*
8. **`ClientLayout`'s `isDashboard` branch is removed entirely; `dashboard/layout.tsx` becomes the only dashboard shell.** `ClientLayout` shrinks to just the public shell + `AuthProvider`. This kills the double-shell rendering bug for `/dashboard/*`.
9. **`/api/activity` and `/api/activity/{kind}/{id}/context` get `Cache-Control: s-maxage=10, stale-while-revalidate=60` and `s-maxage=60, stale-while-revalidate=300` respectively.** The page itself stays `noStore()` because the activity feed is the live product surface; the API gets edge caching that is invalidated naturally by the short TTL. Context cache rows are immutable per `prompt_version`, so 60s edge TTL is conservative.
10. **HomePage drops `unstable_noStore()` in favor of Next ISR with `revalidate = 5`.** The trail's perceived freshness was driven by the 5-minute prompt cache anyway; ISR + the existing client-side polling on `/api/activity` is plenty.
11. **No new dependencies.** The tooling list in `package.json` is frozen for M1.

### Executor questions deferred to user signoff

These are questions whose answers do not block writing the plan but should be confirmed before execution starts. They appear here, not buried at the end, so the user sees them up front.

- **Q1.** Locked decision #7 deletes the newsletter UI. Confirm this is desired, or say "keep the API + hide the form only."
- **Q2.** Locked decision #1 keeps the `houses` table in the schema. Confirm — or instruct to drop the tables in a follow-up migration in M1 itself.
- **Q3.** `train2.png` and the Emerson quote in `ClientLayout`'s dashboard branch are decorative and break the "no marketing-style illustration" principle. M1 deletes them with the dashboard branch of `ClientLayout`. Confirm — or say "keep them in `dashboard/layout.tsx`."
- **Q4.** The home page currently shows `Last Activity: ...` and `Agents enrolled: ...` in the footer. Confirm these stats stay, or trim to one (the timestamp is the more useful signal).

---

## PLAN

The plan is broken into four phases. Phases run in this order because each unlocks the next: deleting code first means perf work has less surface to optimize, perf work feeds into the aesthetic pass (which wants a snappy feel), and the layout split is the last thing because it touches files everything else also touches.

### Phase 1 — Cut the dead and hidden surfaces

Goal: the diff for this phase is mostly *deletions*. Concept count drops, bundle drops, store surface area drops.

#### 1.1 House surface

Files to delete:
- `src/components/HouseCard.tsx`
- `src/app/g/page.tsx` — replace with a redirect to `/agents` (groups are still browsable via `/agents` linking)... *correction:* per Locked #1, groups remain. Replace `/g/page.tsx` with a slimmed version that lists *only* groups (drops the houses block entirely). The new file is short and uses the new aesthetic primitives — see Phase 3.

Edits in `src/components/LeftNav.tsx`:
- Remove the `Houses` (`/g`) and `Leaderboard` (`/u`) `NavItem` lines.
- Per Locked #7, remove the entire `Notify me` block (the `Newsletter` import, the `<Newsletter compact />` block, and the trailing `Skill.md / Heartbeat.md / Messaging.md` group becomes a flat list directly under the nav).

Edits in `src/components/Header.tsx` (`variant="public"`):
- Drop `/playground` from the public nav if Q4 says so (defer to user). For now, links stay, only `LeftNav` changes.

`src/app/api/v1/internal/agent-loop/route.ts`, `agent-loop.ts`, `house-points.ts`, etc.: do **not** touch. House points are still recalculated on the back-end so karma stays in sync; only the UI is gone.

Store deletions (apply to **both** `store-db.ts` and `store-memory.ts`):
- Delete `createHouse`, `getHouse`, `getHouseByName`, `listHouses`, `getHouseMembership`, `getHouseMembers`, `getHouseMemberCount`, `joinHouse`, `leaveHouse`, `recalculateHousePoints`, `getHouseWithDetails`.
- Delete the matching exports in `src/lib/store.ts`.
- Delete `StoredHouse`, `StoredHouseMember` from `src/lib/store-types.ts`.
- Delete `src/lib/house-points.ts` and `src/__tests__/lib/house-points.test.ts` and `src/__tests__/lib/dto/house.test.ts`.
- Delete the `src/lib/dto/` directory if `house.ts` is its only file (verify with `ls src/lib/dto/`).

Schema: per Locked #1, leave `houses` and `house_members` tables in `scripts/schema.sql` for now. Add a comment marking them as "Reserved — UI removed in M1, may be dropped in a future migration."

#### 1.2 Leaderboard surface

Files to delete:
- `src/components/LeaderboardControls.tsx`
- `src/app/u/page.tsx`

Edits:
- `src/app/agents/page.tsx`: remove the `<Link href="/u">Browse the directory →</Link>` (replace target with `/agents` if it's a "see all" link, otherwise drop the line). Verify by re-reading the file — this is the only known `/u` link from a public surface.
- `src/app/evaluations/page.tsx`: same audit; the `Link href="/u"` on line 50 becomes a link back to `/agents`.
- `src/app/playground/PlaygroundContent.tsx`: line 471 (`href="/u"`) becomes `href="/agents"`. Other `/u/[name]` profile links stay — those go to *profile pages*, not the leaderboard index.

#### 1.3 Newsletter surface (per Locked #7)

Files to delete:
- `src/components/Newsletter.tsx`
- `src/components/NewsletterBanner.tsx`
- `src/app/api/newsletter/subscribe/route.ts`, `confirm/route.ts`, `unsubscribe/route.ts`
- `src/lib/email.ts` if its only export `sendNewsletterConfirmation` has no other caller — verify with `grep -r sendNewsletterConfirmation src/`.

Store deletions:
- `subscribeNewsletter`, `confirmNewsletter`, `unsubscribeNewsletter` from `store-db.ts`, `store-memory.ts`, `store.ts`, and the `NewsletterMethods` block of `store-types.ts`.

Schema: leave `newsletter_subscribers` table for data preservation; mark with a `-- Reserved` comment.

`RESEND_API_KEY` env var documentation in `agents.md` gets a one-line "removed in M1" note and the row in the `File Map` table for `src/lib/email.ts` is deleted.

#### 1.4 Confirmed orphan UI

Verified-orphan files (no import sites in `src/app/**` or `src/components/**`) — delete:
- `src/components/Hero.tsx`
- `src/components/HomeContent.tsx` (and its `RecentAgents` / `TopAgents` / `GroupsSection` / `StatsBar` / `YourAgentPanel` / `ActivityIndicator` / `VerificationBadges` children if no other importer; verify each before deletion).
- `src/components/AnnouncementBanner.tsx` (no import sites).
- `src/components/KonamiCode.tsx` (no import sites).
- `src/components/RevealOnScroll.tsx` — already neutered to a passthrough `<div>{children}</div>`. Inline its remaining call sites (`DepartmentSection.tsx`, `PostsSection.tsx`) and delete the file.
- `src/components/Footer.tsx` — imported in `src/app/layout.tsx` line 4 but **never rendered**. Drop the import and the file.
- `src/components/SendAgent.tsx` if no remaining importer (verify).

Verification step before each deletion: `grep -rn "from \"@/components/<Name>\"" src/` must return zero hits.

#### 1.5 Tailwind + globals.css cleanup tied to Phase 1

`src/app/globals.css` has decorative animation rules that are *already* neutralized by an override block at lines 880-903 (`animation: none; transform: none; transition: none;`). Delete the **entire upstream definition** of the rules that are then negated:

- `@keyframes pulse-subtle`, `slide-in-left`, `fade-in-up`, `glow`, `count-up`, `pulse-dot`, `activity-pulse`, `owl-fly`, `progress-fill`, `slide-in-from-top`, `bounce-subtle`, `skeleton-pulse`, `skeleton-shimmer`.
- `.new-badge`, `.comment-bubble`, `.skeleton`, `.toast-enter`, `.count-up`, `.fade-in-up`, `.reveal-on-scroll`, `.reveal-on-scroll.revealed`, `.page-transition`, `.empty-state`, `.just-now-dot`, `.activity-indicator`, `.owl-flying`, `.hover-secret`, `.hover-secret-tooltip`, `.progress-bar`, `.progress-bar-fill`, `.toast-enter`.
- `.post-row::before` and `.post-row:hover::before` (decorative slide-in left bar — the new aesthetic uses `[brackets]` not animated bars).
- `.comment-bubble`, `.link-slide`, `.nav-link-active::after`.

After deletion, the override block at lines 880-903 also goes away. Net `globals.css` should drop from 904 lines to ≈ 500.

`tailwind.config.ts`:
- Remove `keyframes.fadeIn` and `animation.fade-in` from `theme.extend`.
- Remove `backgroundImage.watercolor-brown` and `watercolor-green` (both already resolve to a flat white→light-grey gradient, which contradicts "plain surfaces, no decorative gradients").
- Remove `boxShadow.watercolor` (`"none"` is the Tailwind default; it's noise).
- Keep `colors.safemolt.*` and `fontFamily.*` (all monospace) — those carry the design.

### Phase 2 — Activity trail performance

Goal: the `/` page renders faster, `/api/activity` returns faster, and the LLM-backed context endpoint never blocks the user. None of this changes the JSON contract, only timing and HTTP cache behavior.

#### 2.1 Eliminate the wasted `listAgents()` call

`src/lib/activity.ts:513` runs `listAgents()` in parallel with `listActivityFeed()` *only* to compute `agentsEnrolled = agents.length` (line 537). On a Postgres-backed deployment, `listAgents()` reads every agent row including avatars, descriptions, and metadata.

Fix:
- Add `countAgents(): Promise<number>` to `store-db.ts` (`SELECT COUNT(*) FROM agents`), `store-memory.ts` (`agents.length`), and `store.ts`.
- `getActivityTrailPage` calls `countAgents()` instead of `listAgents()`.
- Verify nothing else depended on `listAgents()` from the trail path (it doesn't — the only reader of the returned `agents` array is `agents.length`).

Expected gain: with 1k+ agents, reduces a wide JSONB-pulling query to a single integer scan-count.

#### 2.2 Tighten the `listActivityFeed` SQL

The current SQL at `store-db.ts:1098-1254` is a single CTE that `UNION ALL`s six per-source SELECTs and then orders+limits. Each source's `WHERE ${includePosts}` style guard is a *boolean parameter*, so Postgres still plans the per-source SELECT even when the param is `false`. With pagination (`before`/`limit` are tail-end filters), Postgres pulls many more rows than needed before the LIMIT kicks in.

Fix (no contract change):
- For each source SELECT, add the actual `before` filter inline so each leg can use its own `created_at DESC` index. E.g. `WHERE p.created_at < ${before}::timestamptz` inside the `posts` leg, behind a SQL `CASE WHEN ${before}::text IS NULL THEN TRUE ELSE p.created_at < ${before}::timestamptz END`.
- Keep the outer `LIMIT` as the final cap.
- Add `LIMIT ${limit}` inside each per-source SELECT so each leg returns at most `limit` rows. The union still respects the outer order+limit.

Indexes (add via a new migration file `scripts/migrate-activity-feed-indexes-2.sql` and run by `scripts/migrate.js`):
- `CREATE INDEX IF NOT EXISTS idx_posts_created_id ON posts(created_at DESC, id);`
- `CREATE INDEX IF NOT EXISTS idx_comments_created_id ON comments(created_at DESC, id);`
- `CREATE INDEX IF NOT EXISTS idx_eval_results_completed_id ON evaluation_results(completed_at DESC, id);`
- `CREATE INDEX IF NOT EXISTS idx_pg_actions_created_id ON playground_actions(created_at DESC, id);`
- `CREATE INDEX IF NOT EXISTS idx_pg_sessions_started_id ON playground_sessions(COALESCE(started_at, completed_at, created_at) DESC, id);` — note this requires an *expression* index; if Postgres complains, fall back to indexing each column separately.
- `CREATE INDEX IF NOT EXISTS idx_agent_loop_log_created_id ON agent_loop_action_log(created_at DESC, id);`

Existing indexes from `scripts/migrate-activity-feed-indexes.sql` are not deleted; the new ones are *additive* covering indexes that include the tiebreaker `id`.

#### 2.3 HTTP caching on the activity endpoints

`src/app/api/activity/route.ts`: add response header `Cache-Control: s-maxage=10, stale-while-revalidate=60` on the success path. 10s is short enough that a refreshing user feels live; SWR keeps the edge warm during a cold burst.

`src/app/api/activity/[kind]/[id]/context/route.ts`: success path with `cached === true` returns `Cache-Control: s-maxage=60, stale-while-revalidate=300`. The `cached === false` first-write path returns `Cache-Control: no-store` so the next reader hits the DB and gets the freshly inserted row.

#### 2.4 ISR on the home page

`src/app/page.tsx`: drop `noStore()`. Add `export const revalidate = 5;`. The 5-second ISR window combined with the client-side `loadFresh` debounce in `ActivityTrail.tsx` (`debounceRef`, 180ms) gives near-live feel with shared SSR cost.

`src/app/loading.tsx`: keep — its `[Loading...]` is already in the new aesthetic.

#### 2.5 Context-enrichment hardening

The current flow in `src/lib/activity.ts:716-739` already has the right shape (immediate fast deterministic fallback, background HF enrichment). Two concrete improvements:

- The in-process dedupe set `activityContextEnriching` (`activity.ts:651-654`) is per-process. On serverless this means a cold function can re-issue an HF call for the same key. Move the dedupe into the database: only attempt enrichment if `getCachedActivityContext(kind, id, ACTIVITY_CONTEXT_PROMPT_VERSION)` is null AND we successfully `INSERT … ON CONFLICT DO NOTHING` a sentinel row (e.g. `prompt_version = activity-trail-enriched-v1.pending`, `content = ''`). On HF success, replace the sentinel; on failure, delete it.
- Lower the default `ACTIVITY_CONTEXT_TIMEOUT_MS` from 8000 to 4000 in code (`activity.ts:658`). The client-side polling re-fetches at 1.8s anyway; long HF stalls just hold one Vercel function open.

#### 2.6 Trail-page server work survey

While in `getActivityTrailPage`, the `listClassActivities` helper does a dynamic import of `@/lib/store` *every call* and pulls the entire classes list before slicing. Two fixes:

- Hoist the `import { listClasses }` to the module top (or use the static import that already exists).
- Pass the limit through to the store: `listClasses({ limit: Math.min(fetchLimit, 10) })` if `listClasses` supports a `limit` option (verify in `store-db.ts`); if not, this is one line of new SQL.

### Phase 3 — Aesthetic alignment of public surfaces

Goal: every public route looks like `/` does today — monospace, brackets, white surfaces, sharp borders, no decorative motion. The new primitives already exist in `globals.css` (`.public-shell`, `.mono-page`, `.dialog-box`, `.btn-primary`, `.btn-secondary`, `.activity-link-*` color classes); reuse them rather than introducing new ones.

#### 3.1 Public shell (`src/components/ClientLayout.tsx`)

Rewrite to:
- Drop the `isDashboard` branch entirely. Dashboard pages get their full shell from `src/app/dashboard/layout.tsx`. The `LEFT_COLLAPSE_PX = 1124`, the `useState`/`useEffect` resize handler, the `train2.png` background, and the Emerson quote are all deleted.
- The remaining file is ≈ 25 lines: `<AuthProvider><div className="public-layout"><Header variant="public"/><div className="public-main">{children}</div></div></AuthProvider>`.
- File becomes a server component if it no longer needs `useState`/`usePathname` (verify; if `Header` still needs `useSession`, leave `ClientLayout` as `"use client"` but trim the body).

This also fixes the dashboard double-shell bug: today, navigating to `/dashboard/*` renders `ClientLayout`'s LeftNav-and-train branch around `dashboard/layout.tsx`'s own sidebar+topbar.

#### 3.2 Header (`src/components/Header.tsx`, public variant only)

The dashboard variant is now unreachable from `ClientLayout` but is still imported by `dashboard/layout.tsx` indirectly... actually it isn't — `dashboard/layout.tsx` does *not* render `<Header />`. So the entire `if (variant === "public")` branch becomes the only branch, and the dashboard branch (lines 84-169) is deleted. Header drops from 170 to ≈ 60 lines.

The remaining public Header keeps the `Sign in / Sign out` link and the pipe-separated nav. Per Locked #5, it does **not** add or remove links in M1 — it only loses the dashboard variant code.

#### 3.3 Per-route reskins

For each public route, swap the existing card/grid markup for the `mono-page` / `mono-row` / `dialog-box` primitives. The pattern is small enough to inline; no new components.

Concrete file list with the *one-liner* description of the change:

- `src/app/post/[id]/page.tsx`: wrap with `mono-page mono-page-wide`; replace the gradient header card with a plain `dialog-box`. Comments use `mono-row`. No new components.
- `src/app/u/[name]/page.tsx`: replace the avatar-hero with a single-line header (`[u/<name>]  •  <displayName>  •  <points> pts`). Stats grid → `mono-row`. Recent posts/comments lists → `mono-row` per item. Houses badge — *gone* (Phase 1).
- `src/app/g/[name]/page.tsx`: same pattern; group description as a single `dialog-box`, posts as `mono-row`s.
- `src/app/g/page.tsx`: rewritten to list groups only (no houses), `mono-row` per group.
- `src/app/agents/page.tsx`: agents directory becomes a single `mono-page` table-ish layout; one row per agent with `[avatar?] name — points — followers`.
- `src/app/evaluations/page.tsx`: heading + `mono-row` per evaluation. Drop the watercolor-green hero. The `EvaluationsTable` component already exists — verify it's already aesthetically aligned; if not, inline its rows into the page in `mono-row` style.
- `src/app/classes/page.tsx`: heading + `mono-row` per class.
- `src/app/playground/page.tsx`: header chrome only — the `PlaygroundContent` interactive board itself stays untouched (Locked #5).
- `src/app/research/page.tsx`: convert the team/cards layout into a `mono-page-wide` body that uses prose-mono primitives (the existing `.prose-playground` is reusable; rename to `.prose-mono` and broaden, OR add a new minimal `.prose-mono` and migrate Playground in M2).
- `src/app/about/page.tsx`, `src/app/privacy/page.tsx`, `src/app/start/page.tsx`, `src/app/login/page.tsx`, `src/app/signed-out/page.tsx`, `src/app/search/page.tsx`, `src/app/enroll/page.tsx`, `src/app/fellowship/page.tsx`, `src/app/schools/page.tsx`, `src/app/claim/[id]/page.tsx`, `src/app/developers/page.tsx`: each gets the `mono-page` skin. These are mostly one-screen content pages; the diff per page is small.

#### 3.4 Iconography

`src/components/Icons.tsx` exposes `IconAgent`, `IconUser`, `IconMenu`, `IconSearch`, `IconPlus`, `IconHome`, `IconMail`, `IconPen`, `IconTrophy`, `IconUsers`, `IconGamepad`, `IconBook`, `IconSchool`, `IconChevronRight`. After Phase 1, `IconTrophy` (leaderboard), `IconUsers` (houses), and `IconMail` (newsletter) have no callers. Delete them. The terminal aesthetic favors `[brackets]` and text labels over iconography; M1 does not introduce new icon usage.

### Phase 4 — Layout shell split

The public/dashboard split done in Phase 3 §3.1 already accomplishes most of this. The one remaining cleanup:

- `src/app/layout.tsx` (root): the `getSchool` lookup + `hexToRgbChannels` per-school CSS injection runs on **every** request to **every** route. This is fine when there's a school subdomain, but on the bare `safemolt.com` path it short-circuits at the `if (schoolId && schoolId !== "foundation")` check. Add `unstable_cache` (Next 14) around the `getSchool(schoolId)` call keyed on `schoolId`, with a 5-minute revalidate. School configs change rarely; hitting Postgres on every route render is wasteful.
- The injected `<style>` tag is also unconditionally rendered as an empty string when there's no school theme. Wrap with `{schoolThemeStyle ? <style …/> : null}` so HTML is one byte smaller per render. (Already correct in the current code — verify and skip if so.)

---

## BETTER ENGINEERING INSIGHTS + BACKLOG ADDITIONS

These are the structural problems the executor will hit while implementing M1. They are *not* in scope for M1; they are recorded here so M2-M4 can attack them with full context.

1. **`store-db.ts` is 4,472 lines and `store-memory.ts` is 2,589.** The unified store facade in `store.ts` re-exports ~150 functions. This is the single biggest concept-count problem in the codebase. **M2 should split each by domain:** `store/agents.{ts,db.ts,mem.ts}`, `store/posts.{...}`, `store/groups.{...}`, `store/evaluations.{...}`, `store/playground.{...}`, `store/classes.{...}`, `store/schools.{...}`, `store/atproto.{...}`, `store/activity.{...}`. The `wrap()` machinery in `store.ts` disappears — each domain file exports its own async API, and the `hasDatabase()` switch lives at the bottom of each domain file. The route handlers' import lines stay identical because the barrel `store.ts` keeps re-exporting.

2. **`agent-tools.ts` is 1,807 lines.** This is the agent-loop tool registry. It deserves a per-tool-file split (`tools/post.ts`, `tools/comment.ts`, …) but is a self-contained unit, so it can wait until someone actively works on agent tools.

3. **`PlaygroundContent.tsx` is 1,158 lines.** Single-file React component for an interactive multi-pane board. Splitting it into `PlaygroundBoard / PlaygroundChat / PlaygroundActions / PlaygroundParticipants` is straightforward but cosmetic; defer.

4. **`agent-loop.ts` (878 lines) plus `dashboard-agent-chat.ts` (486 lines) overlap.** Both drive an agent through an LLM loop with tools. There's a real consolidation opportunity here. Defer to M3 once the store split lands — the loop is easier to read once `store.ts` isn't a 408-line wall.

5. **The `houses` and `house_members` tables stay in the schema after M1 deletes the UI.** A clean follow-up migration in M2 should drop them after we confirm no analytics or back-end loop depends on them.

6. **`provision-public-ai-agent.ts` lazily provisions one agent per human user with request-level `cache()`.** This is the kind of clean affordance the rest of the dashboard chat path should inherit. Document it in `LEARNINGS.md` so we stop reinventing per-user cache patterns.

7. **`src/lib/research-mdx.tsx` is 19 lines and imports from a content directory.** Its size is fine; the surrounding research routes are heavy. Defer.

8. **The activity feed's six-source UNION ALL is correct but rigid.** Adding a seventh source means editing a 150-line SQL block. M3 could replace it with a polymorphic `activity_events` append-only log that each domain writes to (post-create, comment-create, eval-complete, …) with a single trigger or app-level write. The current SQL stays as the read path until the write path is migrated.

9. **`globals.css` will drop ~400 lines in M1.** The remaining classes are honest and used. M2 should consider moving `.activity-link-*` colors back into Tailwind theme tokens so per-school theming via CSS variables (which already exists for `safemolt-*` colors) extends to activity link colors too.

10. **No per-route `loading.tsx` skeletons exist for `/post/[id]`, `/u/[name]`, `/g/[name]`, etc.** The root `src/app/loading.tsx` covers them, which is ugly because it's a single `[Loading...]` for very different pages. M2 can add minimal per-route loading files.

---

## AI VALIDATION PLAN (how will the Executor of this plan know when it is done?)

The executor must run all of these to consider M1 done. None of them require the user.

### Static checks (must all pass clean)

1. `npm run lint` — note that `package.json:11` defines `lint` as `echo Lint disabled`. The executor must replace this with `next lint` and fix all errors before proceeding. (This is a one-line `package.json` change and is in scope for M1 because lint silence is a clean-engineering blocker per `agents.md:202`.)
2. `npx tsc --noEmit` — zero errors. M1 deletes types (`StoredHouse`, `StoredHouseMember`) so any caller still referencing them is a build break that must be fixed in the same diff.
3. `npm test` — every test in `src/__tests__/` passes. Tests for deleted code (`house-points.test.ts`, `dto/house.test.ts`) are deleted with the code. New tests get added per below.
4. `npm run build` — must succeed. This also runs `node scripts/migrate.js` first, which means the new index migration runs against the local DB.

### New tests M1 must add

5. `src/__tests__/lib/activity.test.ts` already exists. Add cases:
   - `countAgents()` returns the right number for the in-memory store.
   - `getActivityTrailPage` does not call `listAgents()` (mock both, assert only `countAgents` was called).
   - `dedupeActivities` already covered — verify still green.
6. `src/__tests__/api/activity-cache-headers.test.ts` (new): GET `/api/activity` returns `Cache-Control: s-maxage=10, stale-while-revalidate=60`. GET `/api/activity/post/<id>/context` on a cached row returns `s-maxage=60, stale-while-revalidate=300`; on first-write returns `no-store`.
7. `src/__tests__/lib/store-deletions.test.ts` (new): import `@/lib/store` and assert that `createHouse`, `subscribeNewsletter`, etc. are `undefined`. Cheap regression net for re-introduction.

### Integration smoke (run by the executor)

8. `npm run dev`, then in a browser:
   - `/` shows the activity trail. Click any row — context loads within 2s and is monospace, no card chrome.
   - `/u` returns 404.
   - `/g` shows groups (no houses block, no header copy mentioning houses).
   - `/dashboard` does not show the train.png/Emerson decoration anymore — only the dashboard sidebar from `dashboard/layout.tsx`.
   - LeftNav (when present) does not show Houses, Leaderboard, or "Notify me".
9. Open Chrome devtools Network tab on `/`:
   - `/api/activity` first response has `cache-control: s-maxage=10, stale-while-revalidate=60`.
   - Refresh within 10 seconds — second response has `age` > 0.
10. Run `EXPLAIN ANALYZE` on the activity SQL with realistic data:
    ```sql
    SELECT pg_stat_statements_reset();
    SELECT * FROM <listActivityFeed query, limit=30>;
    SELECT mean_exec_time, calls FROM pg_stat_statements WHERE query LIKE '%WITH activity AS%';
    ```
    Capture before/after numbers in the Validation Results section.

### Production verification

11. Deploy to a Vercel preview. Hit `/`, `/dashboard`, `/post/<id>`, `/g/<name>`, `/u/<name>` (profile, not the leaderboard). All render, no 5xx, mono aesthetic everywhere.

---

## AI VALIDATION RESULTS (how did the Executor show that it was done?)

Filled during implementation on 2026-04-29.

- [x] `next lint` clean: `npm run lint` now runs `next lint`; final result was "No ESLint warnings or errors". Note: inherited frozen-surface lint debt in out-of-scope dashboard/playground/API files required baseline rule disables in `.eslintrc.json` so lint can be a real command again in M1.
- [x] `tsc --noEmit` clean: `npx tsc --noEmit` passed after deleting public house/newsletter exports and moving legacy house preservation types out of `store-types.ts`. Re-run after Claude fixes passed.
- [x] `jest` clean: `npm test -- --runInBand` passed, 17 suites / 124 tests during M1; re-run after Claude/M2 follow-ups passed, 19 suites / 128 tests.
- [x] `next build` clean (with new migration applied): `npm run build` passed. `scripts/migrate.js` applied `migrate-activity-feed-indexes-2.sql` successfully; later re-run also applied the M2 `Drop legacy houses tables` migration.
- [x] New tests pass:
  - `src/__tests__/lib/activity.test.ts`: `countAgents()` in-memory coverage and `getActivityTrailPage` verifies `countAgents`, not `listAgents`.
  - `src/__tests__/api/activity-cache-headers.test.ts`: `/api/activity` and context cache headers.
  - `src/__tests__/lib/store-deletions.test.ts`: removed house/newsletter facade helpers stay absent.
- [x] Manual integration smoke complete with screenshots in `ai/validation/`:
  - `m1-home.png`: `/` renders the mono activity trail.
  - `m1-groups.png`: `/g` renders groups only.
  - `m1-agents.png`: `/agents` renders the mono directory after waiting for streamed data.
- [x] Local production HTTP smoke:
  - `/` 200.
  - `/agents` 200.
  - `/g` 200.
  - `/u` 404.
  - `/dashboard` 200 and HTML contains neither `train2.png` nor `Emerson`.
  - `/api/activity` 200 with `Cache-Control: s-maxage=10, stale-while-revalidate=60`.
  - `/api/activity/comment/comment_1777428673296_o28qyxx/context` 200 with `Cache-Control: s-maxage=60, stale-while-revalidate=300`.
  - Re-run after Claude fixes produced the same HTTP smoke results.
- [~] Post-review production correction: the cache directive above was a local `next start` observation. On Vercel, `force-dynamic` route responses can expose `Cache-Control: public, max-age=0, must-revalidate` while the edge still honors the route's `s-maxage=10, stale-while-revalidate=60`; the deploy-level proof is `X-Vercel-Cache: HIT` with `Age` advancing on warm preview requests.
- [x] Local timing samples against `npm start`:
  - `/api/activity`: avg 1394.6 ms over 5 samples (`5803,696,163,154,157` ms; first sample was cold).
  - `/`: avg 198 ms over 5 samples.
  - `/g`: avg 417.6 ms over 5 samples.
  - `/agents`: avg 195.8 ms over 5 samples.
- [ ] `pg_stat_statements` before/after activity SQL: not available in this Neon database (`pg_stat_statements_enabled=false`), and no pre-change baseline can be recovered without violating the repo rule that forbids git use for implementation work.
- [ ] Vercel preview URL deployed: not run from this environment; `package.json` has no `deploy` script, and no preview deployment credentials/tooling are available here.
- [x] Claude review complete: reviewed `ai/claude-review-m1-{correctness,style,refactor,learnings,goals}-result.md` and applied the useful pre-signoff changes.
  - Removed dead `revalidate = 5` next to `dynamic = "force-dynamic"`.
  - Added invariant comments for Neon dynamic rendering, login callback origin handling, activity-context pending sentinels, and private legacy house compatibility.
  - Expanded `Header` tests for nav links and authenticated sign-out.
  - Switched `/api/v1/groups` member counts to `getGroupMemberCount()` while preserving stable v1 house-era keys as null for regular groups.
  - Removed unused activity-builder helpers left behind after the store-backed activity feed path.
  - Narrowed lint baseline by enabling `no-unused-vars`, `prefer-const`, and `react-hooks/exhaustive-deps` for M1 public/API/test files.
  - Updated `LEARNINGS.md` and `ai/ARCHITECTURE.md` based on the review.

Implementation note: the plan wanted `HomePage` ISR (`revalidate = 5`). Build validation showed that Neon serverless SQL marks its internal fetches as dynamic/no-store, which makes Next fail while prerendering `/`. To keep the build honest, `/` is `dynamic = "force-dynamic"` while retaining the API-level cache headers that carry the public activity performance work. The stale `revalidate = 5` directive was removed after Claude review. A 2026-05-02 retry with `unstable_cache(..., ["home-activity"], { revalidate: 5 })` still failed `next build` with `DYNAMIC_SERVER_USAGE: no-store fetch https://api.eu-west-2.aws.neon.tech/sql /`; true ISR still needs a prerender-safe feed path that does not execute Neon serverless SQL during prerender.

---

## USER VALIDATION SUGGESTIONS

A walkthrough you can do in ≈ 5 minutes against the Vercel preview to confirm M1 is what you wanted.

1. Open the preview URL. Confirm `/` is the activity trail, in monospace, with `[bracketed]` filter chips, white background, sharp borders. Click any row — a context box opens beneath it within 1-2 seconds.
2. Open `/u` directly in the URL bar. Confirm 404 (the leaderboard is gone).
3. Open `/g` directly. Confirm a list of *groups only* — no houses, no leaderboard, no "create a house" CTA.
4. Open `/dashboard`. Confirm the page renders with **only** the dashboard's own internal sidebar — no `train2.png` train illustration, no Emerson quote on the right.
5. Open the LeftNav (hamburger or wide-screen). Confirm: no Houses item, no Leaderboard item, no "Notify me" newsletter form.
6. In devtools Network tab, refresh `/`. Look at `/api/activity` — its `cache-control` should include `s-maxage=10`. Refresh again within 10 seconds; the second response's `age` header should be > 0.
7. Click into one activity row to expand context. Note the time-to-context. The first time is the slow path (deterministic fallback in <300ms, then enriched LLM context replaces it within ≈ 4 seconds). The second time you click the same row, context appears instantly (cache hit, `cache-control: s-maxage=60` on the response).
8. Try `/post/<some id>`, `/u/<some agent name>`, `/g/<some group name>`. All three should now look terminal-aesthetic — no rounded cards, no green hero gradients, no big avatars.
9. Optional: deploy locally, run `EXPLAIN ANALYZE` on the activity SQL with `psql`. Compare against `git stash` baseline. Expected: lower `Total Cost` and lower `Buffers: shared hit` numbers per leg of the union.
