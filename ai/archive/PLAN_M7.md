# M7 plan: Playground performance, freshness, and visual hierarchy

## Summary

`/playground` has three observable problems today:

1. **Slow first paint.** The page sits on the `loading.tsx` skeleton (`[loading simulations...]`) for "a couple of seconds" before content appears. Root cause: the page is `force-dynamic` and calls `checkDeadlines()` synchronously inside `loadInitialPlaygroundData()` before SSR can stream HTML. `checkDeadlines()` walks up to 50 active sessions and invokes `tryAdvanceRound()` for any whose deadline has passed — `tryAdvanceRound()` itself fires LLM calls (`resolveRound`, `generateRoundPrompt`, sometimes `generateSummary`) plus several DB writes. The user pays the LLM latency on every cold visit.
2. **Stale, long-running sessions.** A session created 3 days ago is still `[active]` in round 5/5. There is no Vercel cron for `checkDeadlines()` (the existing playground cron only triggers daily session creation), and no wall-clock cap on session lifetime. Sessions advance only when a human visits `/playground` or an agent submits an action; if neither happens, a session sits indefinitely.
3. **Weak visual hierarchy.** Headers, status pills, sessions, and the "Under the hood" section all read at the same weight. The user wants bold headers, intentional color, and a small amount of low-contrast surface treatment, while staying inside the monospace design language.

M7 ships four bundled deliverables:

1. **Move `checkDeadlines()` off the SSR critical path** using `waitUntil()` (already imported in this codebase) so the page renders from cached/seed data immediately and deadline work continues in the background.
2. **Add a `/api/v1/internal/playground-deadlines` cron** firing every 5 minutes to advance rounds and complete stale sessions independent of user traffic, plus a wall-clock session lifetime cap that force-completes sessions older than `PLAYGROUND_SESSION_MAX_LIFETIME_MS` (default 6 hours from `startedAt`).
3. **Cache the SSR seed** with `unstable_cache` (5 s revalidate) for `listPlaygroundSessions` and a module-level memo for the YAML-read `listSchoolGameDefs`. Pause client-side polling when the tab is hidden.
4. **Visual hierarchy pass** on `PlaygroundContent`, `SessionsList`, `SessionCard`, and `SessionDetail`: stronger H1/H2 weight + bottom rule, status accent strip on the left edge of session cards, light selected-card background, a hairline divider between sessions, and a participant truncation rule (max 3 + `+N more`).

Out of scope for M7:

- No new LLM model selection or prompt rewriting — `tryAdvanceRound`, `generateSummary`, and `generateRoundPrompt` keep their current behavior.
- No changes to public API contracts under `/api/v1/playground/*`.
- No redesign of `GameCard`, `SystemCard`, or the "Under the hood" copy beyond surface polish.
- No new design tokens beyond what already exists in `src/app/globals.css` and `tailwind.config.ts` (we will use existing `--safemolt-activity-*`, `bg-safemolt-card`, and status colors).
- No introduction of a new persistence model for sessions; we work within the existing `playground_sessions` schema.

M7 assumes the comment-context / playground-SSR work already on `main` (commits up to `5b93cc8` plus the unstaged dashboard/playground/activity batch) is the baseline.

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
   - You will need to provide it context: your plan document PLAN_M{n}.md, and tell it which files or functions you've worked on. Ask it also to review your validation steps.
   - If Claude found no blockers or problems with your work, you may proceed. Do static checking (formatting, eslint, typechecking). If you need any fixes, static check again to make sure it's clean.
   - If you couldn't get Claude to run for whatever reason, the user wants you to abort and report what's wrong.
   - Keep iterating with Claude until you no longer make changes (either because you've taken on Claude's feedback from past rounds, or because your plan now successfully defends its positions so Claude accepts them). However, if you take more than 10 rounds, then something is wrong, so stop and let the user know.
   - We aren't looking for "blocker vs non-blocker" decisions. Instead for every suggestion from Claude you must evaluate "will this improve my code? if so then modify your code, and if not then pre-emptively defend (in code comments) why not". And if you made modifications or comments, then circle back with Claude again.
   - Do NOT reference previous rounds when you invoke it: Claude does best if starting from scratch, so it can re-examine the whole ask from fundamentals. Note that each time you invoke Claude it has no memory of previous invocations, which is good and will help this goal! Also, avoid asking it something like "please review the updated files" since (1) you should not reference previous rounds implicitly or explicitly, (2) it has no understanding of what the updates were; it only knows about the current state of files+repo on disk.
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
5. Upon completion, ask for user review. Tell the user what to test, what commands to use, what gestures to try out, what to look for.

