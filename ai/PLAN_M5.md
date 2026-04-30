# M5 plan: Interior surfaces aesthetic alignment, per-route loading skeletons, and the PlaygroundContent component split

## Status after M2.5 speed-priority decision

If `ai/PLAN_M2_5.md` is executed as written, the core `activity_events` work moves before M3. M5 should then treat any `ACTIVITY_FEED_SOURCE` or UNION cleanup as conditional: delete it only if M4 has not already completed the burn-in cleanup. The UI/interior-surface parts of this plan remain valid.

## Summary

M1 reskinned the public surfaces. M2 cleaned the back-end. M3 unified the agent runtime. M4 modernized the activity-feed write architecture. M5 closes the visible loop: the *interior* surfaces — the dashboard, the playground board, and the deeper class/eval pages — get the same monospace terminal aesthetic the public app already wears, and the rough edges that show up while pages load (a single global `[Loading...]` for every route, regardless of context) get replaced with route-specific skeletons.

Three concrete things ship in M5:

1. **`PlaygroundContent.tsx` (1,158 lines, single React component) gets split into four sub-components** that each fit on a screen: `PlaygroundBoard`, `PlaygroundSessionDetail`, `PlaygroundSystemsPanel`, and `PlaygroundParticipants`. The split is mechanical — each sub-component already exists internally as a standalone function (`SessionCard`, `SessionDetail`, `SessionSystemsPanel`, `TranscriptRoundCard`, etc.); M5 promotes them to per-file modules and trims `PlaygroundContent.tsx` to a coordinator.
2. **Per-route `loading.tsx` skeletons** for the routes that today fall back to `src/app/loading.tsx`'s single `[Loading...]` line. M5 adds skeletons that *match the page they're loading* — a post-page skeleton looks like a post page, an agent-profile skeleton looks like an agent profile.
3. **Interior surfaces aesthetic alignment.** This is the dashboard interior (`/dashboard/*`), playground interior (`/playground` board), and deep evaluation/class pages (`/evaluations/[sip]`, `/evaluations/result/[resultId]`, `/classes/[id]`). M1 punted these explicitly. M5 takes them, using the same `mono-page` / `mono-row` / `dialog-box` primitives M1 established.

This is the first milestone since M1 that touches user-visible UI. It's also the first milestone that depends on **no upstream milestone** for correctness — M5 could in principle run in parallel with M3 or M4. We sequence it last because: (a) the interior surfaces are calmer when the back-end refactors have settled, and (b) the per-route loading skeletons are easier to write once the components they're skeleton-ing have been simplified.

Out of scope, on purpose:
- No new product features. M5 is purely surface work.
- No new components in the public-shell library. The existing primitives are enough; M5's discipline is "use what's there."
- No mobile-specific layout work. The mono aesthetic is mobile-friendly by default; M5 verifies but doesn't redesign.
- No design-system extraction. The primitives stay as `globals.css` classes plus Tailwind tokens. A future "extract a real design system" milestone is out of scope here.
- No dashboard redesign — only re-skin. Information architecture (which sections exist, which routes exist under `/dashboard`) stays untouched.

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
   - Provide context: PLAN_M{n}.md and which files/functions you've worked on.
   - Iterate with Claude until no more changes (max 10 rounds). Do NOT reference previous rounds.
4. After implementation, do a "better engineering" phase
   - Clean up LEARNINGS.md and ARCHITECTURE.md per the learnings decision tree.
   - Launch all five Claude review tasks in parallel: correctness, AGENTS.md style, LEARNINGS.md compliance, milestone goal satisfaction, KISS/consolidation/refactor.
5. Upon completion, ask for user review with concrete walkthrough steps.

---

## Locked user decisions

1. **Same primitives as M1.** No new CSS classes, no new components in `src/components/`. Use `mono-page`, `mono-page-wide`, `mono-row`, `mono-block`, `dialog-box`, `pill`, `pill-active`, `btn-primary`, `btn-secondary`, `card`, `.activity-link-*`. If a new primitive feels necessary, M5 stops and surfaces it as a question — don't proliferate.

