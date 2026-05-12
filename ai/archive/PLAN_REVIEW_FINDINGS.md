# Plan review findings — gaps between PLAN_M{1..5}.md validation claims and live preview behavior

Verified on 2026-05-01 against preview `safemolt-r8eqjixaa-public-ai-co.vercel.app` (Vercel share-token bypass) and production `safemolt.com`. The plan docs in `ai/PLAN_M1.md` through `ai/PLAN_M5.md` recorded their AI Validation Results from local `next start` runs only — no preview deployment was ever used. This file captures what changes when you actually deploy.

The work below is grouped by priority. Each item names files, line numbers, and acceptance criteria so it can be implemented without re-deriving context from the plan docs. If you find a fix would distort intent, push back with a comment in the file before changing code — don't silently bend the work to make tests pass.

---

## P0 — Real production regressions

### P0.1 — `Set-Cookie` on `/api/v1/classes` and `/api/v1/evaluations` defeats the CDN cache

**Symptom.** `GET https://safemolt.com/api/v1/classes` (no Authorization header, follows the apex→www. redirect) returns:
```
HTTP/1.1 200 OK
Cache-Control: public, max-age=0, must-revalidate
Set-Cookie: __Host-authjs.csrf-token=…; Path=/; HttpOnly; Secure; SameSite=Lax
Set-Cookie: __Secure-authjs.callback-url=…; Path=/; HttpOnly; Secure; SameSite=Lax
X-Vercel-Cache: MISS
```
Same for `/api/v1/evaluations`. `Set-Cookie` makes every CDN treat the response as private; combined with the no-store-style public Cache-Control it means M2.5 §7.3's `s-maxage=30, stale-while-revalidate=120` is **never honored in production**. The route handlers correctly set the s-maxage header for unauthenticated callers ([src/app/api/v1/classes/route.ts:81](src/app/api/v1/classes/route.ts:81)), but NextAuth side effects elsewhere in the request chain inject auth cookies onto the response.

**Investigation needed first.** The cookies are NextAuth's CSRF and callback-url cookies. They're not set by the route handler itself. Trace where they come from on an unauthenticated GET to `/api/v1/classes` — most likely candidates:
- A call to `auth()` reached transitively (e.g. through a layout, middleware, or a shared helper).
- `getProfessorFromRequest` / `getAgentFromRequest` triggering NextAuth init.
- The new M2.5 middleware in [src/middleware.ts](src/middleware.ts) inadvertently still touching NextAuth.

**Fix.** Once located, prevent NextAuth from setting cookies on routes that are explicitly serving a public, unauthenticated payload. Two acceptable shapes:
1. Skip NextAuth resolution entirely for these read-only public routes (matches the spirit of M2.5 §3.1).
2. Strip the offending `Set-Cookie` headers from the response on the unauthenticated branch before returning.

**Verification (must run against a Vercel deploy, not `next start`).**
- `curl -sD - -o /dev/null https://<preview>/api/v1/classes` shows zero `Set-Cookie` headers.
- A second `curl` within 30s shows `X-Vercel-Cache: HIT` and `Age` > 0.
- Authenticated callers (with `Authorization: Bearer …`) still receive correct cookies if NextAuth needs them.

### P0.2 — `Server-Timing` header is missing in production responses

**Symptom.** [src/app/api/activity/route.ts:36](src/app/api/activity/route.ts:36) builds a `Server-Timing` header via `serverTimingHeader([...])` and passes it to `jsonResponse`. M2.5 §1.2 made this a marquee deliverable. On the preview deployment the header is absent from `/api/activity` responses; M2.5 validation only saw it because it was tested with `next start`.

**Investigation needed first.** [src/lib/auth.ts:125](src/lib/auth.ts:125) defines:
```ts
export function jsonResponse(data: unknown, status = 200, headers: Record<string, string> = {}) {
  return Response.json(data, { status, headers });
}
```
`Response.json(data, init)` should preserve `init.headers`, so the most likely root causes are:
- Vercel's edge stripping `Server-Timing` (some platforms do this for privacy/perf reasons; check Vercel docs).
- Header name casing or transport handling — try setting via `NextResponse.json` or by mutating `response.headers.set("Server-Timing", …)` after construction.
- A middleware/edge transformer rewriting outgoing headers.

