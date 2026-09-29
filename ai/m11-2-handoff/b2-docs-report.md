# b2 Docs report — applying every docs delta recorded since `d5b0627`

Fence: `public/*`, `agents.md`, `ai/validation/m11-inventory.md`, `ai/PLAN.md`. No `src/` touched.
No git commands run.

## Sources read

Every `ai/m11-2-handoff/b1-{w,m,r,d}-fix-r{1..6}-report.md` that exists (W: r1-5; M: r1-5; R: r1-4,
R converged in round 5 so no r5 fix; D: r1-5), `b2-lane-s-report.md` (incl. its gen-2 §8 addendum),
`b2-lane-c-report.md` (incl. its gen-2 §8 re-verification). Every claim below was grepped against
the live code before writing, not copied from a report verbatim without checking.

## Deltas applied

1. **`public/reference.md` — SSE "listen, don't poll" section** (lane S gen-1 §6). New `## Live
   stream (SSE)` section after Webhooks: `GET /v1/stream` / `/v1/stream/firehose`, `Last-Event-ID`
   replay for wakeups only (notifications/activity are live-only), Bearer or minted token auth, and
   the `POST /agents/me/stream-token` contract (`stream_not_enabled` 503, `{token,
   expires_in_seconds}`, `meta.stream_url`). Verified route paths/constants against
   `src/lib/worker/stream-server.ts` (`STREAM_PATH`, `FIREHOSE_PATH`, `parseCursor`'s
   `last-event-id` header read) and `src/app/api/v1/agents/me/stream-token/route.ts`.
2. **`public/reference.md` — P5.3 symmetry section** (lane S gen-1 §6). New `## What an agent is
   (symmetry contract)` section, placed near the top after the status/profile surfaces table.
3. **`public/reference.md` — reaction counts on context feed + news** (R fix-r2 §6). One sentence
   added after the existing `reactions` field description, naming `GET
   /agents/me/context`'s `feed.items[].reactions` and `GET /api/v1/news`'s
   `existing_discussions[].reactions`.
4. **`public/reference.md` — DM pagination bounds** (D fix-r3/r4 §Docs delta, "stricter
   previously-undocumented validation"). Added the `limit`/`offset` max bounds and the `bad_request`
   behavior for `GET /api/v1/dm` (max 100) and `GET /api/v1/dm/{agent_name}` (max 500, `before_seq`
   must be a positive integer). Verified against `src/app/api/v1/dm/pagination.ts`
   (`parsePaginationInt`, `MAX_PG_INT`) and both route files.
5. **`public/reference.md` — subscribe/unsubscribe note** (lane C §6). Replaced the old "Subscribing
   is separate from joining" note with the lane's exact suggested text, pointing at `join_group`/
   `leave_group` and `POST`/`DELETE /api/v1/groups/{name}/join`. Verified both exist
   (`src/lib/agent-tools/definitions/groups.ts`, `src/app/api/v1/groups/[name]/join/route.ts`).
6. **`public/planned.md` — AT Protocol frozen note** (lane C §6). Added verbatim under a new
   "Frozen / not active development" heading. Verified `src/lib/atproto/*` exists.
7. **`public/heartbeat.md` / `public/skill.md` — poll vs push**. Added a stream pointer to
   `heartbeat.md`'s "build your own loop" paragraph and `skill.md`'s webhook line, both pointing at
   `GET /v1/stream` / `POST /agents/me/stream-token`. Not from a report's exact text (none proposed
   wording here) — kept to one added clause each, consistent with the reference.md section.
8. **`public/openapi.json` — stream-token route + `stream_url` meta**. Added
   `/api/v1/agents/me/stream-token` (POST: 200/401/503, `StreamToken` schema, `meta.stream_url`) and
   a `StreamToken` component schema, modeled on the existing `WebhookRegistration` entry. Re-parsed
   with `node -e "JSON.parse(...)"` — valid. `src/__tests__/docs/agent-docs-contract.test.ts`'s
   `requiredOpenApiPaths` list does not require this path, so nothing else needed updating.
