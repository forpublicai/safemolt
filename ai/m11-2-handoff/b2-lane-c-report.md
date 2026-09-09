# b2 Lane C report — P7.1–P7.4 (strangler deletions, durable playground memory, route reconciliation, planning hygiene)

## 1. Deliverables

| Item | Status | Notes |
|---|---|---|
| P7.2 durable playground memory | **Already done** (M11-1b D5, prior wave) — verified, no changes | `src/lib/playground/memory.ts`, `src/lib/store/playground/agent-memories-{db,memory}.ts`, `scripts/migrate-playground-agent-memories.sql` |
| P7.4 planning hygiene | **Done** this session | file moves, archive index, `PLAN.md` Backlog + template refs, `PLAN_M10.md` note |
| P7.3 route reconciliation | **Already done** (prior wave) — verified, no code changes; docs delta recorded below | `src/app/api/v1/playground/sessions/active/route.ts` |
| Boundary-allowlist shrink | **Already at the permanent set** — verified idempotent, no changes | `scripts/gen-eslint-boundary.js`, `.eslintrc.json` |
| P7.1 strangler deletions | **Not started — blocked**, handoff written | `ai/m11-2-handoff/b2-lane-c-handoff.md` |

### P7.2 — verified, not reimplemented

`src/lib/playground/memory.ts` is already a thin async facade over
`src/lib/store/playground/agent-memories-{db,memory}.ts` (not the
`src/lib/store/playground-memories/{db,memory,index}.ts` path the spec suggested — the prior wave
used a different file layout inside the existing `playground/` store domain; behavior matches the
plan's remedy exactly: one row per (agent, session), composite PK, `ON CONFLICT ... DO UPDATE`
overwrite-per-round, both FKs `ON DELETE CASCADE`, `importance` stored verbatim). Migration
`scripts/migrate-playground-agent-memories.sql` is recorded in `scripts/migrate.js`'s
`MIGRATION_FILES` (label "Durable playground episodic memories") and carries its own postcondition
checks (PK, FK cascade shape, index). `applyPlaygroundResolution` writes a round's memories inside
the same CAS-gated statement as the round advance (`src/lib/store/playground/db.ts`), which is
stronger than the plan's per-memory write. Given this, P7.2 required no new code from this lane.

### P7.3 — verified, not reimplemented

`GET /api/v1/playground/sessions/active` (`src/app/api/v1/playground/sessions/active/route.ts`)
calls `getActiveSession` (`src/lib/playground/session-manager.ts`), which itself reads through
`store.listPlaygroundSessions({ status: 'active' | 'pending', ... })` — the identical store primitive
`GET /api/v1/playground/sessions?status=active` (`src/app/api/v1/playground/sessions/route.ts`)
calls. The route stays (pinned contract) and is already "a filter over the same store read," so no
code change was needed. ATProto stub is untouched (out of this lane's fence — `src/lib/atproto/*`
was not opened).

### P7.4 — done

- Moved (via `mv`, not git): `ai/AGENT_EXPERIENCE_AUDIT.md`, `ai/AGENT_EXPERIENCE_AUDIT_2026-05-14.md`,
  `ai/AGENT_UX_PRIMITIVES_PLAN.md`, `ai/cleanup-1.md`, `ai/agent-ux-plans/` (12 files) → all now under
  `ai/archive/`.
- Created `ai/archive/README.md` (22 lines) — a one-line index over the entire archive directory
  (the 5 newly moved items plus the 10 items that were already there and had no index).
- `ai/PLAN.md`: replaced the three foreign-repo template references (`fbsource/...` + the VSCode
  Codex-extension research step, `arc lint`, `CodexAgent.ts` ×2) with SafeMolt equivalents (research
  `CLAUDE.md` + the touched domain modules; research prior `PLAN_M{n}.md`/`ai/validation`/`ai/decisions`
  precedent; `npx tsc --noEmit` + `npm run lint`; "SafeMolt's platform architecture"). Appended three
  new `## Backlog` subsections: M10's 5 deferred items, M11's 11 backlog additions (both transcribed
  verbatim from their source plans), and 5 still-open items pulled from the now-archived
  `cleanup-1.md`'s "Future considerations" (file splits, the Conversation primitive, `store-types.ts`
  split, `memory-service.ts` split/shrink, schema snapshot).
- `ai/PLAN_M10.md`: extended the front-matter supersession note with an **E5 → P7.4** entry (this
  lane, this session) and corrected the trailing "E/F/G after M11b" to "F/G (and E1–E4) after M11b"
  now that E5 itself has landed.
- Fixed two now-stale doc-path comments that pointed at the moved
  `ai/agent-ux-plans/02-home-identity-trust.md` (now `ai/archive/agent-ux-plans/...`):
  `src/app/api/v1/agents/me/home/route.ts` and `src/lib/agent-home/service.ts` (comment-only,
  1 line each).
- Reviewed `AGENT_EXPERIENCE_AUDIT.md`, `AGENT_EXPERIENCE_AUDIT_2026-05-14.md`, and
  `AGENT_UX_PRIMITIVES_PLAN.md` for still-actionable items beyond what M10/M11 already executed
  (playground join-lobby bug, prefab-id doc mismatch, loop cooldown bypass, command-center home,
  mentions/DMs/notifications/wakeups) — all found superseded by shipped M9–M11 work; no further
  backlog items extracted from those three beyond what `cleanup-1.md` already named.

### Boundary-allowlist shrink — verified, no changes needed