**Fix.** Whichever cause it is, restore the header so `curl -sD - https://<preview>/api/activity` shows `Server-Timing: activity_feed_page;dur=…, activity_total;dur=…`. Apply the same fix to `/api/activity/[kind]/[id]/context` ([src/app/api/activity/[kind]/[id]/context/route.ts](src/app/api/activity/%5Bkind%5D/%5Bid%5D/context/route.ts)).

**Verification.** Add a Vercel-deploy smoke step to `scripts/perf-smoke.js` (or a sibling) that fails if either response is missing `Server-Timing` after deploy.

### P0.3 — `safemolt.com/api/*` redirects to `www.safemolt.com/api/*` which 404s

**Symptom.**
```
$ curl -sLD - -o /dev/null https://safemolt.com/api/activity
HTTP/1.1 307 Temporary Redirect
Location: https://www.safemolt.com/api/activity

HTTP/1.1 404 Not Found
X-Matched-Path: /_not-found
```
The apex domain hosts the deployment; the `www.` host does not. Any external caller using `safemolt.com` (the canonical brand domain in `og:url`, in `agents.md`, in published API docs) is broken end-to-end. None of M1–M5 surfaces this because none of them deployed.

**Fix.** Pick one of:
1. Remove the apex→www redirect at the Vercel project / DNS layer and serve the deployment from the apex.
2. Point `www.safemolt.com` at the same deployment as the apex.

Then sweep `og:url` and any docs that hard-code `https://safemolt.com` to make sure links are not crossing the redirect (since the redirect strips the path on the www side).

**Verification.** `curl -sL https://safemolt.com/api/activity` returns the JSON activity feed. `curl -sL https://www.safemolt.com/api/activity` does the same.

---

## P1 — Validation results that are inaccurate (don't lie better; make them true)

### P1.1 — Correct the `Cache-Control` claim in M2.5 and M1 validation results

**Plan claims (false in production):**
- `ai/PLAN_M1.md` AI Validation Results, dated 2026-04-29: `/api/activity 200 with Cache-Control: s-maxage=10, stale-while-revalidate=60`.
- `ai/PLAN_M2_5.md` AI Validation Results: `/api/activity keeps Cache-Control: s-maxage=10, stale-while-revalidate=60`; `/api/v1/classes and /api/v1/evaluations return s-maxage=30, stale-while-revalidate=120`.

**Production reality.** Vercel rewrites the public `Cache-Control` to `public, max-age=0, must-revalidate` for `force-dynamic` route handlers, but the CDN itself respects the `s-maxage` and `stale-while-revalidate` set in the route — verifiable on the preview as `X-Vercel-Cache: HIT, Age: 6→8` over 8 sequential calls. So the directive *works*; the public header just doesn't reflect it.

**Action.** Edit both AI Validation Results sections to record what's actually observable end-to-end:
- "CDN behavior verified: `X-Vercel-Cache: HIT` with `Age` advancing on warm hits, proving the route's `s-maxage=10, stale-while-revalidate=60` is honored at the edge. Public `Cache-Control` is normalized by Vercel to `public, max-age=0, must-revalidate` for `force-dynamic` routes; this is expected and not a regression."
- For M2.5 §7.3, note the same about the v1 routes — but call out that **this only holds once P0.1 is fixed**, because today the `Set-Cookie` makes the CDN never cache them at all.

### P1.2 — Mark unverified milestone validation steps clearly

The following AI Validation Results bullets across the milestones are written as `[x] done` but in reality were skipped or substituted. Either re-run them now that we have a preview, or change to `[~] partial` with a one-line reason. Don't silently downgrade — keep an audit trail.

| Milestone | Bullet | Why it's incorrect |
|---|---|---|
| M2 | "git diff src/app src/components not run" — already `[ ]` | OK, leave as-is. |
| M2.5 | Playwright network validation steps | Listed as `[x]` covered by component tests; that is not the same assertion. Mark `[~]` and link to the regression test that *is* passing. |
| M3 | Behavioral-parity steps 9–10 (pre/post side-effect comparison) | Not run with the old loop binary. Mark `[ ]` not run. |
| M3 | "assert PLATFORM_TOOLS.length === 65" | Not in the test suite. Either add the assertion to `src/__tests__/lib/agent-tools/registry.test.ts` or remove the claim from validation results. |
| M5 | Visual diff "≥ 15 routes" | 6 routes captured; before/after pairs not produced. Update the count and remove the `before-after/` claim, or finish capturing. |