2. **`PlaygroundContent.tsx` split layout:**
   ```
   src/components/playground/
     PlaygroundContent.tsx        # Coordinator: ~150 lines. Owns top-level state (session, sessions list, polling). Delegates rendering.
     SessionsList.tsx             # The list-of-sessions left pane. Renders SessionCard per item. ~120 lines.
     SessionCard.tsx              # Single-card list row. Pulled out of current SessionCard (line 492). ~95 lines.
     SessionDetail.tsx            # The right-pane detail view. Pulled out of current SessionDetail (line 586). ~160 lines.
     SessionSystemsPanel.tsx      # The systems panel inside SessionDetail. Pulled from line 761. ~205 lines.
     TranscriptRoundCard.tsx      # Per-round transcript card. Pulled from line 966. ~100 lines.
     CountdownBadge.tsx           # The deadline countdown chip. Pulled from line 1069. ~30 lines.
     GameCard.tsx                 # The "available games" card (shown when no session selected). Pulled from line 1098. ~25 lines.
     SystemCard.tsx               # Generic system card (used by SessionSystemsPanel). Pulled from line 1124. ~35 lines.
     TraitBar.tsx                 # Personality-trait progress bar. Pulled from line 746. ~15 lines.
     types.ts                     # Participant, PrefabInfo, MemoryEntry, SessionSystems, TranscriptRound, PlaygroundSession (currently lines 12-89).
     utils.ts                     # timeAgo, timeRemaining, statusColor, gameEmoji (currently lines 106-156).
   ```
   The current `src/app/playground/PlaygroundContent.tsx` becomes a 5-line file: `export { PlaygroundContent } from "@/components/playground/PlaygroundContent";` — preserves the import path the playground page already uses.

3. **No behavior change in PlaygroundContent.** The split is mechanical: cut function, paste into new file, add imports/exports, update parent's import. Hooks and state location do not move (everything stays in `PlaygroundContent.tsx` coordinator). If a component currently receives 8 props, it still receives 8 props after the split.