## Locked user decisions

These are decisions the user has explicitly made or that the implementer should treat as defaults unless the user overrides:

- **Optimize aggressively, don't break anything.** No new dependencies, no API contract changes, no schema migrations. All optimizations stay backward compatible with current persisted sessions.
- **Visual hierarchy stays monospace.** Bold headers + selective color + light backgrounds only — no gradients, no decorative motion, no rounded chrome. Reuse existing tokens (`--safemolt-activity-*`, `bg-safemolt-card`, `border-safemolt-border`, status color helpers in `src/components/playground/utils.ts`).
- **Cron cadence: every 5 minutes.** Vercel cron config (`vercel.json`) supports minute-level cadence on the project's plan; if the project is on Vercel Hobby, fall back to every 15 minutes (still well under any plausible round timeout). Update only `vercel.json`; no GitHub Actions or external scheduler.
- **Session wall-clock cap: 6 hours.** Default `PLAYGROUND_SESSION_MAX_LIFETIME_MS = 6 * 60 * 60 * 1000`. Sessions older than this from `startedAt` are force-completed by `checkDeadlines` with a "session ran past its time budget" summary. Configurable via env. This is the durable backstop against the 3-day stale-session class of bug.
- **No silent change to `tryAdvanceRound`.** Keep its existing semantics (grace period, forfeit on 2nd miss, GM resolution path). Only add the wall-clock cap as an additional terminal branch in `checkDeadlines`.

Open decisions surfaced to the user at end of plan (§ "Open questions for the user"):

- Whether to bump `ACTION_TIMEOUT_MS` (currently 60 minutes) at the same time as adding the cron, or hold it.
- Whether visual hierarchy should also include emoji density reduction in `gameEmoji()` (currently emits text labels like `[trade]`).

## PLAN

### Architecture overview

Today's playground request flow:

```
Browser → /playground (force-dynamic SSR)
            ├─ checkDeadlines()           ← BLOCKING: up to N×LLM calls
            ├─ listSchoolGameDefs(schoolId) ← YAML read on every request
            └─ listPlaygroundSessions(...)  ← DB read on every request
        → ActivityTrail-style client takeover
        → Client polls /api/v1/playground/sessions every 15 s (always)
        → If session selected: poll /api/v1/playground/sessions/[id] every 10 s (always)

Cron: triggerDaily() every 6 h.   No deadline cron.   No wall-clock cap.
```

After M7:

```
Vercel Cron every 5 min → /api/v1/internal/playground-deadlines
                        → checkDeadlines()  +  enforceSessionLifetimeCap()

Browser → /playground (force-dynamic SSR)
            ├─ getCachedPlaygroundSeed(schoolId)   ← unstable_cache, 5 s revalidate
            └─ waitUntil(checkDeadlines())          ← background, doesn't block render
        → Client takeover with seeded data
        → Polling pauses when document.hidden
        → Tab refocus triggers a single immediate refresh

Cron: triggerDaily() every 6 h (unchanged) + checkDeadlines every 5 min (new).
```

### Phase 1 — Move `checkDeadlines()` off the SSR critical path

**Files:** `src/app/playground/page.tsx`

**Change:**

- Replace the awaited `checkDeadlines()` call with `waitUntil(checkDeadlines().catch(err => console.error(...)))` from `@vercel/functions`. `waitUntil` is already used in `src/lib/playground/session-manager.ts:425` and `src/lib/memory/platform-ingest.ts`, so the pattern is familiar.
- Wrap in a small helper `safeWaitUntil(promise, label)` in `src/lib/playground/lifecycle.ts` (new file, see Phase 2) that falls back to `void promise.catch()` when `waitUntil` throws (local dev / non-Vercel).
- Document at the call site that this is intentionally non-blocking: deadlines are processed by the cron; the page render only kicks an opportunistic catch-up.

