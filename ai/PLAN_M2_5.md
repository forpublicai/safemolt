# M2.5 plan: Hot-path performance cleanup, cache discipline, and text-first render diet

## Summary

M2.5 is a speed-supreme performance milestone between the completed M2 store split and the planned M3 agent-runtime work. Its job is to make SafeMolt feel fast immediately, even if that means pulling work forward from later milestones and rewriting those plans afterward.

SafeMolt is deliberately text-first and terminal-inspired, so the UI should behave like a fast document, not a heavy app shell. M2.5 therefore optimizes the real hot paths:

1. Remove unnecessary human-auth work from public middleware.
2. Stop duplicate homepage activity-feed requests.
3. Throttle the agent API `lastActiveAt` write path.
4. Parallelize dashboard layout reads.
5. Pull the M4 `activity_events` table forward so the activity feed reads one indexed table instead of a six-table UNION.
6. Add route-level timing so future speed work is measured, not guessed.
7. Audit public page cache policy route by route, using short data caches where ISR is blocked by Neon.
8. Reduce public hydration where it is easy and safe, especially on the activity trail.
9. Add bundle/trace checks so optional heavy systems stay off hot public routes.

Out of scope, on purpose:

- No agent runtime/tool registry refactor. M3 owns that.
- No interior/dashboard visual redesign. M5 owns that.
- No new dependencies.
- No broad `force-dynamic` deletion. M1 already proved Neon serverless SQL can force no-store behavior during prerender; M2.5 must keep build validation honest.

The expected result is a visibly faster public site, much lower database pressure, fewer duplicate requests, fewer write-amplified auth calls, and measurement hooks that make M3-M5 safer. After M2.5 lands, M4 should be rewritten as a burn-in/realtime/search follow-up rather than the first `activity_events` implementation.

## HOW TO EXECUTE A MILESTONE

[Please include what follows verbatim when you write a PLAN_M{n}.md file. It will be used to guide anyone who executes on your plan.]

If the user asks you to execute on a plan, these are the steps to take.

1. Implement the plan
   - You should check your work with AI autonomous validation and testing.
   - The hope is that implementation can be done with a minimum of user interaction, preferably none at all.
   - Once it is complete, fill in the "Validation" section to the bottom of the plan showing how you have validated it and what were the results.
   - You might have discovered better engineering
2. Perform your testing and validation
   - Update the "AI VALIDATION RESULTS" section of your PLAN_M{n}.md file
3. Review your own code. Also, ask Claude to review your work
   - You will need to provide it contect: your plan document PLAN_M{n}.md, and tell it which files or functions you've worked on. Ask it also to review your validation steps.
   - If Claude found no blockers or problems with your work, you may proceed. Do static checking (formatting, eslint, typechecking). If you need any fixes, static check again to make sure it's clean.
   - If you couldn't get Claude to run for whatever reason, the user wants you to abort and report what's wrong.
   - Keep iterating with Claude until you no longer make changes (either because you've taken on Claude's feedback from past rounds, or because your plan no successfully defends its positions so Claude accepts them). However, if you take more than 10 rounds, then somethig is wrong, so stop and let the user know.
   - We aren't looking for "blocker vs non-blocker" decisions. Instead for every suggestion from Claude you must evaluate "will this improve my code? if so then modify your code, and if not then pre-emptively defend (in code comments) why not". And if you made modifications or comments, then circle back with Claude again.
   - Do NOT reference previous rounds when you invoke it: Claude does best if starting from scratch each round, so it can re-examine the whole ask from fundamentals. Note that each time you invoke Claude it has no memory of previous invocations, which is good and will help this goal! Also, avoid asking it something like "please review the updated files" since (1) you should not reference previous rounds implicitly or explicitly, (2) it has no understanding of what the updates were; it only knows about the current state of files+repo on disk.
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

## Locked user decisions

1. **M2.5 optimizes for "absolute blazing fast + efficient" SafeMolt.** Prefer lower database load, less server work, less client hydration, fewer bytes, and explicit measurements over visual flourish.

2. **The terminal/text-first design is a performance constraint.** Public pages should render as mostly text, links, and simple forms. Do not add graphical loading states, animation, charting, image-heavy components, or extra client-side state to solve performance.

3. **M2.5 preserves M3's agent-runtime scope but may rewrite M4-M5.** It prepares M3 by keeping auth/tool paths clean. It pulls forward the M4 activity-feed table because that is a direct speed win. It may also change M5 cleanup tasks if public hydration work lands here first.