---

## P2 — Coverage gaps that need new code, not just doc edits

### P2.1 — Add a real preview-deploy script and use it in validation

Every milestone wrote `[ ] Preview URL: not created. No deploy script in package.json.` That's why P0.1, P0.2, and P0.3 shipped. Add:

1. A `package.json` script: `"deploy:preview": "vercel deploy --prebuilt --token=$VERCEL_TOKEN"` (or whichever shape matches the project's actual Vercel auth — check with the user; do NOT invent a token name).
2. A `scripts/preview-smoke.js` that takes a preview URL plus a share token and runs the same route table as `scripts/perf-smoke.js`, but specifically asserts:
   - `/api/activity` returns `Server-Timing` header.
   - `/api/v1/classes` and `/api/v1/evaluations` return zero `Set-Cookie` headers when called without `Authorization`.
   - `/api/activity` shows `X-Vercel-Cache: HIT` on the second call within 5s.
   - `/u` returns 404; `/dashboard` body contains `NEXT_REDIRECT;replace;/login`.

3. Document a one-liner in `ai/ARCHITECTURE.md`: "Plan validation that touches HTTP semantics or caching MUST run against a Vercel preview, not `next start`. `next start` does not reproduce CDN normalization, NextAuth cookie injection, or edge-layer header stripping."

### P2.2 — Schedule a daily `activity_events` backfill cron

M4 §1.4 makes activity-event writes best-effort: they don't block the entity write, and on failure the contract is "backfill catches up." But there is no cron — backfill is admin-gated `POST /api/v1/internal/activity-events-backfill`, manual-only. If a writer fails silently in production, activity disappears from the feed until someone notices.

**Add.**
- A `vercel.json` cron (or equivalent) that hits `POST /api/v1/internal/activity-events-backfill?force=false` once per day. `force=false` is additive — it only fills missing rows, so it can run safely.
- Authentication via the same `CRON_SECRET` already used (note: M2.5 Claude follow-up made the route fail-closed if `CRON_SECRET` is absent; preserve that).
- A test in `src/__tests__/api/activity-events-backfill.test.ts` (already exists) that asserts the route still fails closed when the header is missing — this is a regression net for the near-miss M2.5 caught.

### P2.3 — Reconsider `dedupeActivities` page-loss with `activity_events`

`src/lib/activity.ts:dedupeActivities` filters out `kind="agent_loop"` rows whose `metadata.target_id` matches another row's `entity_id` in the same response page. With M2.5/M4's denser event writes, a paginated 30-row response can return 25 visible rows after dedupe. Two acceptable fixes:

1. **Compensate at fetch time.** Over-fetch by N% in `getActivityTrailPage`, then return the first `limit` after dedupe. Keep `cursorId` paging stable across the over-fetch.
2. **Move dedupe into SQL** as M4 §BEI #5 sketches: `WHERE NOT EXISTS (SELECT 1 FROM activity_events e2 WHERE e2.kind = e1.metadata->>'target_type' AND e2.entity_id = e1.metadata->>'target_id')` on the `agent_loop` rows only. Single query, deterministic page size.

Pick one and add a test in `src/__tests__/lib/store/activity/events-feed.test.ts` that seeds a `create_post` loop event plus its underlying `post` event and asserts the response contains exactly one row, with page size honored.

### P2.4 — Invalidate `activity_contexts` on `activity_events` updates

M4 wired `INSERT … ON CONFLICT (kind, entity_id) DO UPDATE` so playground sessions update their event row on each transition (`lobby → active → completed`). The `activity_contexts` cache table is keyed on `(kind, entity_id, prompt_version)` and is NOT invalidated, so the LLM-generated context shown in the activity-trail expansion goes stale silently.

**Fix options.**
1. On the `DO UPDATE` branch in [src/lib/store/activity/events.ts](src/lib/store/activity/events.ts) (or wherever the writer lives after M2.5's split — verify the path), additionally `DELETE FROM activity_contexts WHERE kind = $1 AND entity_id = $2`. The next read will regenerate.
2. Or include a hash of the event row's `summary + title + metadata` in the cache key as a derived `prompt_version` suffix. Cleaner but a wider change.

Option 1 is simpler and matches the existing best-effort writer pattern. Add a test in `src/__tests__/lib/store/activity/events.test.ts` that updates an event row twice and asserts the corresponding `activity_contexts` entry is gone after the second write.

### P2.5 — Re-evaluate ISR on `/` now that `activity_events` exists

M1 Locked Decision #10 wanted `/` on ISR (`revalidate = 5`). Implementation reverted to `force-dynamic` because Neon serverless SQL forces dynamic during prerender. The note in M1 validation results says: "A future milestone can make `/` truly ISR by moving the feed read behind a cacheable activity-event table or a Next cache wrapper that does not execute Neon SQL during prerender." M2.5 built that table but never re-tried ISR.

**Action.** In [src/app/page.tsx](src/app/page.tsx), wrap the activity-feed read in `unstable_cache(... , ["home-activity"], { revalidate: 5 })` and remove `dynamic = "force-dynamic"`. Run `npm run build` — if Neon still poisons prerender, document why the wrapper didn't help and leave the page dynamic. If the build passes, deploy to a preview and confirm `/` HTML is served as ISR (`X-Vercel-Cache: HIT` after the first request, no re-execution of Neon SQL within the 5s window).

### P2.6 — Add `PLATFORM_TOOLS.length` assertion

In `src/__tests__/lib/agent-tools/registry.test.ts` (create if missing), add:
```ts
import { PLATFORM_TOOLS } from "@/lib/agent-tools";
test("tool count matches plan", () => {
  expect(PLATFORM_TOOLS.length).toBeGreaterThanOrEqual(60);
  expect(PLATFORM_TOOLS.length).toBeLessThanOrEqual(70);
});
```
The exact 65 number from M3 is fragile; the bracket catches accidental deletions or untracked additions without becoming maintenance churn. Update M3 validation results to reference this test by file path.

---

## P3 — Architecture observations the plans never closed

These are not bugs; they're known unknowns that should be either documented as accepted risks or scheduled. Codex should not implement these without user confirmation.

1. **`activity_events` retention.** M4 §BEI #6 noted unbounded growth at >10M rows. With six writers per user action, this comes faster than the threshold suggests. Either add a `pg_cron` or app-level retention job, or document the explicit decision to grow indefinitely until the threshold.

2. **Permanent denormalization.** Display name, group name, and post title are frozen in `activity_events` at write time. Renaming an entity does not propagate. M4 §BEI #2 mentioned this. Either accept it as a feature (audit-log semantics) and document in `agents.md`, or add a `?force=true` rebuild step that runs after rename mutations.

3. **Claude review compliance after M1.** `agents.md` requires five-parallel Claude review tasks per milestone. M1 ran all five; M2 prepared the prompt and never ran it; M2.5 used a manual handoff; M3 and M4 don't mention the reviews at all in their AI Validation Results; M5 ran one. Either re-baseline `agents.md` to match what's actually being done, or make the review step gating with a hook that blocks merge until `ai/claude-review-m{N}-*-result.md` files exist.

4. **No load test against `/api/activity` at concurrency.** M4 has 1M-row `EXPLAIN ANALYZE` timings (single query) and warm `perf-smoke` averages (single user). Cold-start behavior under 100 concurrent users is unknown. If load matters, add a `scripts/perf-load.js` using built-in `worker_threads` — no new deps.

5. **Preview-deploy in CI.** Closely related to P2.1. Even one CI run per push that produces a preview URL and runs `scripts/preview-smoke.js` would have caught P0.1, P0.2, and P0.3. If CI doesn't currently do this, add it — but coordinate with the user before changing CI config (out-of-band cost implications).

---

## Order of execution suggestion

P0 first, in any order — they're independent and each is a real-user-facing bug. P1 is doc-only and quick; do it after P0 so the rewritten validation results reflect post-fix reality. P2 is genuine new work and benefits from a working preview pipeline (P2.1) landing first. P3 needs the user before any code is written.

Do NOT batch-update plan validation results across milestones in a single sweep. Each milestone's `AI VALIDATION RESULTS` section should be edited only when the corresponding fix has been verified on a deploy, with the new evidence (curl output, test name) in the bullet.

When in doubt about scope or intent for any item above, ask before implementing — the original plans encode user preferences this brief doesn't repeat.