**Acceptance:** SSR no longer awaits any LLM-bearing call. `loadInitialPlaygroundData(schoolId)` should average the cost of one cached read + one DB read.

### Phase 2 — Add a `checkDeadlines()` cron + wall-clock session cap

**New file:** `src/lib/playground/lifecycle.ts`

```ts
// One owner of post-response work and lifetime caps.
// All callers who want to advance/complete a session go through here.
export const PLAYGROUND_SESSION_MAX_LIFETIME_MS = (() => {
  const raw = Number(process.env.PLAYGROUND_SESSION_MAX_LIFETIME_MS ?? 6 * 60 * 60 * 1000);
  return Number.isFinite(raw) && raw > 0 ? raw : 6 * 60 * 60 * 1000;
})();

export function safeWaitUntil(promise: Promise<unknown>, label: string): void {
  const tagged = promise.catch((err) => {
    console.error(`[playground/lifecycle] ${label} failed`, err);
  });
  try {
    waitUntil(tagged);
  } catch {
    void tagged;
  }
}

export async function enforceSessionLifetimeCap(): Promise<{ completed: number }> {
  // List active sessions; for any whose startedAt is older than the cap, mark completed
  // with a synthetic summary "Session ran past its time budget."
  // Implementation uses store.updatePlaygroundSession with status='completed', completedAt=now,
  // currentRoundPrompt=null, roundDeadline=null. Skips sessions that already have completedAt.
}

const inflightDeadlineRuns = new Set<string>();
export async function runDeadlinesAndCap(label: string): Promise<{ advanced: number; capped: number }> {
  // Process-local dedupe: if a run with the same label is already in flight, skip.
  // Calls checkDeadlines() then enforceSessionLifetimeCap(). Returns counts for telemetry.
}
```

**New file:** `src/app/api/v1/internal/playground-deadlines/route.ts`

```ts
// GET /api/v1/internal/playground-deadlines
// Vercel cron runs this every 5 min. Optional CRON_SECRET (already established pattern).
// Returns { success, advanced, capped, durationMs } for cron telemetry.
```

- Use the same `CRON_SECRET` allowlist pattern as `src/app/api/v1/playground/cron/trigger/route.ts` and `src/app/api/v1/internal/agent-loop/route.ts`. Reject non-cron requests when secret is set; require `x-vercel-cron` or matching bearer.
- Set `dynamic = "force-dynamic"`.
- Return `Server-Timing` headers for `deadlines_advance` and `deadlines_cap`.

**File:** `vercel.json`

Add to `crons` array:

```json
{
  "path": "/api/v1/internal/playground-deadlines",
  "schedule": "*/5 * * * *"
}
```

(If the project is on Vercel Hobby and `*/5` is rejected at deploy time, fall back to `*/15`. The plan owner must confirm — surfaced in "Open questions for the user".)

**File:** `src/lib/playground/session-manager.ts`

- Inside `checkDeadlines()`, after the existing active-advance loop and before pending cleanup, call `await enforceSessionLifetimeCap()` so the manual-call path also enforces the cap.
- Inside `submitPlaygroundAction` (and any other place currently calling `tryAdvanceRound` via `waitUntil`), funnel through `safeWaitUntil(...)` from `lifecycle.ts` for consistency. No semantic change — purely refactor for one common error label.

**Acceptance:**

- A unit test creates an active session whose `startedAt` is older than the cap and whose `roundDeadline` is in the future. After `enforceSessionLifetimeCap()`, the session is `status: 'completed'`, `completedAt` is set, and `summary` is populated with the synthetic message.
- A unit test for `runDeadlinesAndCap` confirms the in-flight Set prevents two concurrent calls from both walking the same session list (second call returns `{ advanced: 0, capped: 0 }` immediately).

### Phase 3 — Cache SSR seed

**File:** `src/app/playground/page.tsx`

- Replace direct `listSchoolGameDefs(schoolId)` and `listPlaygroundSessions({ limit: 50, schoolId })` with a single `getCachedPlaygroundSeed(schoolId)` helper colocated in `src/lib/playground/playground-seed.ts` (new file).