4. **Speed is allowed to reorder later milestones.** If the cleanest speed win overlaps M4 or M5, pull it into M2.5 and update the later milestone docs. The activity feed is the main example: `activity_events` moves into M2.5 because speed is supreme.

5. **Do not bulk-remove `force-dynamic`.** Route cache policy changes must be route-specific and validated by `npm run build`. If Neon still marks a route dynamic during prerender, keep the page dynamic and cache the data read instead.

6. **The activity feed read path becomes single-table now.** M2.5 introduces `activity_events`, backfills it, and switches `/api/activity` to read it by default. The old UNION may remain behind a rollback env var for one milestone only.

7. **All side-effecting performance helpers must expose the side effect in their names.** Example: `touchAgentLastActiveAtIfStale`, not `loadAgentActivity`.

8. **No fire-and-forget promise discards.** Existing `*FireAndForget()` wrappers must catch internally and return `void`. New async work is awaited unless the function name and implementation make error handling explicit.

9. **No new dependencies.** Measurement scripts use built-in Node APIs and existing Next/Vercel features.

10. **Performance is not complete without numbers.** The executor must record before/after timings for key routes and hot APIs in this plan's validation results.

### Executor questions deferred to user signoff

- **Q1.** Should M2.5 allow slightly stale public directory pages, e.g. `/agents` and `/g`, for 30-60 seconds? Recommendation: yes. SafeMolt is social and text-first, not a stock ticker; short shared cache windows buy a lot of speed.
- **Q2.** Should the activity trail auto-refresh when idle? Recommendation: no for M2.5. Load initial SSR data instantly, then fetch only on search/filter/load-older/explicit user action. M4 can add push or smarter polling if product needs it.
- **Q3.** Should authenticated dashboard pages keep zero shared cache? Recommendation: yes. Optimize dashboard by removing duplicate auth and parallelizing reads, not by caching private data.

## PLAN

### Phase 1 - Baseline and timing instrumentation

Goal: make every later claim measurable.

#### 1.1 Add a tiny timing utility

Create `src/lib/perf.ts`:

```ts
export interface PerfMeasure {
  name: string;
  ms: number;
}

export async function measureAsync<T>(
  name: string,
  fn: () => Promise<T>
): Promise<{ value: T; measure: PerfMeasure }> {
  const start = performance.now();
  const value = await fn();
  return { value, measure: { name, ms: performance.now() - start } };
}

export function serverTimingHeader(measures: PerfMeasure[]): string {
  return measures
    .map((m) => `${m.name};dur=${Math.max(0, Math.round(m.ms * 10) / 10)}`)
    .join(", ");
}
```

Keep this file small. It is a measurement primitive only, not a logging framework.

#### 1.2 Add Server-Timing to hot public APIs

Instrument only:

- `src/app/api/activity/route.ts`
- `src/app/api/activity/[kind]/[id]/context/route.ts`

For `/api/activity`, measure:

- `activity_total`
- `activity_feed_page` around `getActivityTrailPage`

For context, measure:

- `context_total`
- `context_get_or_generate` around `generateOrGetActivityContext`

Return headers like:

```text
Server-Timing: activity_feed_page;dur=42.3, activity_total;dur=44.1
```

Do not add timing to every API route in this milestone. The goal is signal, not noise.

#### 1.3 Add a no-dependency route timing script

Create `scripts/perf-smoke.js`. It accepts a base URL and route list:

```bash
node scripts/perf-smoke.js http://localhost:3000 / /api/activity /agents /g /classes /evaluations
```

It should:

- Warm each route once.
- Run each route 5 times.
- Print status, average duration, min, max, response bytes, `cache-control`, and `server-timing`.
- Use built-in `http`, `https`, and `perf_hooks`; no dependency.

Add `package.json` script:

```json
"perf:smoke": "node scripts/perf-smoke.js"
```

### Phase 2 - Pull M4 activity_events forward

Goal: make the activity feed read path fundamentally fast now. This is the largest M2.5 change and the reason later M4 must be rewritten.

Today the feed re-derives activity by UNIONing posts, comments, evaluations, playground sessions, playground actions, and agent loop actions on every read. M2.5 changes the architecture to write a denormalized event once, then read one indexed table.

#### 2.1 Migration and schema

Add `scripts/migrations/2026-XX-add-activity-events.sql` using the next available migration prefix:

```sql
CREATE TABLE IF NOT EXISTS activity_events (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  kind                  TEXT NOT NULL,
  occurred_at           TIMESTAMPTZ NOT NULL,
  actor_id              TEXT,
  actor_name            TEXT,
  actor_canonical_name  TEXT,
  entity_id             TEXT NOT NULL,
  title                 TEXT NOT NULL,
  href                  TEXT,
  summary               TEXT NOT NULL,
  context_hint          TEXT NOT NULL DEFAULT '',
  search_text           TEXT NOT NULL DEFAULT '',
  metadata              JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (kind, entity_id)
);

CREATE INDEX IF NOT EXISTS idx_activity_events_occurred
  ON activity_events(occurred_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_activity_events_kind_occurred
  ON activity_events(kind, occurred_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_activity_events_actor
  ON activity_events(actor_id, occurred_at DESC);
CREATE INDEX IF NOT EXISTS idx_activity_events_entity
  ON activity_events(kind, entity_id);
CREATE INDEX IF NOT EXISTS idx_activity_events_search
  ON activity_events USING GIN (to_tsvector('simple', search_text));
```

Mirror the table and indexes in `scripts/schema.sql`.

#### 2.2 Activity writer

Create `src/lib/store/activity/events.ts` with:

- `ActivityEventInput`
- `recordActivityEventBestEffort(input): Promise<void>`
- `recordActivityEvent(input): Promise<void>`
- `listActivityEvents(options): Promise<StoredActivityFeedItem[]>`

Naming invariant:

- `recordActivityEventBestEffort` catches, logs, and returns `void`.
- `recordActivityEvent` throws.
- Call sites that must never block entity creation use the `BestEffort` name so the contract is visible.

The DB writer uses `INSERT ... ON CONFLICT (kind, entity_id) DO UPDATE` and replaces denormalized fields. The in-memory writer stores the same events in `src/lib/store/_memory-state.ts` and enforces the same `(kind, entityId)` uniqueness by replacement.

#### 2.3 Write events beside entity writes

Add `recordActivityEventBestEffort` calls to:

- `src/lib/store/posts/db.ts:createPost`
- `src/lib/store/posts/memory.ts:createPost`
- `src/lib/store/comments/db.ts:createComment`
- `src/lib/store/comments/memory.ts:createComment`
- `src/lib/store/evaluations/db.ts:saveEvaluationResult`
- `src/lib/store/evaluations/memory.ts:saveEvaluationResult`
- `src/lib/store/playground/db.ts:createPlaygroundSession`
- `src/lib/store/playground/memory.ts:createPlaygroundSession`
- the playground status-transition writer that sets `startedAt`
- `src/lib/store/playground/db.ts:createPlaygroundAction`
- `src/lib/store/playground/memory.ts:createPlaygroundAction`
- the agent-loop action log writer after the current log row is created

Each writer computes the same fields the current UNION computes: kind, occurred time, actor display, entity id, title, href, summary, context hint, search text, and metadata.

If a writer cannot look up display data without adding several extra queries, prefer a cheap event write with IDs and let backfill enrich it. Speed is the priority; fresh rows can be slightly plain as long as links and kinds are correct.

#### 2.4 Single-table activity read

In `src/lib/store/activity/db.ts`, split the existing UNION into:

- `listActivityFeedFromUnion(options)` - legacy rollback path.
- `listActivityFeedFromEvents(options)` - new default path.
- `listActivityFeed(options)` - chooses source.

Use:

```ts
const source = process.env.ACTIVITY_FEED_SOURCE ?? "events";
return source === "union"
  ? listActivityFeedFromUnion(options)
  : listActivityFeedFromEvents(options);
```

The events query reads only `activity_events`, filters by `occurred_at`, `kind`, and `to_tsvector('simple', search_text)`, orders by `occurred_at DESC, id DESC`, and limits. No joins. No UNION. No per-request denormalization.

The memory path reads the same in-memory event map and applies equivalent filtering.

#### 2.5 Backfill

Add an admin/internal route:

```text
POST /api/v1/internal/activity-events-backfill
```

It must:

- Be protected with the same internal/admin gate pattern as other internal routes.
- Insert events from the six current sources using `INSERT INTO activity_events (...) SELECT ...`.
- Use `ON CONFLICT (kind, entity_id) DO UPDATE` so it is idempotent.
- Return counts by kind.

Do not iterate row-by-row in TypeScript for the historical backfill. Use SQL set operations so production backfill is fast.

#### 2.6 Cutover protocol

Implementation and validation order:

1. Add table and writer.
2. Keep `ACTIVITY_FEED_SOURCE=union`.
3. Deploy or run locally with writers active.
4. Run backfill.
5. Compare `/api/activity?limit=80` from `union` and `events`.
6. Switch default to `events`.
7. Keep `ACTIVITY_FEED_SOURCE=union` available for one milestone as rollback.

M4 must later delete the rollback path after burn-in.

#### 2.7 Tests

Add:

- `src/__tests__/lib/store/activity/events.test.ts`
- `src/__tests__/lib/store/activity/events-feed.test.ts`
- `src/__tests__/api/activity-events-backfill.test.ts`

Required assertions:

- Duplicate `(kind, entityId)` updates, not duplicates.
- Feed returns newest first.
- Type filter works.
- Search uses `searchText`.
- `before` keyset pagination works.
- Backfill is idempotent.
- `ACTIVITY_FEED_SOURCE=union` and `events` return equivalent shapes for seeded fixtures.

### Phase 3 - Remove global public auth middleware work

Goal: public pages should not run NextAuth session resolution just to browse text.

#### 3.1 Rewrite `src/middleware.ts`

Replace the `export default auth((req) => ...)` wrapper with plain middleware:

```ts
import { NextResponse, type NextRequest } from "next/server";
import { extractSchoolFromHost } from "@/lib/school-context";

export function middleware(req: NextRequest) {
  const requestHeaders = new Headers(req.headers);
  requestHeaders.set("x-school-id", extractSchoolFromHost(req.headers.get("host") || "localhost"));
  requestHeaders.set("x-current-path", `${req.nextUrl.pathname}${req.nextUrl.search}`);

  return NextResponse.next({ request: { headers: requestHeaders } });
}
```

The middleware keeps school subdomain injection and adds `x-current-path` so dashboard layout can preserve callback destinations.

#### 3.2 Move dashboard redirect into `dashboard/layout.tsx`

`src/app/dashboard/layout.tsx` already calls `auth()`. Make it the dashboard page gate:

- If `!session?.user?.id`, redirect to `/login?callbackUrl=<current dashboard path>`.
- Read `x-current-path` from `headers()`.
- Use the same localhost-vs-safemolt callback invariant currently documented in middleware comments.

Dashboard API routes already call `auth()` directly and return 401, so they stay protected.

#### 3.3 Validation for auth split

Add or update tests:

- Public route middleware sets `x-school-id` without importing/calling `auth`.
- Unauthenticated `/dashboard` redirects to login.
- Unauthenticated `/api/dashboard/*` still returns 401 through route-level auth.
- Local callback URLs stay path-only; safemolt subdomains can use full URLs.

### Phase 4 - Stop duplicate activity work on homepage

Goal: `/` should do one initial activity read, not SSR plus an immediate client refetch.

#### 4.1 Update `ActivityTrail`

In `src/components/ActivityTrail.tsx`, change the search/filter effect:

- Do not call `loadFreshFireAndForget()` on initial mount when `query === ""` and `activeFilters.length === 0`.
- Continue fetching when the user changes query or filters.
- Keep load-older behavior.

Implementation shape:

```ts
const didMountRef = useRef(false);

useEffect(() => {
  if (!didMountRef.current) {
    didMountRef.current = true;
    if (!query && activeFilters.length === 0) return;
  }
  // existing debounce fetch
}, [query, activeFilters.join(",")]);
```

Prefer a tiny local ref over a new helper.

#### 4.2 Reconsider client fetch cache mode

For `fetchActivities`, remove `cache: "no-store"` unless validation proves it is required. `/api/activity` already returns `s-maxage=10, stale-while-revalidate=60`; client code should not reflexively opt out of useful HTTP caching.

For activity context fetches, keep `cache: "no-store"` only if the first fast fallback must be followed by enriched content immediately. If removed, verify the enriched second fetch still updates within the expected 1.8-4 second window.

#### 4.3 Add a regression test

Add a component test that renders `ActivityTrail` with initial activities and asserts no `/api/activity` request is made until:

- the query changes,
- a filter is clicked,
- or the user scrolls upward to load older rows.

### Phase 5 - Throttle agent auth writes

Goal: authenticated agent API calls should not write to Postgres on every request.

#### 5.1 Add explicit side-effecting store functions

Add to `src/lib/store/agents/db.ts`:

```ts
export async function touchAgentLastActiveAtIfStale(
  agentId: string,
  staleAfterMs = 5 * 60 * 1000
): Promise<void> {
  await sql!`
    UPDATE agents
    SET last_active_at = NOW()
    WHERE id = ${agentId}
      AND (
        last_active_at IS NULL
        OR last_active_at < NOW() - (${Math.ceil(staleAfterMs / 1000)} || ' seconds')::interval
      )
  `;
}
```

Add the memory equivalent in `src/lib/store/agents/memory.ts`.

Export it through `src/lib/store/agents/index.ts` and `src/lib/store.ts`.

Do not route this through `updateAgent`; `updateAgent` re-fetches and is too general for a hot auth path.

#### 5.2 Use it from `getAgentFromRequest`

In `src/lib/auth.ts`, replace:

```ts
const { updateAgent } = await import("./store");
await updateAgent(agent.id, { lastActiveAt: new Date().toISOString() });
```

with:

```ts
const { touchAgentLastActiveAtIfStale } = await import("./store");
await touchAgentLastActiveAtIfStale(agent.id);
```

The returned agent may have an older `lastActiveAt`; that is fine. Authentication returns identity, not presence freshness.

#### 5.3 Tests

Add tests for:

- First authenticated request touches an agent with null `lastActiveAt`.
- Second request inside 5 minutes does not update.
- Request after 5 minutes updates.
- `getAgentFromRequest` still returns the agent.

### Phase 6 - Dashboard layout read cleanup

Goal: dashboard shell should not serialize independent reads.

In `src/app/dashboard/layout.tsx`:

- Keep `auth()` first.
- If signed in, import `getProfessorByHumanUserId` at module top if doing so does not create a cycle; otherwise keep the dynamic import but run the actual reads in parallel.
- Fetch profile and professor record with `Promise.all`.

Target shape:

```ts
const [profile, professor] = await Promise.all([
  getDashboardProfileSettings(userId),
  getProfessorByHumanUserId(userId),
]);
```

Also remove any duplicate dashboard auth calls in child pages only when the layout now proves the invariant. Keep child-page role checks and ownership checks.

### Phase 7 - Public route cache audit

Goal: reduce DB reads on mostly-read public text pages without lying to Next's build system.

#### 7.1 Route categories

Audit these public pages:

- `/agents`
- `/g`
- `/g/[name]`
- `/u/[name]`
- `/post/[id]`
- `/classes`
- `/evaluations`
- `/evaluations/[sip]`
- `/schools`

For each route, decide:

- **Static or long-lived**: research/about/privacy style pages. Keep static.
- **Directory with short stale tolerance**: `/agents`, `/g`, `/classes`, `/evaluations`, `/schools`. Use cached data reads with 30-300 second revalidate.
- **Detail with interaction freshness**: `/post/[id]`, `/u/[name]`, `/g/[name]`. Use 10-30 second cached reads only if comments/profile activity freshness remains acceptable.
- **Dashboard/private/API mutation**: keep dynamic.

#### 7.2 Prefer cached data reads over risky ISR

If removing `noStore()` or `force-dynamic` makes `npm run build` fail because Neon forces no-store during prerender, restore the dynamic directive and wrap the data read in `unstable_cache`.

Example pattern local to a page:

```ts
const getCachedAgentsForDirectory = unstable_cache(
  async () => listAgents("recent"),
  ["agents-directory"],
  { revalidate: 60 }
);
```

Do not create a generic cache abstraction unless at least three routes share exactly the same caching shape.

#### 7.3 Cache headers for public APIs

Do not add cache headers to mutation routes.

For public read APIs that are safe to share, add:

```text
Cache-Control: s-maxage=10, stale-while-revalidate=60
```

Only add them where the response is public and does not depend on session, API key, or private user data.

### Phase 8 - Text-first hydration diet

Goal: public text pages should ship as little client JS as possible.

#### 8.1 Activity trail

Keep the M2.5 fix small unless measurements show hydration is a major cost:

- Required: stop initial refetch.
- Required: ensure the first paint is complete with SSR HTML.
- Optional if time remains: split activity context expansion into a smaller client child so the static activity line is server-rendered with minimal client state.

Do not redesign the activity trail UI while moving the feed to `activity_events`. M2.5 is allowed to reduce hydration and replace the data source, but not to turn the homepage into a new product surface.

#### 8.2 Public pages

For `/agents`, `/g`, `/classes`, `/evaluations`, `/schools`, and detail pages:

- Keep them server components unless they need input state.
- Do not add client components for hover, animation, decorative skeletons, or visual convenience.
- Replace any interactive flourish with native HTML where possible: links, forms, `details`, `summary`.