`scripts/gen-eslint-boundary.js`'s `INTERNAL_ALLOWLIST` and `OUT_OF_SCOPE_FAMILIES` already
transcribe `ai/validation/m11-inventory.md` §10a/§10b verbatim (a prior wave, u5 Lane A, did this
shrink already). Ran the generator directly; `git diff --stat .eslintrc.json` was empty afterward —
idempotent, confirming the checked-in generated block already matches. No allowlist entry needed
removal.

### P7.1 — not started, blocked; see handoff

`ai/m11-2-handoff/b1-fixes-landed.md` never appeared during this session. Per the concurrency rule,
the three gated files (`agent-loop.ts`, `agent-pulse/runner.ts`,
`agent-tools/definitions/*`) were not touched. Independently of the marker, every inline
side-effect call site in inventory §9a/§9b/§9c is still `shadow` or `legacy` in
`src/lib/events/consumers/coverage.ts` — none is `on` — so none of those writers may be deleted
either, per this lane's own instruction and the `CLAUDE.md` store invariant. Full detail, including
the per-kind coverage-state table and what to re-check first, is in
`ai/m11-2-handoff/b2-lane-c-handoff.md`.

## 2. Gate results

```
$ npm test -- src/__tests__/playground/d5-durable-memories.test.ts
PASS src/__tests__/playground/d5-durable-memories.test.ts
Test Suites: 1 passed, 1 total
Tests:       13 passed, 13 total

$ npm test -- src/__tests__/lib/boundary-manifest-completeness.test.ts src/__tests__/lib/boundary-generated-block.test.ts src/__tests__/lib/boundary-mixed-actor-route.test.ts src/__tests__/lib/boundary-ast-discipline.test.ts
PASS src/__tests__/lib/boundary-ast-discipline.test.ts
PASS src/__tests__/lib/boundary-manifest-completeness.test.ts
PASS src/__tests__/lib/boundary-mixed-actor-route.test.ts
PASS src/__tests__/lib/boundary-generated-block.test.ts
Test Suites: 4 passed, 4 total
Tests:       10 passed, 10 total

$ node scripts/gen-eslint-boundary.js && git diff --stat .eslintrc.json
gen-eslint-boundary: wrote the generated block into .eslintrc.json
(no output — file unchanged)
```

The DB-mode integration test for P7.2 (`src/__tests__/integration/d5-playground-memories.test.ts`)
was not re-run: this environment has no `POSTGRES_URL`/`DATABASE_URL` (`.env.local` absent), and no
code in its path was touched this session. `npm run lint`/`npx tsc --noEmit`/full `npm test` were
not run repo-wide per the hard rule (no full-suite runs while the b-1 fix loop is mid-edit) — this
lane's own edits are two Markdown files, one new Markdown file, and two one-line code comments, none
of which are lint- or type-checkable behavior changes.

## 3. Mutation-check evidence

No new behavioral code was written this session (P7.2/P7.3 were already implemented; P7.4 is docs
and file moves; the boundary check was read-only + a no-op regeneration). Nothing to mutation-test.

## 4. Shared-file edits

None of this session's edits touched a file on the shared-file collision list
(`src/lib/events/kinds.ts`, `coverage.ts`, `store-types.ts`, `notifications.ts`,
`wakeup-router.ts`, `store.ts`, `export-manifest.ts`, `migrate.js`, `migration-ledger.ts`,
`agent-tools/index.ts`, `actions/types.ts`). No new store exports were added.

## 5. Out-of-fence needs / cross-lane notes

- `src/lib/events/consumers/coverage.ts`, `src/lib/agent-pulse/runner.ts`, and several
  reaction/DM/webhook store files show as modified in `git status` — confirmed by inspection these
  are the concurrent b-1 fix loop's and lane S's edits, unrelated to this lane's kinds (post,
  comment, follow, group, playground, evaluation). Not touched.
- P7.1 is fully blocked; see handoff for what a follow-up run needs to check first (marker file,
  then the coverage-state table).

## 6. Docs delta (recorded only — public docs not touched, per fence)

**`public/reference.md`**, near the existing "Unsubscribe from a group" note (currently "Subscribing
is separate from joining..."): replace with —
> **Note:** `subscribe`/`unsubscribe` are the legacy feed-subscription surface, kept for existing
> integrations. Use `join_group`/`leave_group` (or `POST`/`DELETE /api/v1/groups/{name}/join`) for
> membership — subscribing without joining still shows a group's posts in your feed but does not
> make you a member.

**`public/planned.md`**: add —
> - **AT Protocol federation**: the `xrpc`/`.well-known` stub and `src/lib/atproto/*` are frozen (no
>   active development) pending the events-based future — the outbox-driven event log is the intended
>   foundation for a future PDS projection, not the current stub.

No change needed for `/playground/sessions/active` — `public/reference.md` line 80 already documents
its pinned `data: null` / status-vocabulary contract, and the filter-over-the-same-read change is an
internal implementation detail with no user-visible contract change.

## 7. Deviations

- P7.2's store files live at `src/lib/store/playground/agent-memories-{db,memory}.ts`, not the
  spec-suggested `src/lib/store/playground-memories/{db,memory,index}.ts` — a prior wave (M11-1b D5)
  built this before the current spec was drafted, using a different file layout inside the existing
  `playground` store domain. Functionality matches the plan's remedy exactly; not re-homed, since
  moving it would touch files this lane did not need to touch and would risk the concurrent b-1
  fix loop's edits to neighboring playground store files.
- P7.4 executed directly by the lane manager rather than via a spawned Haiku subagent: the work was
  5 `mv` commands, one new 22-line index file, and precise text edits to 2 planning documents whose
  content required judgment (which "still-relevant" items to fold in, how to phrase the SafeMolt
  tooling equivalents) — safer to make those calls directly than to hand a Haiku agent open-ended
  judgment calls over planning prose.
