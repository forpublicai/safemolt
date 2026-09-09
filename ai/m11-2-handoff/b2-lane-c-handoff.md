# b2 Lane C — P7.1 handoff (marker still absent at session end)

> **Gen-2 update (2026-09-08):** the marker now exists. Gen-2 re-ran every check named below
> against the post-fix-loop tree and reconfirmed all of them — still zero safe deletions. See
> `ai/m11-2-handoff/b2-lane-c-report.md` §8 for the full re-verification and gate results. This
> file is kept as-is below for its historical detail.

`ai/m11-2-handoff/b1-fixes-landed.md` did not exist at any point in this session. Per the
concurrency rule in `ai/m11-2-handoff/b2-lane-c-cleanup-spec.md`, P7.1's deletions in
`src/lib/agent-loop.ts`, `src/lib/agent-pulse/runner.ts` and
`src/lib/agent-tools/definitions/*` were not attempted. P7.2, P7.4, P7.3 and the boundary-allowlist
check ran first and are reported done in `ai/m11-2-handoff/b2-lane-c-report.md`.

## What P7.1 still needs, precisely

### 1. Marker-gated (wait for `b1-fixes-landed.md`)

- `src/lib/agent-tools/definitions/*` — re-verify only. As of this session every mutate executor in
  all 10 files imports exclusively read-prefixed store exports from `@/lib/store`
  (`getAgentById`, `listComments`, `listFeed`, `getReactionCounts`, `listGroups`,
  `listModerators`, `getYourRole`, `listDmConversations`, `listDmMessages`, and the equivalents in
  `classes.ts`/`evaluations.ts`/`playground.ts`/`schools.ts`) — grep for
  `from ['"]@/lib/store['"]` in each file and confirm every imported name still starts with
  `get`/`list`/`is`/`has`. P1.5 already left these as adapters; there is nothing to delete unless
  the b-1 fix loop reintroduced a direct mutating import while patching `messages.ts`/`reactions.ts`
  — check those two specifically first, since they are the fix loop's active files.
- `src/lib/agent-pulse/runner.ts` and `src/lib/agent-loop.ts` — `listEligibleAgents` is called only
  from these two files (verified by repo-wide grep, no other caller). Before deleting any of its
  plumbing, confirm the `idle` wakeup path in `runner.ts` (which the module's own header comment
  says still dispatches to `tickAgent` in `agent-loop.ts` as the "loop-surface minimal resolver")
  still needs the un-claimed-agents scan, or whether it was fully replaced by the wakeup-queue path.
  Re-read both files' current headers first — the b-1 fix loop edits `runner.ts` directly, so the
  division of labor between the two files may have moved since this session's read.
- Loop-side gatherers duplicating `agent-senses` (P4.3): verified in this session that
  `buildAgentContext` is the ONLY context builder referenced anywhere outside `agent-senses/*`
  itself (checked `agents/me/context/route.ts`, `agent-home/service.ts`, `agent-loop.ts`,
  `agent-pulse/runner.ts`) — no duplicate gatherer exists today outside the two gated files. Nothing
  to delete unless one is found inside `agent-loop.ts` specifically once it is unlocked.

### 2. Blocked by coverage state, not by the marker (inventory §9a/§9b/§9c)

Checked every kind named in `ai/validation/m11-inventory.md` §9 against
`src/lib/events/consumers/coverage.ts` (current tree, 2026-09-08). **Every kind with a declared
legacy writer is `shadow` or `legacy` in every consumer that declares one — none is `on`.**

| Kind | notifications | activity-trail | memory-ingest |
|---|---|---|---|
| `post.created` | `none` (no writer) | `shadow` | `shadow` |
| `post.deleted` | `shadow` | `shadow` | `shadow` |
| `comment.created` | `shadow` | `shadow` | n/a (no writer) |
| `agent.followed` | `shadow` | `shadow` | n/a |
| `group.joined` | n/a | `shadow` | n/a |
| `playground.session_created`/`session_joined`/`participant_affiliation_updated`/`session_completed`/`session_cancelled`/`session_expired` | n/a | `shadow` | n/a |
| `playground.action_submitted` | n/a | `shadow` | `legacy` |
| `evaluation.completed` | n/a | `legacy` | n/a |
| `agent_loop.action` | n/a | `shadow` | n/a |

Per `CLAUDE.md`'s store invariant ("a kind still `legacy`/`shadow` in `coverage.ts` keeps its
inline writer") and this lane's own spec ("a `legacy`/`shadow` kind's writer STAYS"), **none of
§9a/§9b/§9c's inline writers may be deleted in this wave.** The flip to `on` is a production-soak
decision recorded in `coverage.ts`'s own comments (Protocol M), not a code-readiness question — the
code for the consumers already exists. This is not a marker-file gate; it is a rollout gate outside
this lane's authority. Re-run the same grep-against-`coverage.ts` check the next time this lane (or
its successor) runs P7.1 — if any of the rows above have flipped to `on`, that kind's declared
writers in `DECLARED_LEGACY_WRITERS` (same file) become deletable and the manifest's own count
pins how many invocations to remove per file.

### 3. Boundary allowlist shrink — already at the permanent set, verified, no action needed

`scripts/gen-eslint-boundary.js`'s `INTERNAL_ALLOWLIST` and `OUT_OF_SCOPE_FAMILIES` already match
`ai/validation/m11-inventory.md` §10a/§10b verbatim (confirmed by inspection; the file's own
comments call both lists "verbatim"). Ran `node scripts/gen-eslint-boundary.js` directly — `git
diff --stat .eslintrc.json` was empty, i.e. idempotent, confirming the checked-in generated block
already matches the manifest and the permanent lists. All four boundary test suites are green (see
`b2-lane-c-report.md`). This step of P7.1 needs no further work unless a future domain migration
adds a NEW route to the transitional set that then needs removing.

## Net effect

P7.1 has zero safe deletions to perform right now: the three gated files are still off-limits, and
every other candidate site is pinned at `shadow`/`legacy` by design. The next lane to pick this up
should (a) check for the marker first, and (b) re-run the coverage-state table above before
assuming anything changed.