#### 8.3 CSS diet

Run a CSS scan after implementation:

```bash
Get-Content src/app/globals.css | Select-String -Pattern "animation|transition|box-shadow|gradient|blur|transform"
```

Any remaining public-surface animation or decorative effect must be justified by a functional need. M1 removed most of this; M2.5 verifies it stays gone.

### Phase 9 - Serverless bundle and trace audit

Goal: ensure hot public routes do not carry optional systems.

#### 9.1 Add route trace script

Create `scripts/analyze-route-trace.js` that reads `.next/server/app/**/[route].nft.json` after `npm run build` and reports whether hot routes include packages such as:

- `chromadb`
- `chromadb-default-embed`
- `@atproto/crypto`
- `@atproto/repo`
- `@modelcontextprotocol/sdk`
- `next-mdx-remote`
- `rss-parser`

Add script:

```json
"perf:trace": "node scripts/analyze-route-trace.js"
```

Hot routes to inspect:

- `/`
- `/agents`
- `/g`
- `/api/activity`
- `/api/activity/[kind]/[id]/context`

#### 9.2 Fix only proven hot-route leaks

If a heavy optional package appears in a hot route trace:

- Move the import behind a function-local dynamic `import()` in the specific feature module.
- Or split a barrel/export so the hot route no longer imports the feature module.
- Keep the store facade invariant unless the trace proves the facade is causing measurable bundle pollution. If the facade is the problem, document the invariant change in `ai/ARCHITECTURE.md` before editing imports.

### Phase 10 - Documentation updates

Update `ai/ARCHITECTURE.md`:

- Public middleware injects school/current-path only; dashboard auth lives in dashboard layout and dashboard API routes.
- Agent auth touches `lastActiveAt` through `touchAgentLastActiveAtIfStale`, throttled to 5 minutes.
- Public route caching policy: dynamic pages may still use cached data reads when ISR is blocked by Neon.

Update `LEARNINGS.md` only if a durable pattern emerges. Likely candidate:

- "Measure hot paths with `Server-Timing` before and after changing cache policy; otherwise performance work becomes folklore."

## BETTER ENGINEERING INSIGHTS + BACKLOG ADDITIONS

1. **M4 must be rewritten after M2.5.** The core `activity_events` implementation moves here. M4 should become a burn-in cleanup and realtime/search follow-up: delete the UNION rollback path, consider `pg_notify`/SSE, and tune search ranking once event reads have production data.

2. **`@/lib/store` as a universal facade may affect route traces after M2.** If hot route traces include unrelated domains, a future milestone should refine the store export strategy without breaking the app-level import invariant.

3. **`updateAgent` remains a general multi-field updater.** M2.5 avoids it in the auth hot path. A future agents-store cleanup can make `updateAgent` a single-query updater if profile editing becomes a measured bottleneck.

4. **Dashboard pages duplicate some auth checks.** M2.5 should remove only obvious duplicates after layout gating. A deeper dashboard auth consolidation belongs with M5's interior pass.

5. **Realtime activity should build on the M2.5 event table.** Do not add polling complexity in M2.5. If live feel becomes important, add `pg_notify` or SSE after `activity_events` has burned in.

## AI VALIDATION PLAN

### Static checks

1. `npm run lint` clean.
2. `npx tsc --noEmit` clean.
3. `npm test -- --runInBand` clean.
4. `npm run build` clean.

### New tests M2.5 must add

5. Middleware/header tests:
   - Public requests get `x-school-id`.
   - Dashboard path is not authenticated in middleware.
   - Dashboard layout redirects unauthenticated users.

6. ActivityTrail tests:
   - Initial render does not fetch `/api/activity`.
   - Search/filter interaction fetches `/api/activity`.
   - Load-older interaction still fetches older activity.

7. Agent auth touch tests:
   - `touchAgentLastActiveAtIfStale` updates stale/null timestamps.
   - It skips fresh timestamps.
   - `getAgentFromRequest` uses the touch function and still returns the agent.

8. Perf utility tests:
   - `serverTimingHeader([{ name: "x", ms: 12.34 }])` emits a valid `Server-Timing` fragment.

9. Activity events tests:
   - `recordActivityEvent` inserts events and updates duplicate `(kind, entityId)` events.
   - `listActivityFeed` returns newest-first events from `activity_events`.
   - Type filtering, search, and `before` pagination work on the events path.
   - Backfill is idempotent.
   - Union and events paths return equivalent feed shapes for seeded fixtures.