4. **Per-route `loading.tsx` files added for**:
   - `/post/[id]/loading.tsx` — page-shape skeleton: header strip, post body, comments list of 5 placeholder rows.
   - `/u/[name]/loading.tsx` — header line skeleton, stats row, recent posts/comments list of 5.
   - `/g/[name]/loading.tsx` — group header, posts list of 10.
   - `/agents/loading.tsx` — agents directory list of 20.
   - `/evaluations/loading.tsx` — heading + 12 evaluation rows.
   - `/evaluations/[sip]/loading.tsx` — eval-detail page skeleton: header, status block, results table.
   - `/evaluations/result/[resultId]/loading.tsx` — result-detail page skeleton.
   - `/classes/loading.tsx` — class list of 8.
   - `/classes/[id]/loading.tsx` — class-detail skeleton.
   - `/playground/loading.tsx` — playground board skeleton: list pane + detail pane.
   - `/dashboard/loading.tsx` already exists — verify it's adequate, leave untouched if so.
   - `/research/loading.tsx`, `/research/[slug]/loading.tsx` — research index/article skeletons.
   - `/search/loading.tsx` — search results placeholder.

   **Skeletons use the existing `.skeleton` CSS class** (`globals.css` after M1 cleanup is `background: var(--safemolt-card)`, no animation — that's intentional and matches the no-decoration aesthetic). Each skeleton element is a `<div className="skeleton h-Xpx w-Y" />` shape-matching the real element.

5. **Dashboard interior aesthetic.** Apply `mono-page` + `mono-row` + `dialog-box` to:
   - `/dashboard/page.tsx` (overview)
   - `/dashboard/agents/page.tsx`
   - `/dashboard/chat/page.tsx`
   - `/dashboard/admissions/page.tsx`
   - `/dashboard/connectors/page.tsx`
   - `/dashboard/onboarding/page.tsx`
   - `/dashboard/public-agent/page.tsx`
   - `/dashboard/settings/page.tsx`
   - `/dashboard/teaching/page.tsx`
   - `/dashboard/fellowship/page.tsx`
   - `/dashboard/demo/page.tsx`
   - `/dashboard/layout.tsx` — reskin its sidebar+topbar to match the public header style. Keep the section nav structure (Overview / Chat / Admissions / Teaching / Connectors / Settings) but render it pipe-separated `[overview] | [chat] | [admissions] | …` like the public header.
   - Dashboard component reskins are case-by-case; the heaviest is `MyAgentsList.tsx` (535 lines) — reskinned in place, no functional change.

6. **Playground interior reskin.** The `PlaygroundContent.tsx` interior (after the split) gets restyled to match. Cards become `mono-row`-style entries with `[bracketed]` labels for round numbers, status, and participant lists. The transcript view becomes a sequential `mono-block` with `[round 1]`, `[round 2]` headers. Markdown rendering stays (still `react-markdown`); the prose styles stay scoped via `.prose-playground` (which M1 left in place — verify it survived M2's CSS token migration in Phase 3).

7. **Deep evaluation pages reskin.**
   - `/evaluations/[sip]/EvaluationPageClient.tsx` (558 lines) — currently a card+grid layout, becomes a `mono-page-wide` table-ish layout. Section headers as `[#H## section name]`. Result rows as `mono-row` entries.
   - `/evaluations/result/[resultId]/ResultPageClient.tsx` (254 lines) — similar treatment. Markdown content (judge feedback) renders inside a `dialog-box`.

8. **Deep class pages reskin.**
   - `/classes/[id]/ClassDetailClient.tsx` (222 lines) — `mono-page` skin, lists become `mono-row` entries.

9. **Cleanup deferred from M1's locked decisions:**
   - The `train2.png` image asset and any references in the dashboard tree are already gone after M1 §3.1. Verify and delete the image file from `/public/` if no remaining `<img src="/train2.png" />` references exist.
   - The `Footer.tsx` import in `src/app/layout.tsx` was removed in M1 but the file may still exist. Verify with `grep -rn "from \"@/components/Footer\"" src/`. If zero importers, delete the file.

10. **`/api/activity` JS dedupe (`dedupeActivities` in `src/lib/activity.ts`)** stays — M4's `(kind, entity_id)` UNIQUE constraint solves the *write* side, but the read still needs to dedupe `agent_loop` events against their underlying entity events for the UI. Document this so M5's executor doesn't accidentally remove it.

11. **The legacy union SQL from M4 Phase 5 gets deleted in M5.** After M4's burn-in window passes (≥ 7 days of clean traffic on the new path), M5 deletes the `if ACTIVITY_FEED_SOURCE = "union"` branch from `src/lib/store/activity/db.ts:listActivityFeed` and the `ACTIVITY_FEED_SOURCE` env var. This is a cleanup task M4 deferred to M5 by design.

12. **No new dependencies.**

### Executor questions deferred to user signoff

- **Q1.** The dashboard sidebar nav (`dashboard/layout.tsx:6-13`) shows the route list as a vertical list. Reskinning to pipe-separated horizontal text (matching public Header) might feel cramped on small screens. Should we keep it vertical for the dashboard or commit to the public header pattern? *Recommendation: vertical on the dashboard. The dashboard is task-focused (you stay on one route for minutes); the public header is navigation-focused (you click between routes constantly).*
- **Q2.** The skeleton CSS class today is a flat `background: var(--safemolt-card)` (no shimmer, M1 explicitly removed the animation). Should the skeletons read as "things will load here in a moment" via dim text labels (`[ post ]`, `[ author ]`, `[ Loading… ]` placeholders) rather than as solid grey blocks? *Recommendation: prefer text placeholders. They communicate intent and match the terminal aesthetic; solid blocks read as gradient-era skeleton.*
- **Q3.** The Playground board has a 10-second polling loop for live session updates. After the split, where does that live? *Recommendation: `PlaygroundContent.tsx` coordinator owns the polling; sub-components are pure renderers. This matches React data-down/events-up convention.*
- **Q4.** `/dashboard/teaching` is professor-only. Should its loading skeleton check session and skip rendering if non-professor (faster user perception of "I shouldn't be here") or always render? *Recommendation: always render the generic dashboard skeleton; auth gating happens after data load.*

---

## PLAN

Three phases. They are largely independent; an executor can work them in any order. The plan order below is "easiest first" so the M5 PR can be merged in increments.

### Phase 1 — Per-route `loading.tsx` skeletons

#### 1.1 Pattern

Each `loading.tsx` is a server component that returns a static skeleton matching its sibling `page.tsx`'s layout. No client-side state, no `"use client"`. Skeleton elements use plain divs + the `.skeleton` class for blocks where text-placeholder doesn't fit (e.g. avatars), and bracketed text placeholders for everything else.

Reference template (e.g. `/post/[id]/loading.tsx`):

```tsx
export default function Loading() {
  return (
    <div className="mono-page mono-page-wide">
      <div className="mono-block">
        <p className="mono-muted">[loading post...]</p>
      </div>
      <div className="dialog-box mono-block">
        <p className="mono-muted">[ title ]</p>
        <p className="mono-muted">[ author ]  •  [ group ]  •  [ time ]</p>
      </div>
      <div className="mono-block">
        {Array.from({ length: 5 }).map((_, i) => (
          <div key={i} className="mono-row">
            <p className="mono-muted">[ comment {i + 1} ]</p>
          </div>
        ))}
      </div>
    </div>
  );
}
```

#### 1.2 Per-route customization

Each route's loading.tsx mirrors that route's body shape but with placeholder text. Specifics:

- `/u/[name]/loading.tsx`: header line `[ u/loading ]  •  [ display name ]  •  [ — pts ]`, stats row of 4 `mono-row`s (`[ posts: — ]`, `[ comments: — ]`, `[ followers: — ]`, `[ following: — ]`), recent activity list of 5.
- `/g/[name]/loading.tsx`: header `[ g/loading ]`, description `dialog-box` placeholder, posts list of 10.
- `/agents/loading.tsx`: 20 `mono-row`s of `[ — agent name —  •  — pts ]`.
- `/evaluations/loading.tsx`: heading `Evaluations`, 12 `mono-row`s `[ SIP-—  •  — ]`.
- `/evaluations/[sip]/loading.tsx`: heading placeholder, status block placeholder, results table of 8 rows.
- `/evaluations/result/[resultId]/loading.tsx`: heading + judge feedback placeholder block.
- `/classes/loading.tsx`: heading + 8 class rows.
- `/classes/[id]/loading.tsx`: class header + sessions list + evals list, all placeholder.
- `/playground/loading.tsx`: two-pane layout: sessions list of 5 on left, detail placeholder on right.
- `/research/loading.tsx`, `/research/[slug]/loading.tsx`: heading + content placeholder.
- `/search/loading.tsx`: search bar (rendered identical to the real search bar — Next renders `loading.tsx` while `page.tsx` runs, so the search input feels persistent).

#### 1.3 Don't break what works

- The root `src/app/loading.tsx` (`mono-page mono-muted`, `[Loading...]`) stays — it's the fallback for routes with no per-route loading. It's already in the new aesthetic.
- The dashboard `src/app/dashboard/loading.tsx` exists already; verify it's terminal-aesthetic and adequate, leave as-is or update its placeholder text only.

### Phase 2 — Split `PlaygroundContent.tsx`

Mechanical cut/paste. Each sub-component is already a top-level function in the current file; M5 just moves them.

#### 2.1 Folder skeleton

```
src/components/playground/
  PlaygroundContent.tsx     # The exported coordinator (was the file in src/app/playground/)
  SessionsList.tsx
  SessionCard.tsx
  SessionDetail.tsx
  SessionSystemsPanel.tsx
  TranscriptRoundCard.tsx
  CountdownBadge.tsx
  GameCard.tsx
  SystemCard.tsx
  TraitBar.tsx
  types.ts
  utils.ts
```

#### 2.2 Cut/paste recipe per file

For each function in the current `src/app/playground/PlaygroundContent.tsx`:
1. Cut the function body.
2. Paste into the matching new file.
3. Add `"use client"` at the top if the function uses hooks.
4. Add the imports it needs (most need `Link from "next/link"`, some need `useState`/`useEffect`, the `types.ts` exports, the `utils.ts` exports, and `react-markdown` for transcript renders).
5. Export the function.
6. In the coordinator, replace the inline definition with `import { ComponentName } from "./ComponentName"`.

Order matters — split the leaf components first (`TraitBar`, `CountdownBadge`, `SystemCard`, `GameCard`), then the medium ones (`TranscriptRoundCard`, `SessionCard`), then the heavy ones (`SessionSystemsPanel`, `SessionDetail`, `SessionsList`), finally the coordinator.

After all moves, run `npx tsc --noEmit` after each batch to catch missing imports immediately.

#### 2.3 Move the file

The current path `src/app/playground/PlaygroundContent.tsx` becomes a 1-line re-export so the playground page's import doesn't change:

```tsx
// src/app/playground/PlaygroundContent.tsx
export { PlaygroundContent } from "@/components/playground/PlaygroundContent";
```

Why not just delete the wrapper? Because `src/app/playground/page.tsx` imports `./PlaygroundContent`, not `@/components/playground/...`. The 1-line wrapper preserves that import while moving the implementation under `components/`. Optionally, M5 also updates the page to use the components import directly and deletes the wrapper. *Recommendation: update the page and delete the wrapper for cleanness; the cost is one line of diff.*

### Phase 3 — Interior surfaces aesthetic alignment

#### 3.1 Dashboard pages

For each dashboard page in the locked list:
- Wrap the outer container in `<div className="mono-page mono-page-wide">`.
- Replace section headers (currently `<h1 className="text-2xl font-bold">`) with `<h1>[ section name ]</h1>` (the `mono-page h1` rule already styles them).
- Convert card grids to `mono-row` lists where the data is list-shaped.
- Convert info panels (e.g. `InferenceKeysPanel`, `AgentChatPanel`) to `dialog-box`-wrapped content. Keep their interactive logic untouched.
- Buttons stay `btn-primary` / `btn-secondary` — they're already aesthetic-aligned.

#### 3.2 Dashboard layout (`src/app/dashboard/layout.tsx`)

The current layout (current state at `src/app/dashboard/layout.tsx:34-80`) has:
- A mobile horizontal nav strip.
- A desktop vertical sidebar.
- A topbar with signed-in label + sign-out link.
- Main content area.

M5 keeps this structure (per Q1 recommendation: vertical sidebar stays) but reskins:
- The mobile nav strip becomes a wrapped pipe-separated bracket list: `[overview] | [chat] | [admissions] | [teaching*] | [connectors] | [settings]` — same idiom as the public header.
- The desktop sidebar gets the `[ section ]` header pattern: `[ DASHBOARD ]` at top, then `[ overview ]`, `[ chat ]`, etc., one per line, each as a Link with `text-decoration: underline` on hover.
- The topbar collapses to a single line: `[signed in: <user>]                           [sign out]`.
- All Tailwind cards (`rounded-md`, `bg-safemolt-paper/80`, etc.) drop in favor of `dialog-box` where a panel is needed and bare layout otherwise.

#### 3.3 Playground board

After Phase 2's split, the per-component reskin is small:
- `SessionsList.tsx`: each session is a `mono-row` line `[ <status> ]  <game emoji> <game name>  •  <participants>  •  <time>`.
- `SessionCard.tsx`: outer card → `mono-row` (single-line). Click target opens the detail.
- `SessionDetail.tsx`: outer card → `dialog-box` blocks per section: `[ status ]`, `[ participants ]`, `[ current round ]`, `[ transcript ]`.
- `SessionSystemsPanel.tsx`: prefab cards become `mono-row` list, memory entries become `mono-row` list with `[ importance ]` prefix.
- `TranscriptRoundCard.tsx`: outer wrapper → `mono-block`. Round header `[ round N ]`. GM prompt and resolution render via `react-markdown` inside a `dialog-box`. Action list as `mono-row`s.
- `CountdownBadge.tsx`: `pill`-styled badge `[ <countdown> ]`. Already terse — verify aesthetic.
- `GameCard.tsx`, `SystemCard.tsx`, `TraitBar.tsx`: small visual treatment, mostly text-first.

#### 3.4 Deep evaluation pages

`EvaluationPageClient.tsx`:
- Page wrapper → `mono-page-wide`.
- Hero card with eval title → single line `[ SIP-XX ] <eval name>` + `dialog-box` with description.
- Status block → `[ status: <state> ]` line.
- Results table → `mono-row` per result with `[ pass | fail ]  <agent>  •  <score>  •  <time>`.
- Proctor links use `.activity-link-agent` (now a Tailwind token after M2).

`ResultPageClient.tsx`: similar but smaller — `[ result ] <agent> <eval>` header, `dialog-box`-wrapped judge feedback, `mono-row` per attempted criterion.

#### 3.5 Deep class pages

`ClassDetailClient.tsx`: class header `[ <class name> ]`, `dialog-box` description, `mono-row` per session and per evaluation.

#### 3.6 Cleanup of leftover M1 deferrals

- Delete `public/train2.png` if no remaining references (`grep -rn "train2.png" src/`).
- Delete `src/components/Footer.tsx` if no remaining importers.
- Delete the legacy union SQL branch from `src/lib/store/activity/db.ts:listActivityFeed` and the `ACTIVITY_FEED_SOURCE` env var (M4 §11). Update `ai/PLAN_M4.md`'s "AI VALIDATION RESULTS" section with a note that M5 completed the burn-in cleanup.

---

## BETTER ENGINEERING INSIGHTS + BACKLOG ADDITIONS

1. **`MyAgentsList.tsx` (535 lines) and `AdmissionsStaffClient.tsx` (491 lines) are the next-largest single-file components after the playground split.** Same playbook as Phase 2 — split into per-section components — but defer until they're touched for product reasons. M5 only reskins them.
2. **The dashboard's "double sidebar" was fixed in M1 (deletion of the LeftNav-and-train branch in ClientLayout). After M5 the dashboard layout is the only dashboard shell.** Consider promoting the `dashboard/layout.tsx` sidebar pattern to a primitive (`SidebarLayout`) if a future surface (e.g. a `/teaching/*` standalone area) wants the same shape. Don't extract proactively; wait for the second consumer.
3. **`react-markdown` is used in three places: PlaygroundContent's transcript, ResultPageClient's judge feedback, and Research articles.** Configuration drifts between them. Consolidate after M5 by promoting the playground's `prose-playground` (after rename to `prose-mono`, scheduled in M2 backlog) into a shared `<Prose>` wrapper component. Defer.
4. **`agent-loop_action_log` event dedupe in JS (`dedupeActivities`).** After M4's `(kind, entity_id)` UNIQUE constraint, the dedupe could be expressed in SQL. M5 deliberately keeps the JS path because it's tested and small; M6+ can move it to SQL once the activity events table has burned in for a quarter.
5. **Per-route `loading.tsx` skeletons are static.** A future enhancement is making them progressive (e.g. start showing real data as it streams in via React Server Component streaming). Requires a Next 14.2+ feature and a different skeleton structure. Defer.
6. **Search / search results page (`/search`) has minimal aesthetic work in M5 — it's basic by design.** A focused search-UX pass could add result faceting, infinite scroll, and a result-type filter mirroring the activity trail's `[post]` `[comment]` `[playground]` chips. Defer.
7. **The playground `react-markdown` dependency may be replaceable by a 50-line markdown→HTML transformer if all we render is GM-emitted markdown.** Defer; the dep is small.
8. **`src/lib/research-mdx.tsx` is 19 lines and out of scope per the M1 backlog.** Leave it. Reaffirmed in M5.

---

## AI VALIDATION PLAN

### Static checks

1. `npm run lint` clean.
2. `npx tsc --noEmit` clean. The PlaygroundContent split is most likely to surface type issues — every prop becomes an explicit signature.
3. `npm test` clean — including any new component tests.
4. `npm run build` clean.

### New tests M5 must add

5. `src/__tests__/components/playground/SessionCard.test.tsx`: render with a sample session, assert the title, status badge, and time-ago text appear.
6. `src/__tests__/components/playground/PlaygroundContent.test.tsx`: render the coordinator with a sample sessions list, assert it shows the list pane and an empty detail prompt.
7. `src/__tests__/app/loading-skeletons.test.ts`: import each new `loading.tsx` and snapshot-render. Catches regressions if a skeleton accidentally throws.

### Diff hygiene

8. `git diff --stat HEAD~1 src/app/playground/PlaygroundContent.tsx` shows -1158 + the 1-line wrapper. `src/components/playground/` shows ~1100 added across 12 files. **Net total component lines unchanged** — this is a pure split.
9. `git diff` against `src/app/api/**` shows zero changes. `git diff` against `src/lib/store/**` shows only the deletion of the union SQL branch and the `ACTIVITY_FEED_SOURCE` env var (M5 §3.6).

### Visual diff (the most important check for an aesthetic milestone)

10. **Per-page screenshot diff.** For each reskinned page (≥ 15 routes total), capture a Playwright screenshot at 1280×800 against the M4 baseline branch and against the M5 head. The diff should be intentional (mono aesthetic applied) and should not show layout breakage (cut-off content, overlapping elements).

    The executor produces a screenshot grid in `ai/m5-screenshots/before-after/<route-slug>.png` for the user to skim.

11. **Mobile viewport check.** Same screenshots at 375×667. Mobile must remain readable; no horizontal scroll; no buttons truncated.

### Skeleton verification

12. For each new `loading.tsx`, throttle the network in DevTools to "Slow 3G", load the page fresh, and confirm the skeleton appears for ≥ 1 second before the real content. The skeleton should resemble the page being loaded (header in roughly the same place, lists with roughly the right number of placeholder rows).

### Production verification

13. Vercel preview deploy. Click through every public route plus every dashboard route while signed in. No console errors. No 5xx.
14. Open `vercel logs` during the click-through. Confirm zero `[activity_events] write failed` warnings (M4 health check) and zero React render errors.

---

## AI VALIDATION RESULTS

*To be filled by the executor during M5 implementation.*

- [ ] `next lint` clean
- [ ] `tsc --noEmit` clean
- [ ] `jest` clean (3 new test files)
- [ ] `next build` clean
- [ ] Per-page screenshot diff captured in `ai/m5-screenshots/`
- [ ] Mobile viewport screenshots captured
- [ ] Each new loading.tsx visible on Slow 3G throttle
- [ ] Zero console errors during full route walk-through
- [ ] Preview URL: <link>

---

## USER VALIDATION SUGGESTIONS

A walkthrough you can do in ≈ 10 minutes against the Vercel preview to confirm M5 delivered.

1. Open the preview. Throttle the network to "Slow 3G" in DevTools (Network tab → Throttling). Load `/post/<some id>`. The skeleton should look post-page-shaped (header line, body block, comment placeholder rows) — not a single `[Loading...]` line.
2. Repeat for `/u/<some agent>`, `/g/<some group>`, `/agents`, `/evaluations`, `/classes`, `/playground`. Each loading state should match its page's shape.
3. Untrottle the network. Open `/playground`. Confirm the board still works end-to-end: click a session, see its detail, see live countdown, see the transcript.
4. Open DevTools → Sources. Find `src/components/playground/`. Click into `SessionDetail.tsx` (~160 lines), `SessionSystemsPanel.tsx` (~205 lines), `TranscriptRoundCard.tsx` (~100 lines). Each file should be readable end-to-end without scrolling for an hour.
5. Open `src/app/playground/PlaygroundContent.tsx`. It should be either a 1-line re-export wrapper, or have been deleted entirely with the page importing from `@/components/playground/PlaygroundContent` directly.
6. Sign in. Open `/dashboard`. The page should look terminal-aesthetic: monospace, sharp borders, no rounded cards, no green hero gradients. The sidebar on the left lists `[ overview ]`, `[ chat ]`, `[ admissions ]`, `[ connectors ]`, `[ settings ]` — clickable, underline on hover.
7. Click `/dashboard/agents`. The agents list should render as `mono-row` entries — one per line, scannable at a glance.
8. Click `/dashboard/chat`. Send a chat message to your provisioned agent. The chat panel should be `dialog-box`-wrapped; messages are mono-styled. The agent's tool calls (after M3) should still execute; the response should still arrive.
9. Open `/evaluations/SIP-1` (or any eval). The page should look like the public surfaces — heading line `[ SIP-1 ] <name>`, `dialog-box` description, results as `mono-row` per result.
10. Open the activity trail at `/`. Refresh. Open DevTools → Network. The `/api/activity` response time should be the same as M4 (no regression). The `dedupeActivities` SQL note in `src/lib/activity.ts` should still exist (it stays per Locked Decision §10).
11. Confirm cleanup: `grep -rn "train2.png" src/` — zero results. `ls src/components/Footer.tsx` — file gone. `grep -rn "ACTIVITY_FEED_SOURCE" src/ scripts/` — zero results (env var removed).
12. Browse the `ai/m5-screenshots/before-after/` folder the executor produced. Each before/after pair should show the same content but in the new mono aesthetic.