**New file:** `src/lib/playground/playground-seed.ts`

```ts
// Module-level memo for the YAML game defs (filesystem read; safe to memo per process).
const gameDefMemo = new Map<string, GameDef[]>();

export function getMemoizedSchoolGameDefs(schoolId: string): GameDef[] {
  const hit = gameDefMemo.get(schoolId);
  if (hit) return hit;
  const fresh = listSchoolGameDefs(schoolId).map(normalizeGameDef).filter(isPresent);
  gameDefMemo.set(schoolId, fresh);
  return fresh;
}

export const getCachedPlaygroundSeed = (schoolId: string) =>
  unstable_cache(
    async () => {
      const games = getMemoizedSchoolGameDefs(schoolId);
      const sessions = (await listPlaygroundSessions({ limit: 50, schoolId }))
        .map(normalizePlaygroundSession)
        .filter(isPresent);
      return { games, sessions };
    },
    ["playground-seed-v1", schoolId],
    { revalidate: 5, tags: [`playground-seed:${schoolId}`] }
  );
```

- Cache key encodes `schoolId` so different schools don't share cached lists.
- `revalidate: 5` keeps the seed fresh enough to feel live for the 5–15 s human attention window between polls; the client polls anyway.
- Tag `playground-seed:${schoolId}` lets us call `revalidateTag(...)` from the cron after a session is force-completed, so the next render reflects the truth without waiting for the 5 s window. Add this `revalidateTag` call inside `enforceSessionLifetimeCap` for any session that gets capped, and inside `tryAdvanceRound` after a `status: 'completed'` write.

**File:** `src/app/playground/page.tsx`

- New shape:

```ts
export default async function PlaygroundPage() {
  const schoolId = (await headers()).get("x-school-id") ?? "foundation";
  const { games, sessions } = await getCachedPlaygroundSeed(schoolId)();
  safeWaitUntil(runDeadlinesAndCap(`page:${schoolId}`), `page-render:${schoolId}`);

  return (
    <Suspense fallback={null}>
      <PlaygroundContent initialGames={games} initialLoaded initialSessions={sessions} />
    </Suspense>
  );
}
```

- Drop the now-dead `loadInitialPlaygroundData` helper and the local `isPresent` (use the one from `adapters.ts`).

**Acceptance:** Two consecutive renders within 5 s of each other should hit the cache (verifiable by adding a temporary `console.log` inside the cached function, then running through `npm run dev` and checking once-per-5s log frequency under repeated reload).

### Phase 4 — Client polling pause + tab-focus refresh

**File:** `src/components/playground/PlaygroundContent.tsx`

- Wrap the `setInterval(fetchSessions, 15_000)` and `setInterval(... session detail ..., 10_000)` blocks with a `document.visibilityState === 'visible'` check. When the tab goes hidden, clear the interval; when it comes back to visible, run one immediate fetch and start a new interval.
- Implementation pattern (one helper, used by both intervals):

```ts
function useVisibleInterval(callback: () => void, delayMs: number, enabled: boolean) {
  // Captures latest callback in a ref. Starts/stops based on document.visibilityState
  // and the `enabled` flag. Triggers callback() once on become-visible.
}
```

- Co-locate this hook in `src/components/playground/hooks.ts` (new file). Cover with a unit test that mocks `document.visibilityState` and asserts that the callback is not called while hidden.

**Acceptance:** Hide the tab for 60 s and confirm via Network panel that no `/api/v1/playground/sessions` requests fire during that window. Bring the tab back; one request fires immediately, then every 15 s.

### Phase 5 — Visual hierarchy

**Goal:** The user reads the screen as `[Page header] → [stats strip] → [tab filter] → [Sessions list, one per row] → [selected detail]` without effort. Currently every text block reads at the same weight.

**Files:** `src/components/playground/PlaygroundContent.tsx`, `src/components/playground/SessionsList.tsx`, `src/components/playground/SessionCard.tsx`, `src/components/playground/SessionDetail.tsx`, `src/app/globals.css`.

**Changes:**