### Performance validation

10. Before making code changes, run:

```bash
npm run build
npm start
npm run perf:smoke -- http://localhost:3000 / /api/activity /agents /g /classes /evaluations
```

Record the output in this file.

11. After implementation, run the same command and record before/after:

- `/` average duration
- `/api/activity` average duration
- `/agents` average duration
- `/g` average duration
- response bytes for `/`
- `Server-Timing` for `/api/activity`

12. Network validation with Playwright:

- Load `/`.
- Assert the initial page load does not immediately request `/api/activity`.
- Type in activity search.
- Assert exactly one debounced `/api/activity` request.
- Click a filter.
- Assert one debounced `/api/activity` request.
- Expand an activity row.
- Assert context endpoint returns and the UI updates.

13. Dashboard validation:

- Unauthenticated `/dashboard` redirects to `/login`.
- Authenticated `/dashboard` renders.
- Unauthenticated dashboard API route still returns 401.

14. Cache policy validation:

- `/api/activity` keeps `Cache-Control: s-maxage=10, stale-while-revalidate=60`.
- Public read routes with added cache headers are public-only.
- No private dashboard response receives shared cache headers.

15. Bundle trace validation:

After `npm run build`, run:

```bash
npm run perf:trace
```

Hot route traces must not include optional packages unless the plan records why they are unavoidable.

### Production or preview validation

16. Deploy a preview if tooling is available. If no deploy tooling exists in the environment, record that fact instead of inventing a deploy path.

17. Run the same route timing smoke against the preview URL.

18. Verify Vercel/host logs show no spike in auth, activity, or middleware errors.

## AI VALIDATION RESULTS

Executor: Codex, 2026-04-30.

- [x] `npm run lint` clean.
- [x] `npx tsc --noEmit` clean.
- [x] `npm test -- --runInBand` clean: 28 suites / 146 tests passed.
- [x] `npm run build` clean. The build ran migrations successfully and reported middleware at 27.3 kB.
- [x] `activity_events` migration applies and is mirrored in `scripts/schema.sql`.
- [x] Activity event writers added for posts, comments, evaluations, playground sessions/actions, and agent-loop actions.
- [x] Backfill route is idempotent by `ON CONFLICT (kind, entity_id) DO UPDATE`; local built-server run returned counts: `post=379`, `comment=1712`, `evaluation_result=109`, `playground_session=17`, `playground_action=98`, `agent_loop=911`.
- [x] `/api/activity` reads `activity_events` by default with `ACTIVITY_FEED_SOURCE=union` rollback available.
- [x] Runtime comparison of `/api/activity?limit=80` on events vs rollback union returned `events=51`, `union=51`, and identical compact item shapes for `kind`, `id`, `occurredAt`, `href`, `title`, and `summary`.
- [x] Before/after `perf:smoke` recorded.
  - Baseline built-server sample before edits: `/` avg 713.8ms, `/api/activity` avg 114.7ms, `/agents` avg 149.3ms, `/g` avg 1159.6ms, `/classes` avg 261.6ms, `/evaluations` avg 48.9ms.
  - Post-change warmed built-server sample on `http://127.0.0.1:3010`: `/` avg 151.8ms, `/api/activity` avg 111.2ms, `/agents` avg 40.3ms, `/g` avg 50.2ms, `/classes` avg 55.7ms, `/evaluations` avg 55.9ms.
  - `/api/activity` still returns about 80 KB, so local request time is roughly flat while the server work is now a single indexed table read. `Server-Timing`: `activity_feed_page;dur=109, activity_total;dur=109`.
  - Context route sample: `/api/activity/comment/comment_1777428673296_o28qyxx/context` avg 108.1ms, `Cache-Control: s-maxage=60, stale-while-revalidate=300`, `Server-Timing: context_get_or_generate;dur=105.8, context_total;dur=105.8`.
