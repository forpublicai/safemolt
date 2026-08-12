# Implementation task — u4prep2 fix round (findings [A]1, [A]3, [A]5)

Repo: /Users/mohsin/Github/safemolt. Uncommitted tree on `ops/code-improve` — do NOT commit, do NOT run any git write command. You are the implementation agent; a separate reviewer converges your work later.

The drain-time shadow comparison (legacy_match stamps) is implemented. The full findings text is in `ai/m11-2-handoff/codex-findings-u3d-u4prep2-round1.md` — read the [A] items first. Context that changed since that review: u3d's fix round spliced every playground transitional activity writer INTO its emitting statement (see the new builders in src/lib/store/activity/events.ts), so the legacy side now always stamps source_event_id atomically — which makes finding 1's watermark semantics clean to implement.

Binding invariants: agents.md (= CLAUDE.md) "Store and Migration Invariants" — read the whole section before editing any producer or consumer file.

## Finding 1 — BLOCKER: reused activity keys stamp routine supersession as legacy_missing
Playground lifecycle kinds share one natural key (`playground_session:{id}`); a later event's inline upsert replaces source_event_id, so earlier events' twin lookups miss and stamp verdict-bearing legacy_missing on healthy behavior. Same class as agent.followed / group_join reuse.
Fix: the activity twin reader distinguishes three cases: (a) row present with source_event_id = event.id ⇒ compare payloads as now; (b) row present with source_event_id > event.id ⇒ stamp `superseded` — NON-verdict-bearing, the durable evidence is the monotonic watermark itself, and this mirrors the report's accepted final-state semantics (DISTINCT ON latest-per-key); (c) row absent or source_event_id < event.id (an older watermark than the event being drained means the inline writer never landed) ⇒ legacy_missing, verdict-bearing. Add `superseded` to the stamp vocabulary end-to-end (migration NOT needed — the column is TEXT; update the report's aggregation + verdict rule + header, the verdict function, and inventory §8). Tests: a reused-key sequence (join then cancel, drain the join's event AFTER the cancel's inline write) stamps superseded, never legacy_missing; the watermark-older case stamps legacy_missing.

## Finding 3 — MAJOR: the describe→twin-read gap turns a correct concurrent deletion into legacy_missing
describe's subject lock ends with its query; a deletion can land before the twin lookup.
Fix: each twin lookup revalidates AND locks its subject in the same query that reads the legacy row (the u2 locked-target pattern: posts FOR SHARE for comment notifications; the followee's agent row FOR KEY SHARE for follows; the subject row for activity kinds per kind). When the locked subject is gone ⇒ stamp `unverifiable` (not legacy_missing). Tests: delete-the-subject-between-describe-and-lookup (barrier or direct-delete simulation) stamps unverifiable; the ordinary path still stamps matched.

## Finding 5 — MINOR: kind_map fans one activity legacy row out to six kinds
act_legacy_events never requires the joined event's kind to equal the mapped kind, so one missing shadow row increments six legacy_only summaries.
Fix: carry e.kind through and require it to equal kind_map.event_kind whenever the source event resolves. Test: one missing playground shadow row increments exactly its own kind's legacy_only.

## Method
Characterization first where behavior changes; mutation-check every behavioral fix: write the test, watch it FAIL against the unfixed code (revert fix → test fails → restore), then fix. Match surrounding code style. No bloat.

## Fences
Your surface: src/lib/events/consumers/legacy-compare.ts, the twin readers (consumers/{notifications,activity-trail}.ts + store/notifications/{db,memory,index}.ts + store/activity/{events,index}.ts — reader additions only, do NOT touch the new upsert builders' write logic), scripts/soak-shadow-report.sql, the u4prep + shadow-legacy-compare tests, ai/validation/m11-inventory.md §8. Do NOT edit: dispatch.ts's receipt/lease machinery (the stamp write itself lives there and may gain the new vocabulary constant only), playground store/session-manager files, ANY evaluations or agent-lifecycle file (actions/evaluations.ts, actions/agents.ts, store/evaluations/*, store/agents/*, the evaluation/vetting/claim/register routes and tools), karma anything.

## Gates
npx tsc --noEmit && npm run lint && npm test -- --runInBand && npm run test:integration -- --testPathPattern="m11-2-u4prep-soak-report|m11-2-u3d-playground|m11-2-u2-consumers|m11-2-u2-legacy-parity" && npm run build. The integration suite serializes on a Postgres advisory lock — another run may hold it; wait, do not kill. Piped shell commands report the pipe tail's exit code — read jest's own summary lines.

## Report
Per finding: what you changed (files), the mutation-check evidence, deviations from the prescribed fix with the reason. Then the gate results verbatim (suite counts).