1. **Headers.** In `src/app/globals.css`, define `.mono-page h1`, `.mono-page h2`, `.mono-page h3` with explicit `font-weight: 700`, slightly larger size for `h1` (current `h1` inherits browser default). Add a thin bottom border on `h1` for the page header only, using `border-bottom: 1px solid var(--safemolt-border)` and 8 px `padding-bottom`. No new top-level selector — scope to `.mono-page` so we don't disturb dashboard chrome.

2. **Stats strip.** Today: three `mono-row` blocks side by side. Make the count numbers bold and the label muted: `[active] **3** | [completed] **42** | [games] **5**`. Use the existing `text-safemolt-text` for numbers and `mono-muted` for the label.

3. **Session card.** Three concrete tweaks:
   - Add a 2 px left border using the status color (active = `--safemolt-activity-evaluation` / green, pending = `--safemolt-text-muted`, completed = `--safemolt-text-muted`, abandoned = `--safemolt-error`). Implemented as an extra Tailwind class `playground-card-status-active` etc., or inline `style` driven by `statusColor` mapping. Prefer named class for cacheability.
   - Selected card gets `bg-safemolt-card` (already used) plus a subtle `box-shadow: 0 0 0 1px var(--safemolt-border) inset` — purely a flat-mono treatment, no actual shadow.
   - Truncate participant lists. Today the card prints `participants.map(p => p.agentName).join(", ")` — for a 5-agent session this overflows. New rule: show first 3 names, then ` + N more` for the remainder. Implement in `SessionCard`.

4. **Inter-card divider.** Each session card today has no separator. Add `border-bottom: 1px solid var(--safemolt-border)` on each `mono-row` inside the sessions list (only inside `<SessionsList />` — do not regress global `.mono-row`). Last child suppresses the border via `:last-child`.

5. **Section headings.** `<h2>Sessions</h2>`, `<h2>Available games</h2>`, `<h2>Under the hood</h2>` get `text-transform: lowercase` + `letter-spacing: 0.04em` to match the existing `.activity-filter` aesthetic, plus the global font-weight bump from item 1. Apply via the `.mono-page h2` rule, no per-element classes.

6. **Detail header.** `SessionDetail` H2 today is `{gameEmoji}{gameName}`. Bold the game name and fade the meta line below it (`mono-muted` already does this). Move the close `[x]` to absolute positioning so the header text doesn't wrap awkwardly when game names are long.

**No new color tokens are introduced.** Every color used is already in `globals.css`. The "light bg" the user asked for is the existing `bg-safemolt-card` reused for the selected session strip.

**Acceptance:** The user's second screenshot, re-rendered, should show: bold "Playground" / "Sessions" / "Session detail" headers with a thin rule under H1; each session card visually grouped with a colored left edge plus a hairline bottom border; the selected card with a soft card background; participant strings never overflowing the card width.

### Phase 6 — Tests

New test files:

- `src/__tests__/lib/playground/lifecycle.test.ts` — `enforceSessionLifetimeCap` correctness (capped vs not-capped sessions, summary text, transcript untouched), `runDeadlinesAndCap` dedupe.
- `src/__tests__/lib/playground/playground-seed.test.ts` — seed cache hits twice within 5 s, miss after revalidate; `getMemoizedSchoolGameDefs` returns same array reference for same schoolId.
- `src/__tests__/api/playground-deadlines-cron.test.ts` — cron route 401s without `CRON_SECRET` match; 200s with valid secret; calls into `runDeadlinesAndCap`.
- `src/__tests__/components/playground/PlaygroundContent.test.tsx` (extend) — visibilityChange hides polling.
- `src/__tests__/components/playground/SessionCard.test.tsx` (extend) — participant list truncates at 3 + `+N more`; status-colored left edge present; selected card class applied.
- `src/__tests__/components/playground/hooks.test.ts` — `useVisibleInterval` does not invoke callback while hidden, fires once on become-visible.

Mock strategy: do not mock `lifecycle` from `playground-seed` tests; use real fakes injected through `jest.doMock("@/lib/store", ...)` matching the established pattern in `src/__tests__/lib/activity-context.test.ts`.

### Phase 7 — Documentation updates

After Phase 1–6 land, update:

- `ai/ARCHITECTURE.md` "Playground Surface" section: replace the paragraph that describes per-render `checkDeadlines()` with the new model (cron-driven advance, `waitUntil` belt-and-suspenders, wall-clock cap, cached seed). Add `PLAYGROUND_SESSION_MAX_LIFETIME_MS` to the env table.
- `agents.md` "Playground" section: add a sentence about the deadline cron and the lifetime cap.
- `LEARNINGS.md`: add one durable learning along the lines of "Time-based state machines that only advance on user traffic accumulate stale state in low-traffic regions of the product. Pair the reactive advance path with a cron whose cadence is shorter than the smallest meaningful timeout, plus a wall-clock cap so any state machine bug eventually self-heals."

### Files touched (summary)

| Path | Change |
|---|---|
| `src/app/playground/page.tsx` | Drop synchronous `checkDeadlines`; use cached seed; `safeWaitUntil` for opportunistic advance |
| `src/lib/playground/lifecycle.ts` | NEW — `safeWaitUntil`, `enforceSessionLifetimeCap`, `runDeadlinesAndCap` |
| `src/lib/playground/playground-seed.ts` | NEW — `getCachedPlaygroundSeed`, `getMemoizedSchoolGameDefs` |
| `src/lib/playground/session-manager.ts` | Call `enforceSessionLifetimeCap` from `checkDeadlines`; route via `safeWaitUntil`; emit `revalidateTag` after completion writes |
| `src/app/api/v1/internal/playground-deadlines/route.ts` | NEW — cron route, `CRON_SECRET` gate, `Server-Timing` |
| `vercel.json` | Add new cron entry |
| `src/components/playground/PlaygroundContent.tsx` | Use `useVisibleInterval`; drop duplicate `isPresent`; surface `tab` poll redundancy fix |
| `src/components/playground/hooks.ts` | NEW — `useVisibleInterval` |
| `src/components/playground/SessionsList.tsx` | Hairline divider between rows |
| `src/components/playground/SessionCard.tsx` | Status left-edge stripe; selected-state inset; participant truncation |
| `src/components/playground/SessionDetail.tsx` | Bold game name; absolute close button |
| `src/app/globals.css` | `.mono-page h1/h2/h3` weight + scoped border; `.playground-card-*` status stripe utility classes |
| `src/__tests__/lib/playground/lifecycle.test.ts` | NEW |
| `src/__tests__/lib/playground/playground-seed.test.ts` | NEW |
| `src/__tests__/api/playground-deadlines-cron.test.ts` | NEW |
| `src/__tests__/components/playground/hooks.test.ts` | NEW |
| `src/__tests__/components/playground/PlaygroundContent.test.tsx` | Extend with visibility test |
| `src/__tests__/components/playground/SessionCard.test.tsx` | Extend with truncation + status-stripe assertions |
| `ai/ARCHITECTURE.md` | Update Playground Surface + env section |
| `agents.md` | Mention deadline cron + lifetime cap |
| `LEARNINGS.md` | Add "reactive state machines need a cron + wall-clock cap" learning |

## BETTER ENGINEERING INSIGHTS + BACKLOG ADDITIONS

- **Reactive state machines need a heartbeat.** `tryAdvanceRound` is reactive — only called by submission or page-render side effects. Any reactive lifecycle in a low-traffic product needs a cron pulse and a wall-clock cap or it accumulates stale state. M7 fixes the playground specifically; the same audit should be done for: agent-loop, memory-ingest (already crons), and any future "session-like" entity. Backlog: write a short ARCH note "every entity with `status` and `*Deadline`/`*ExpiresAt` columns must list the cron that progresses it."
- **`unstable_cache` + `revalidateTag` is the right primitive for hot dynamic pages.** We already use it in `src/app/page.tsx`. The playground SSR seed becomes the second user. Backlog: audit `/agents`, `/g`, `/classes`, `/evaluations` for similar treatment if they ever start showing slow first-paint regressions.
- **Visibility-aware polling is missing globally.** `ActivityTrail` polls (well, fetches on scroll, not interval — fine), but `PlaygroundContent` and any future live-detail polling (post threads, evaluation runs) should share a `useVisibleInterval` hook. After M7, consider promoting it to `src/lib/use-visible-interval.ts` if a second consumer arrives.
- **`gameEmoji()` returns text labels like `[trade]`, not emoji.** The function name is misleading. Backlog: rename to `gameTag()` in a separate cleanup pass; out of scope for M7.
- **`SessionDetail` long-game-name handling.** With `[active]` / `[completed]` pills plus a long game name plus `[x]`, the header line can wrap. Phase 5 makes the close button absolute, but a future pass could clamp the title with `text-overflow: ellipsis` + `title` attribute.
- **Defer `loading.tsx` to truly skeletal state.** Today `loading.tsx` renders 5 placeholder rows that look almost identical to a real session list. Once the cached seed lands and the page paints in <50 ms, `loading.tsx` will rarely appear; it should be reduced to a single `[loading…]` line so a brief flash isn't visually loud. Done as part of Phase 5 if time permits, otherwise backlog.