- [x] `/` no longer double-fetches `/api/activity` on initial load; covered by `ActivityTrail` component regression test.
- [x] Agent API auth no longer writes `lastActiveAt` on every request; `touchAgentLastActiveAtIfStale` updates only stale/null timestamps.
- [x] Public middleware no longer calls NextAuth; it injects `x-school-id` and `x-current-path` only.
- [x] Dashboard auth still redirects unauthenticated users. Built-server `/dashboard` HTML contains `NEXT_REDIRECT;replace;/login?callbackUrl=%2Fdashboard;307`; unauthenticated `/api/dashboard/profile` returns 401.
- [~] Public API cache headers were validated locally: `/api/activity` returned `s-maxage=10, stale-while-revalidate=60`; unauthenticated `/api/v1/classes` and `/api/v1/evaluations` returned `s-maxage=30, stale-while-revalidate=120`. Post-review correction: on Vercel the public `Cache-Control` header can be normalized to `public, max-age=0, must-revalidate`; deploy validation must prove CDN behavior with `X-Vercel-Cache: HIT` and advancing `Age`. For the v1 routes, that deploy claim only holds when the unauthenticated response has zero `Set-Cookie` headers.
- [x] CSS diet scan complete. Remaining hits are `box-shadow: none`, Tailwind `transition-none`, and reduced-motion duration overrides; no decorative animation/blur/transform work was added.
- [x] Hot route trace audit complete. `npm run perf:trace` after build reported `heavy=none` for `/`, `/agents`, `/g`, `/api/activity`, and `/api/activity/[kind]/[id]/context`.
- [x] Preview timing smoke complete, or deploy tooling absence recorded: no `deploy` script exists in `package.json`, so no preview deploy was attempted.
- [~] Playwright network validation was not run in a browser. Component regression coverage for initial no-fetch/search/filter/load-older behavior exists, and built-server API/context/cache checks were run with Node/curl, but those are not the same assertion as the skipped Playwright network steps.
- [x] Claude review complete, or Claude/tooling blockage recorded: `claude.exe` exists, but `AGENTS.md` requires the human-mediated Claude handoff. Prompt prepared at `ai/CLAUDE_M2_5_REVIEW.md`.

### Claude review follow-up

Claude review results were read from `ai/CLAUDE_M2_5_REVIEW_RESULT.md` and the handoff blockers were resolved.

- Fresh DB activity-event writers now use awaited activity-event helpers that enrich rows with the same agent/group/session joins as the SQL backfill. Entity writes still survive event-write failures, but the event insert is no longer fire-and-forget across the response boundary.
- `/agents` cached directory reads now key by requested sort.
- Activity-event search now uses the `to_tsvector('simple', search_text) @@ plainto_tsquery('simple', q)` path without the non-indexable `LIKE` OR fallback.
- Activity-event pagination now carries `cursorId` and supports `(occurred_at, id)` compound cursor paging on the events table.
- `touchAgentLastActiveAtIfStale` now uses `make_interval`.
- Backfill auth now fails closed when `CRON_SECRET` is absent, and tests cover both the fail-closed path and idempotent `ON CONFLICT` SQL shape.
- Dashboard layout label/professor state was simplified to immutable `const` expressions.

Follow-up validation after Claude fixes:

- `npm run lint` clean.
- `npx tsc --noEmit` clean.
- `npm test -- --runInBand` clean: 29 suites / 150 tests passed.
- `npm run build` clean.
- `npm run perf:trace` still reports `heavy=none` for `/`, `/agents`, `/g`, `/api/activity`, and `/api/activity/[kind]/[id]/context`.
- Built-server backfill with `CRON_SECRET=test-secret` returned counts: `post=379`, `comment=1712`, `evaluation_result=109`, `playground_session=17`, `playground_action=98`, `agent_loop=911`.
- Built-server compound cursor smoke returned the next activity after the first row using `before` plus `before_id`.
- Warmed built-server smoke after Claude fixes: `/api/activity` avg 105.9ms, `/agents` avg 32.0ms, `/g` avg 52.8ms.

## USER VALIDATION SUGGESTIONS

1. Open `/` in DevTools Network. On initial load, there should be no immediate `/api/activity` request after the HTML arrives. Searching or clicking a filter should still fetch.

2. Open `/` and expand an activity row. Context should still load on click.

3. Check `/api/activity` in DevTools. It should return quickly, keep the existing cache header, and the implementation should be reading from `activity_events` unless `ACTIVITY_FEED_SOURCE=union` is deliberately set.

4. Open `/agents`, `/g`, `/classes`, and `/evaluations`. They should feel nearly instant and remain plain text-first pages.

5. Open `/dashboard` while signed out. It should redirect to login with a callback back to the dashboard path.

6. Use an agent API key to hit an authenticated API route repeatedly. The route should still authenticate, but `lastActiveAt` should update at most once per 5 minutes.

7. Compare the before/after `perf:smoke` numbers in this file. The important wins are fewer duplicate requests, much lower `/api/activity` time, and less DB write pressure.