9. **`agents.md` — Design rules reinforced, as invariants**. Appended 11 bullets to the end of
   "Store and Migration Invariants" (lock-order-by-statement, actor-row-first, `FOR SHARE` vs `FOR
   KEY SHARE` as delete-liveness gate, seed-locks-own-subject-first + polymorphic-subject-locks-both
   halves (merging R fix-r1/r3/r4's three related invariant proposals into one coherent entry rather
   than three overlapping ones), one-row-one-modification, refused-write-leaves-nothing,
   classification-is-projected (with the `agent-visibility-sql.ts` pointer), execution-guard
   fence-loss discipline, payloads-id-only, `stream_seq` is a per-recipient counter (lane S), and
   frame-rides-the-same-statement (lane S gen-2 §8.5).
10. **`agents.md` — File Map rows**: `src/lib/store/stream/*`, `src/lib/store/agent-visibility-sql.ts`
    (read its source to confirm the JSON-boolean predicate claim), `src/lib/stream/*`,
    `src/lib/worker/stream-server.ts`.
11. **`agents.md` — env vars**: new "Environment Variables (M11b: SSE stream, P5.2)" table —
    `STREAM_ENABLED`, `STREAM_TOKEN_SECRET`, `NEXT_PUBLIC_STREAM_URL`. All three names confirmed by
    grep against `src/app/api/v1/agents/me/stream-token/route.ts`, `src/lib/stream/token.ts`, and
    `.env.example`.
12. **`ai/validation/m11-inventory.md` §8** — new "Runbook — P5.2 SSE stream (deployment unit b2 Lane
    S)": the three-deploy sequence (Vercel migration+inert producers → Render worker → env-flip
    enabling token minting + advertising the URL), then the reconcile-then-contract sequence
    naming `scripts/reconcile-stream-seq.sql` and `scripts/contract-stream-seq-not-null.sql`
    verbatim, plus a rollback paragraph. File names and their header comments verified by reading
    all three (`migrate-m11-stream.sql`, `reconcile-stream-seq.sql`,
    `contract-stream-seq-not-null.sql`).
13. **`ai/validation/m11-inventory.md` §7** — one paragraph noting the stream substrate is not a new
    event kind but a frame/replay layer over the existing wakeup/notification/activity writers,
    pointing at the §8 runbook.
14. **`ai/PLAN.md` `## Backlog`** — checked: the "M11 backlog additions" subsection already present
    (added by lane C's P7.4 work) is byte-identical (diffed) to `ai/PLAN_M11_2.md`'s 11-item
    "BETTER ENGINEERING INSIGHTS + BACKLOG ADDITIONS" list. **No change made** — nothing missing.

## Deliberately NOT changed (verified, no delta needed)

- **Webhook headers/timeouts/`context_href`** — already fully documented in `reference.md`'s
  existing `## Webhooks` section (signature header, wakeup/event id headers, `context_href` in the
  body, 3-retry backoff, auto-disable at 10 failures). Every `b1-w-fix-r*-report.md` docs section
  confirms this explicitly ("None required... no change to the documented request/response
  contract"). This predates `d5b0627` (the b-1 boundary docs pass) and none of the six fix rounds
  changed it.
- **`agents.md` lane-M/lane-D invariant additions** — every `b1-m-fix-r*-report.md` and
  `b1-d-fix-r*-report.md` "Docs delta" section explicitly says "None" for all rounds; confirmed by
  reading all ten.
- **Execution-guard semantics in `reference.md`** — investigated per the task's target list, but
  `src/lib/actions/types.ts`'s own doc comment on `execution_guard_failed` states it is "Reachable
  ONLY when the caller supplied an `executionGuard`, which is exclusively
  `agent-pulse/runner.ts`... this code never reaches an adapter's end user." It is not part of any
  REST or tool response an external caller can see, so it does not belong in the agent-facing
  reference. Documented instead as an `agents.md` invariant (item 9 above, the fence-loss-discipline
  bullet), which is where the R fix-r3 report's own suggestion for a related invariant was aimed.

## Gate

`npm test -- src/__tests__/docs --runInBand` — 1 suite, 5 tests, all green (ran in the foreground,
no background/monitor use).

## Fence compliance

Only `public/{reference,heartbeat,skill,planned,openapi.json}.md`, `agents.md`, and
`ai/validation/m11-inventory.md` were edited. `ai/PLAN.md` was read and diffed but not written
(already correct). No `src/` file touched. No git command run. `ai/PLAN_M11_2.md` and
`ai/M11_2_HANDOFF.md` were read-only.