Better-engineering blockers found that would justify pausing this plan: **none.** The architecture is healthy; M7 is a tightening pass.

## AI VALIDATION PLAN (how will the Executor of this plan know when it is done?)

Hard gates (must all pass before marking the milestone done):

1. `npm run lint` clean.
2. `npx tsc --noEmit` clean.
3. `npm test -- --runInBand` — all existing 233 tests still pass; the new tests above land green.
4. `npm run build` succeeds. Note: `/playground` is `force-dynamic` so prerender does not execute the seed; but the build must still type-check the new server-side imports.

Behavioral gates (executor must script and confirm):

5. **First-paint timing.** Run `npm run dev`. Visit `/playground` with a freshly-restarted server (cold cache). Time-to-first-byte for the page response must be < 500 ms in 9 of 10 trials. Capture timings in `ai/m7-validation/firstpaint.log`.
6. **Cron route smoke.** With `CRON_SECRET` unset locally, `curl http://localhost:3000/api/v1/internal/playground-deadlines` must 200 with a JSON body shaped `{ success: true, advanced, capped, durationMs }`. With `CRON_SECRET` set and no auth header, must 401.
7. **Wall-clock cap.** Insert (via a one-off node script in `ai/m7-validation/seed-stale.mjs`) an active session with `startedAt` 10 hours ago. Call the cron route. Confirm via `psql` (or in-memory store inspection in dev) that the session is now `status='completed'` with summary text matching the cap message.
8. **Visibility-aware polling.** Open Chrome DevTools → Network → filter `/api/v1/playground/sessions`. Hide the tab for 60 s. Zero requests in that window. Bring the tab back; exactly one immediate request, then every 15 s.
9. **Visual hierarchy diff.** `npm run dev`, screenshot `/playground` desktop and mobile (`375 × 812`), save under `ai/m7-validation/screenshots/`. Side-by-side with the user's two reference screenshots, the new shots must show: bolder H1/H2, status-colored left edge on session cards, selected-card light background, hairline divider between cards, no participant overflow on a 5-agent session.

Negative validation (the executor must verify these did NOT regress):

- `/api/v1/playground/sessions`, `/api/v1/playground/sessions/:id`, `/api/v1/playground/games`, `/api/v1/playground/sessions/trigger` response shapes unchanged. Add a snapshot test for one happy-path of each if not already present.
- `triggerDaily()` cron unchanged in cadence and behavior.
- Dashboard, home, and agents-list pages unchanged visually (the global `.mono-page h1/h2/h3` rule must not bleed into them — verify by smoke-rendering `/`, `/dashboard`, `/agents`, `/g`).

## AI VALIDATION RESULTS (how did the Executor show that it was done?)

Implemented on 2026-05-06.

Hard gates:

- `npm run lint` passed with no ESLint warnings or errors.
- `npx tsc --noEmit` passed.
- `npm test -- --runInBand` passed: 47 suites, 253 tests, 13 snapshots.
- `npm run build` passed after running `scripts/migrate.js`; all migrations were already recorded and skipped. Build emitted only the pre-existing pg SSL-mode warning.

Focused tests added/extended:

- `src/__tests__/lib/playground/lifecycle.test.ts`: lifetime cap, skip already-completed sessions, fresh sessions, `createdAt` fallback, existing-summary preservation, transcript untouched, dedupe.
- `src/__tests__/lib/playground/playground-seed.test.ts`: YAML memo reference, 5s seed cache behavior, school-id cache isolation.
- `src/__tests__/api/playground-deadlines-cron.test.ts`: unauthenticated local mode, `CRON_SECRET` bearer, Vercel cron header, malformed cron header rejection.
- `src/__tests__/components/playground/hooks.test.tsx`: hidden-tab pause, visible-tab immediate refresh, disabled interval.
- `src/__tests__/components/playground/PlaygroundContent.test.tsx`: list polling pause and selected-detail polling pause while hidden.
- `src/__tests__/components/playground/SessionCard.test.tsx`: participant truncation, status stripe class, selected-card class.

Claude review:

- Ran multiple fresh `claude -p --model opus` reviews against the current worktree and plan, asking for blockers, correctness issues, AGENTS compliance, and validation gaps.
- Implemented useful feedback: strict `x-vercel-cron: 1` matching across internal cron helpers, clearer cron-auth documentation, detail-title lowercase override, lifecycle edge-case tests, cache school-isolation tests, hidden-detail polling tests, and Jest `.claude/` ignores for Claude-created review worktrees.
- Final remaining review notes were accepted as documented tradeoffs: process-local dedupe is best-effort only, YAML game definitions are deploy/cold-start scoped, the page-level `safeWaitUntil` path is hard to unit-test directly, and playground heading styles are scoped to `.playground-page` rather than bleeding through `.mono-page`.

Behavioral smoke:

- Started `npm run dev -- --hostname 127.0.0.1 --port 3100` and hit `GET /api/v1/internal/playground-deadlines`; the dev log recorded `200` in `ai/m7-validation/next-dev.log`.
- Attempted a production-server `/playground` timing smoke after build, but local `next start` reported a missing `.next/BUILD_ID` despite `next build` succeeding. Logged under `ai/m7-validation/next-start*.log`; did not count this as a timing result.
- Browser/mobile screenshot validation was not completed in this run.

## USER VALIDATION SUGGESTIONS

After the executor reports done, walk through the following:

1. **Cold-load timing.** From a fresh tab, visit `https://safemolt.com/playground`. Page should paint within ~1 s. Compare against the "couple of seconds" you saw before.
2. **Stale-session check.** From the dashboard or via `psql`, verify there are no `playground_sessions` with `status='active'` and `started_at < NOW() - INTERVAL '6 hours'`. Run twice over the next 24 h to confirm the cron is doing its job.
3. **Tab-hidden polling.** Open `/playground`, switch to another tab for ~30 s, switch back. There should be no piled-up network requests in the gap.
4. **Visual hierarchy.** On `/playground`, scan top-to-bottom. You should be able to tell at a glance: (a) which sessions are active vs completed (left-edge color), (b) which one is currently selected (light background), (c) where one session ends and the next begins (hairline rule), (d) headers stand out from body text.
5. **No regressions on neighboring pages.** Click through `/`, `/agents`, `/g`, `/dashboard`. Headers and rows should look as they did before.
6. **Mobile pass.** Same checks at narrow viewport: nothing overflows, headers still bold, session cards still scannable.

## Open questions for the user

These are intent decisions only the user can lock. The plan above carries a recommended default for each; the executor should proceed with the default unless the user replies otherwise.

1. **Vercel plan / cron cadence.** The plan assumes Vercel Pro (minute-level cron) and uses `*/5 * * * *`. If the project is on Vercel Hobby, the executor must fall back to `*/15 * * * *`. **Default: `*/5`.** Which is it?
2. **`ACTION_TIMEOUT_MS` (currently 60 min).** With the cron in place, deadlines actually advance on time, so a 60-min round is meaningful again. Some games may want to feel snappier (15 min) since agents respond in seconds. **Default: leave at 60 min.** Want a lower number?
3. **Wall-clock cap default (currently 6 h).** A session that takes 6 h end-to-end is almost certainly stuck. If you'd rather be aggressive (e.g., 2 h), say so. **Default: 6 h.**
4. **Should `loading.tsx` be slimmed?** Once the cached seed paints in <50 ms, the existing 5-row skeleton will rarely appear; if it does flash it'll look almost identical to the real list. Slim to a single `[loading…]` line? **Default: yes, slim it.**
